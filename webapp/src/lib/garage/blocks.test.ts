import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarageClient } from './client';
import { GarageValidationError } from './errors';
import { listBlockErrors, retryBlockResync } from './blocks';
import { RetryBlockResyncRequestSchema } from './schemas';

/**
 * The two `Block`-tagged calls, and the three things about them that are easy
 * to get wrong: `ListBlockErrors` is a **GET with no body**, `RetryBlockResync`
 * sends an **untagged one-of** where exactly one key may be present, and both
 * take a full node id rather than the key the browser holds.
 */

const client = new GarageClient({
  baseUrl: 'http://garage.test',
  token: 'test-token',
});

const FULL_A = 'aaaa000000000001' + '0123456789abcdef'.repeat(3);

function capture(body: unknown, status = 200) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);
  return calls;
}

const blockError = (over: Record<string, unknown> = {}) => ({
  blockHash: 'ff'.repeat(32),
  refcount: 2,
  errorCount: 5,
  lastTrySecsAgo: 90,
  nextTryInSecs: 30,
  ...over,
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('listBlockErrors', () => {
  it('targets every node by default, with no request body', () => {
    const calls = capture({ success: { nodeA: [] }, error: {} });
    return listBlockErrors(client).then(() => {
      expect(calls[0].url).toBe('http://garage.test/v2/ListBlockErrors?node=*');
      expect(calls[0].method).toBe('GET');
      expect(calls[0].body).toBeUndefined();
    });
  });

  it('flattens both maps, and a node in both resolves to failure', async () => {
    capture({
      success: { nodeA: [blockError()], nodeB: [] },
      error: { nodeB: 'unreachable' },
    });

    const outcomes = await listBlockErrors(client);

    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.nodeId === 'nodeA')?.ok).toBe(true);
    // "It partly worked" is not a success — see `toNodeOutcomes`.
    expect(outcomes.find((o) => o.nodeId === 'nodeB')?.ok).toBe(false);
  });

  it('parses every field of a block error', async () => {
    capture({ success: { nodeA: [blockError()] }, error: {} });
    const [outcome] = await listBlockErrors(client);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value[0]).toEqual({
        blockHash: 'ff'.repeat(32),
        refcount: 2,
        errorCount: 5,
        lastTrySecsAgo: 90,
        nextTryInSecs: 30,
      });
    }
  });

  // The whole argument for making all five required: a missing count must be a
  // validation error, never a zero, because a zero here reads "this is fine".
  it.each([
    'blockHash',
    'refcount',
    'errorCount',
    'lastTrySecsAgo',
    'nextTryInSecs',
  ])('rejects a payload missing %s', async (field) => {
    const partial = blockError();
    delete (partial as Record<string, unknown>)[field];
    capture({ success: { nodeA: [partial] }, error: {} });
    await expect(listBlockErrors(client)).rejects.toBeInstanceOf(
      GarageValidationError
    );
  });

  it('can target a single node', async () => {
    const calls = capture({ success: {}, error: {} });
    await listBlockErrors(client, { node: FULL_A });
    expect(calls[0].url).toBe(
      `http://garage.test/v2/ListBlockErrors?node=${FULL_A}`
    );
  });
});

describe('retryBlockResync', () => {
  it('POSTs the full node id with a body of exactly {"all":true}', async () => {
    const calls = capture({ success: { [FULL_A]: { count: 12 } }, error: {} });

    const outcome = await retryBlockResync(client, {
      nodeId: FULL_A,
      request: { all: true },
    });

    expect(calls[0].url).toBe(
      `http://garage.test/v2/RetryBlockResync?node=${FULL_A}`
    );
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({ all: true });
    // `oneOf` means exactly one arm: the other key must not be along for the ride.
    expect(calls[0].body).not.toHaveProperty('blockHashes');
    expect(outcome?.ok).toBe(true);
    if (outcome?.ok) expect(outcome.value.count).toBe(12);
  });

  it('serialises the blockHashes arm alone', async () => {
    const calls = capture({ success: { [FULL_A]: { count: 1 } }, error: {} });
    await retryBlockResync(client, {
      nodeId: FULL_A,
      request: { blockHashes: ['ab'.repeat(32)] },
    });
    expect(calls[0].body).toEqual({ blockHashes: ['ab'.repeat(32)] });
    expect(calls[0].body).not.toHaveProperty('all');
  });

  it.each(['*', 'self', '', '   '])(
    'refuses %j as a target',
    async (nodeId) => {
      const calls = capture({ success: {}, error: {} });
      await expect(
        retryBlockResync(client, { nodeId, request: { all: true } })
      ).rejects.toBeInstanceOf(GarageValidationError);
      // Refused before the wire, not after.
      expect(calls).toHaveLength(0);
    }
  );

  it('carries a per-node failure as a failed outcome', async () => {
    capture({ success: {}, error: { [FULL_A]: 'no such block store' } });
    const outcome = await retryBlockResync(client, {
      nodeId: FULL_A,
      request: { all: true },
    });
    expect(outcome?.ok).toBe(false);
  });

  it('returns null when the envelope names nobody', async () => {
    // A 200 that means nothing happened — the third case callers must treat as
    // failure. See `outcomeForNode`.
    capture({ success: {}, error: {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const outcome = await retryBlockResync(client, {
      nodeId: FULL_A,
      request: { all: true },
    });
    expect(outcome).toBeNull();
  });
});

describe('RetryBlockResyncRequestSchema', () => {
  it('accepts either arm and rejects an object carrying both keys', () => {
    expect(RetryBlockResyncRequestSchema.safeParse({ all: true }).success).toBe(
      true
    );
    expect(
      RetryBlockResyncRequestSchema.safeParse({ blockHashes: ['ab'] }).success
    ).toBe(true);
    // `oneOf` means exactly one. `strictObject` is what makes the both-keys
    // case a rejection here rather than a body Garage has to interpret.
    expect(
      RetryBlockResyncRequestSchema.safeParse({
        all: true,
        blockHashes: ['ab'],
      }).success
    ).toBe(false);
    expect(
      RetryBlockResyncRequestSchema.safeParse({ blockHashes: [] }).success
    ).toBe(false);
  });
});
