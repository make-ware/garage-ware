import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { GarageClient } from './client';
import {
  GarageAuthError,
  GarageConfigError,
  GarageError,
  GarageNotFoundError,
  GarageQuorumError,
  GarageValidationError,
} from './errors';

const ResponseSchema = z.object({ status: z.string() });

function mockFetch(impl: typeof fetch) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(impl);
}

function fetchResponding(
  status: number,
  body: unknown,
  init?: { textOverride?: string }
): typeof fetch {
  return async () =>
    new Response(init?.textOverride ?? JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
}

describe('GarageClient', () => {
  const client = new GarageClient({
    baseUrl: 'http://garage.test',
    token: 'test-token',
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('attaches bearer token and parses JSON response with zod', async () => {
    let received: { url: string; init: RequestInit | undefined } | undefined;
    mockFetch(async (input, init) => {
      received = {
        url: typeof input === 'string' ? input : input.toString(),
        init,
      };
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });

    const result = await client.request('/v2/Test', ResponseSchema);
    expect(result).toEqual({ status: 'ok' });
    expect(received?.url).toBe('http://garage.test/v2/Test');
    expect(
      (received?.init?.headers as Record<string, string>).Authorization
    ).toBe('Bearer test-token');
  });

  it('throws GarageNotFoundError on 404', async () => {
    mockFetch(fetchResponding(404, { message: 'gone' }));
    await expect(
      client.request('/v2/Missing', ResponseSchema)
    ).rejects.toBeInstanceOf(GarageNotFoundError);
  });

  it('throws GarageAuthError on 401', async () => {
    mockFetch(fetchResponding(401, { message: 'no' }));
    await expect(
      client.request('/v2/Auth', ResponseSchema)
    ).rejects.toBeInstanceOf(GarageAuthError);
  });

  it('throws GarageQuorumError on 503', async () => {
    mockFetch(fetchResponding(503, { message: 'down' }));
    await expect(
      client.request('/v2/Status', ResponseSchema)
    ).rejects.toBeInstanceOf(GarageQuorumError);
  });

  it('throws generic GarageError on 500', async () => {
    mockFetch(fetchResponding(500, { message: 'boom' }));
    const promise = client.request('/v2/Boom', ResponseSchema);
    await expect(promise).rejects.toBeInstanceOf(GarageError);
    await expect(promise).rejects.toMatchObject({ status: 500 });
  });

  it('throws GarageValidationError on schema mismatch', async () => {
    mockFetch(fetchResponding(200, { unexpected: true }));
    await expect(
      client.request('/v2/Test', ResponseSchema)
    ).rejects.toBeInstanceOf(GarageValidationError);
  });

  it('serializes query parameters', async () => {
    let url = '';
    mockFetch(async (input) => {
      url = typeof input === 'string' ? input : input.toString();
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });
    await client.request('/v2/Test', ResponseSchema, {
      query: { id: 'abc', flag: true, missing: undefined },
    });
    expect(url).toContain('id=abc');
    expect(url).toContain('flag=true');
    expect(url).not.toContain('missing');
  });

  it('serializes JSON body for POST', async () => {
    let init: RequestInit | undefined;
    mockFetch(async (_input, requestInit) => {
      init = requestInit;
      return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
    });
    await client.request('/v2/CreateThing', ResponseSchema, {
      method: 'POST',
      body: { name: 'foo' },
    });
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ name: 'foo' }));
  });

  it('fromEnv throws when env vars missing', () => {
    const oldUrl = process.env.GARAGE_ADMIN_URL;
    const oldTok = process.env.GARAGE_ADMIN_TOKEN;
    delete process.env.GARAGE_ADMIN_URL;
    delete process.env.GARAGE_ADMIN_TOKEN;
    try {
      expect(() => GarageClient.fromEnv()).toThrow();
    } finally {
      if (oldUrl !== undefined) process.env.GARAGE_ADMIN_URL = oldUrl;
      if (oldTok !== undefined) process.env.GARAGE_ADMIN_TOKEN = oldTok;
    }
  });

  it('classifies a refused connection rather than surfacing "fetch failed"', async () => {
    const cause = Object.assign(new Error('ECONNREFUSED'), {
      code: 'ECONNREFUSED',
    });
    mockFetch(async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause });
    });
    const promise = client.request('/v2/GetClusterHealth', ResponseSchema);
    await expect(promise).rejects.toBeInstanceOf(GarageError);
    // status stays 0 (nothing answered); `code` is what tells the reasons apart.
    await expect(promise).rejects.toMatchObject({
      status: 0,
      code: 'unreachable',
    });
    // The original cause must survive for logging/diagnostics.
    await expect(promise).rejects.toHaveProperty('cause');
  });

  it('classifies a DNS failure distinctly from a refused port', async () => {
    mockFetch(async () => {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }),
      });
    });
    await expect(
      client.request('/v2/GetClusterHealth', ResponseSchema)
    ).rejects.toMatchObject({ code: 'dns' });
  });

  describe('fromEnv', () => {
    const saved = {
      url: process.env.GARAGE_ADMIN_URL,
      token: process.env.GARAGE_ADMIN_TOKEN,
    };

    afterEach(() => {
      if (saved.url === undefined) delete process.env.GARAGE_ADMIN_URL;
      else process.env.GARAGE_ADMIN_URL = saved.url;
      if (saved.token === undefined) delete process.env.GARAGE_ADMIN_TOKEN;
      else process.env.GARAGE_ADMIN_TOKEN = saved.token;
    });

    it('throws a typed config error naming every missing var', () => {
      delete process.env.GARAGE_ADMIN_URL;
      delete process.env.GARAGE_ADMIN_TOKEN;
      try {
        GarageClient.fromEnv();
        expect.unreachable('fromEnv should throw when unconfigured');
      } catch (err) {
        expect(err).toBeInstanceOf(GarageConfigError);
        expect((err as GarageConfigError).missing).toEqual([
          'GARAGE_ADMIN_URL',
          'GARAGE_ADMIN_TOKEN',
        ]);
      }
    });

    it('reports only the var that is actually missing', () => {
      process.env.GARAGE_ADMIN_URL = 'http://garage.test';
      delete process.env.GARAGE_ADMIN_TOKEN;
      expect(GarageClient.missingEnv()).toEqual(['GARAGE_ADMIN_TOKEN']);
    });

    it('builds a client when both are set', () => {
      process.env.GARAGE_ADMIN_URL = 'http://garage.test';
      process.env.GARAGE_ADMIN_TOKEN = 'tok';
      expect(GarageClient.fromEnv()).toBeInstanceOf(GarageClient);
    });
  });
});
