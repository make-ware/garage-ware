import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarageClient } from './client';
import { getKeyInfo, verifyKeySecret } from './keys';
import { GarageKeySchema } from './schemas';

/**
 * The key secret is a credential now, so two properties are asserted here:
 * that `verifyKeySecret` answers correctly and identically for the two failures
 * that must be indistinguishable, and that no ordinary read path can carry a
 * secret at all.
 */

const AKID = 'GK31c5b1f2a9d4e7c0';
const SECRET = 'b7f4c1e9a2d8036f5b1c4e7a9d2f6083b5c1e4a7d9f2063b';

function client() {
  return new GarageClient({ baseUrl: 'http://garage.test', token: 't' });
}

function respondWith(status: number, body: unknown) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  );
}

afterEach(() => vi.restoreAllMocks());

describe('verifyKeySecret', () => {
  it('accepts the real secret', async () => {
    respondWith(200, { accessKeyId: AKID, secretAccessKey: SECRET });
    await expect(verifyKeySecret(client(), AKID, SECRET)).resolves.toBe(true);
  });

  it('rejects a wrong secret', async () => {
    respondWith(200, { accessKeyId: AKID, secretAccessKey: SECRET });
    await expect(
      verifyKeySecret(client(), AKID, SECRET.replace('b7', 'b8'))
    ).resolves.toBe(false);
  });

  it('rejects a secret of a different length without throwing', async () => {
    // timingSafeEqual throws on unequal lengths; tokenMatches absorbs that.
    respondWith(200, { accessKeyId: AKID, secretAccessKey: SECRET });
    await expect(verifyKeySecret(client(), AKID, 'short')).resolves.toBe(false);
    await expect(
      verifyKeySecret(client(), AKID, SECRET + 'extra')
    ).resolves.toBe(false);
  });

  it('answers FALSE for a key that does not exist — never throws', async () => {
    // This is what lets the claim route give one indistinguishable answer for
    // "no such key" and "wrong secret", instead of being an access-key-id
    // oracle. A 404 that propagated would be a different status to the caller.
    respondWith(404, { message: 'no such key' });
    await expect(verifyKeySecret(client(), AKID, SECRET)).resolves.toBe(false);
  });

  it('rejects when Garage returns no secret at all', async () => {
    respondWith(200, { accessKeyId: AKID, secretAccessKey: null });
    await expect(verifyKeySecret(client(), AKID, SECRET)).resolves.toBe(false);
  });

  it('never puts the secret in the error it throws on a bad payload', async () => {
    // client.request attaches the raw body to GarageValidationError, and this
    // is the one request whose body holds a live secret.
    respondWith(200, { secretAccessKey: SECRET });
    const err = await verifyKeySecret(client(), AKID, SECRET).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(JSON.stringify(err, Object.getOwnPropertyNames(err))).not.toContain(
      SECRET
    );
  });

  it('asks Garage for the secret — the request that earns all of the above', async () => {
    const spy = respondWith(200, {
      accessKeyId: AKID,
      secretAccessKey: SECRET,
    });
    await verifyKeySecret(client(), AKID, SECRET);
    expect(String(spy.mock.calls[0][0])).toContain('showSecretKey=true');
  });
});

describe('getKeyInfo', () => {
  it('does NOT ask for the secret', async () => {
    const spy = respondWith(200, { accessKeyId: AKID });
    await getKeyInfo(client(), AKID);
    expect(String(spy.mock.calls[0][0])).not.toContain('showSecretKey');
  });

  it('strips a secret even if Garage sends one anyway', async () => {
    // The schema is the backstop: GET /keys/[id] returns this object verbatim.
    respondWith(200, { accessKeyId: AKID, secretAccessKey: SECRET });
    const info = await getKeyInfo(client(), AKID);
    expect(JSON.stringify(info)).not.toContain(SECRET);
    expect(info).not.toHaveProperty('secretAccessKey');
  });

  it('has no secret field in the shared schema', () => {
    // The type-level half of the same rule: nothing that parses through
    // GarageKeySchema can carry a secret into a response.
    expect(Object.keys(GarageKeySchema.shape)).not.toContain('secretAccessKey');
  });
});
