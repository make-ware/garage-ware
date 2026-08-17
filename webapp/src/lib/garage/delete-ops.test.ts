import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarageClient } from './client';
import { deleteBucket } from './buckets';
import { deleteKey, updateKey } from './keys';
import { GarageError, GarageNotEmptyError } from './errors';

/**
 * The deletes had no tests at all, in either direction: `yarn test` was fully
 * green while both functions threw unconditionally, and would have stayed green
 * if the `id`-in-body defect had shipped. That defect is the first thing
 * asserted here, because it fails silently — Garage would receive a delete with
 * no id rather than an error anyone would notice.
 */

const BUCKET = 'b1f4c1e9a2d8036f';
const KEY = 'GK31c5b1f2a9d4e7c0';

function client() {
  return new GarageClient({ baseUrl: 'http://garage.test', token: 't' });
}

/** Capture the request, answer with `status`/`body`. */
function capture(status = 200, body: unknown = {}) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return calls;
}

afterEach(() => vi.restoreAllMocks());

describe('id goes in the query string, never the body', () => {
  it('deleteBucket', async () => {
    const calls = capture();
    await deleteBucket(client(), BUCKET);
    expect(calls[0].url).toBe(
      `http://garage.test/v2/DeleteBucket?id=${BUCKET}`
    );
    // The defect that was sitting here commented out: an id in the body never
    // reaches buildUrl, so Garage would have got a delete naming nothing.
    expect(String(calls[0].init?.body ?? '')).not.toContain(BUCKET);
  });

  it('deleteKey', async () => {
    const calls = capture();
    await deleteKey(client(), KEY);
    expect(calls[0].url).toBe(`http://garage.test/v2/DeleteKey?id=${KEY}`);
    expect(String(calls[0].init?.body ?? '')).not.toContain(KEY);
  });

  it('updateKey — the same bug, and now load-bearing for expiry', async () => {
    const calls = capture(200, { accessKeyId: KEY, name: 'x' });
    await updateKey(client(), { id: KEY, expiration: '2026-01-01T00:00:00Z' });
    expect(calls[0].url).toBe(`http://garage.test/v2/UpdateKey?id=${KEY}`);
    const body = JSON.parse(String(calls[0].init?.body));
    expect(body).not.toHaveProperty('id');
    expect(body.expiration).toBe('2026-01-01T00:00:00Z');
  });

  it('updateKey sends neverExpires when un-expiring', async () => {
    const calls = capture(200, { accessKeyId: KEY, name: 'x' });
    await updateKey(client(), { id: KEY, neverExpires: true });
    expect(JSON.parse(String(calls[0].init?.body)).neverExpires).toBe(true);
  });
});

describe('a delete that finds nothing has succeeded', () => {
  it('deleteBucket resolves on 404', async () => {
    capture(404, { message: 'Bucket not found' });
    await expect(deleteBucket(client(), BUCKET)).resolves.toBeUndefined();
  });

  it('deleteKey resolves on 404', async () => {
    capture(404, { message: 'no such key' });
    await expect(deleteKey(client(), KEY)).resolves.toBeUndefined();
  });

  it('still throws on anything else', async () => {
    // Only "it is already gone" is success. A 500 must not be mistaken for one,
    // or the PocketBase row is dropped while the Garage object survives.
    capture(500, { message: 'internal' });
    await expect(deleteBucket(client(), BUCKET)).rejects.toBeInstanceOf(
      GarageError
    );
  });
});

describe('a non-empty bucket is a typed refusal', () => {
  it('DeleteBucket 400 becomes GarageNotEmptyError with code not_empty', async () => {
    capture(400, { message: 'Bucket is not empty' });
    const err = await deleteBucket(client(), BUCKET).catch((e) => e);
    expect(err).toBeInstanceOf(GarageNotEmptyError);
    expect(err.code).toBe('not_empty');
    expect(err.status).toBe(409);
  });

  it('a 400 from anywhere else stays generic', async () => {
    // The mapping is keyed on the endpoint precisely so it cannot swallow an
    // unrelated bad request and report it as "not empty".
    capture(400, { message: 'something else' });
    const err = await updateKey(client(), { id: KEY }).catch((e) => e);
    expect(err).not.toBeInstanceOf(GarageNotEmptyError);
    expect(err.code).toBe('http');
  });
});
