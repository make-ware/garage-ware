import { afterEach, describe, expect, it, vi } from 'vitest';
import { GarageClient } from './client';
import { GarageValidationError } from './errors';
import { launchRepair, listWorkers } from './repair';

const client = new GarageClient({
  baseUrl: 'http://garage.test',
  token: 'test-token',
});

/** Captures the URL and body of the single request the call under test makes. */
function capture(body: unknown) {
  const calls: { url: string; body: unknown }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((async (
    input: RequestInfo | URL,
    init?: RequestInit
  ) => {
    calls.push({
      url: String(input),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
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

describe('listWorkers', () => {
  it('targets every node by default and flattens the envelope', async () => {
    const calls = capture({
      success: {
        nodeA: [
          {
            id: 1,
            name: 'block scrub worker',
            state: 'idle',
            errors: 0,
            consecutiveErrors: 0,
            freeform: ['Last scrub completed at 2026-08-09T03:14:00Z'],
          },
        ],
      },
      error: { nodeB: 'unreachable' },
    });

    const outcomes = await listWorkers(client);

    expect(calls[0].url).toBe('http://garage.test/v2/ListWorkers?node=*');
    expect(calls[0].body).toEqual({});
    expect(outcomes).toHaveLength(2);
    const a = outcomes.find((o) => o.nodeId === 'nodeA');
    expect(a?.ok).toBe(true);
    expect(outcomes.find((o) => o.nodeId === 'nodeB')?.ok).toBe(false);
  });

  it('parses the throttled arm of the untagged state union', async () => {
    capture({
      success: {
        nodeA: [
          {
            id: 1,
            name: 'scrub',
            state: { throttled: { durationSecs: 2.5 } },
            errors: 0,
            consecutiveErrors: 0,
            freeform: [],
          },
        ],
      },
      error: {},
    });
    const outcomes = await listWorkers(client);
    const first = outcomes[0];
    expect(first.ok).toBe(true);
    if (first.ok)
      expect(first.value[0].state).toEqual({
        throttled: { durationSecs: 2.5 },
      });
  });

  it('can target a single node', async () => {
    const calls = capture({ success: {}, error: {} });
    await listWorkers(client, { node: 'abc123' });
    expect(calls[0].url).toBe('http://garage.test/v2/ListWorkers?node=abc123');
  });
});

describe('launchRepair', () => {
  // The untagged RepairType union is the likeliest thing to get wrong: a scrub
  // is an object, every other repair is a bare string.
  it('sends a scrub command as an object', async () => {
    const calls = capture({ success: { abc123: null }, error: {} });
    const outcome = await launchRepair(client, {
      nodeId: 'abc123',
      action: 'scrub-start',
    });

    expect(calls[0].url).toBe(
      'http://garage.test/v2/LaunchRepairOperation?node=abc123'
    );
    expect(calls[0].body).toEqual({ repairType: { scrub: 'start' } });
    expect(outcome?.ok).toBe(true);
  });

  it('sends each scrub command verbatim', async () => {
    for (const [action, cmd] of [
      ['scrub-pause', 'pause'],
      ['scrub-resume', 'resume'],
      ['scrub-cancel', 'cancel'],
    ] as const) {
      const calls = capture({ success: { n1: null }, error: {} });
      await launchRepair(client, { nodeId: 'n1', action });
      expect(calls[0].body).toEqual({ repairType: { scrub: cmd } });
      vi.restoreAllMocks();
    }
  });

  it('sends a block repair as a bare string', async () => {
    const calls = capture({ success: { n1: null }, error: {} });
    await launchRepair(client, { nodeId: 'n1', action: 'blocks' });
    expect(calls[0].body).toEqual({ repairType: 'blocks' });
  });

  it('sends a rebalance as a bare string', async () => {
    const calls = capture({ success: { n1: null }, error: {} });
    await launchRepair(client, { nodeId: 'n1', action: 'rebalance' });
    expect(calls[0].body).toEqual({ repairType: 'rebalance' });
  });

  it('surfaces a per-node failure as ok:false rather than a clean success', async () => {
    capture({ success: {}, error: { n1: 'node is down' } });
    const outcome = await launchRepair(client, {
      nodeId: 'n1',
      action: 'blocks',
    });
    expect(outcome).toEqual({ nodeId: 'n1', ok: false, error: 'node is down' });
  });

  // A 200 that named nobody. Must be null, not a success.
  it('returns null when the envelope mentions the node in neither map', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    capture({ success: {}, error: {} });
    const outcome = await launchRepair(client, {
      nodeId: 'n1',
      action: 'blocks',
    });
    expect(outcome).toBeNull();
  });

  // The most damaging mistake available here, guarded before any network call.
  it.each(['*', 'self', '', '  '])(
    'refuses to launch against %p without calling Garage',
    async (nodeId) => {
      const spy = vi.spyOn(globalThis, 'fetch');
      await expect(
        launchRepair(client, { nodeId, action: 'scrub-start' })
      ).rejects.toBeInstanceOf(GarageValidationError);
      expect(spy).not.toHaveBeenCalled();
    }
  );
});
