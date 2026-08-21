import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarageClient } from './client';
import { GarageValidationError } from './errors';
import { getNodeStatistics } from './cluster';

/**
 * `GetNodeStatistics` — and specifically the one property everything
 * downstream rests on: **`blockManagerStats: null` stays null**. A `?? 0`
 * anywhere on this path turns "the node reported nothing" into "the queue is
 * empty", which are opposite conclusions, and this file is where that would
 * fail.
 */

const client = new GarageClient({
  baseUrl: 'http://garage.test',
  token: 'test-token',
});

function capture(body: unknown) {
  const calls: { url: string; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch);
  return calls;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('getNodeStatistics', () => {
  it('targets every node by default', async () => {
    const calls = capture({ success: {}, error: {} });
    await getNodeStatistics(client);
    expect(calls[0].url).toBe('http://garage.test/v2/GetNodeStatistics?node=*');
    expect(calls[0].method).toBe('GET');
  });

  it('parses the block manager counters', async () => {
    capture({
      success: {
        nodeA: {
          freeform: 'Garage version: v2.3.0',
          blockManagerStats: {
            rcEntries: 900,
            resyncQueueLen: 26_541,
            resyncErrors: 3,
          },
          tableStats: [
            {
              tableName: 'block_ref',
              items: 10,
              merkleItems: 10,
              merkleQueueLen: 0,
              insertQueueLen: 0,
              gcQueueLen: 0,
            },
          ],
        },
      },
      error: {},
    });

    const [outcome] = await getNodeStatistics(client);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value.blockManagerStats?.resyncQueueLen).toBe(26_541);
      expect(outcome.value.tableStats).toHaveLength(1);
    }
  });

  it('keeps a null blockManagerStats null', async () => {
    capture({
      success: {
        nodeA: { freeform: 'x', blockManagerStats: null, tableStats: null },
      },
      error: {},
    });

    const [outcome] = await getNodeStatistics(client);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // If someone ever "tidies" this to `?? 0`, this is the line that fails.
      expect(outcome.value.blockManagerStats).toBeNull();
      expect(outcome.value.tableStats).toBeNull();
    }
  });

  it('rejects a response with no freeform', async () => {
    // Required in the spec. We never parse it, but a build that stopped sending
    // it is a wire-level change we want to hear about.
    capture({ success: { nodeA: { blockManagerStats: null } }, error: {} });
    await expect(getNodeStatistics(client)).rejects.toBeInstanceOf(
      GarageValidationError
    );
  });

  it('carries a per-node error as a failed outcome', async () => {
    capture({ success: {}, error: { nodeB: 'timeout' } });
    const [outcome] = await getNodeStatistics(client);
    expect(outcome.ok).toBe(false);
  });
});
