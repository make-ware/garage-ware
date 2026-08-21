import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { NODE_STATS_POLL_MS, useNodeStatsPoll } from './use-node-stats-poll';

/**
 * The app's first browser timer, and therefore the test that matters most in
 * this change. Every assertion here corresponds to one of the four conditions
 * the hook's docblock claims: only while something is moving, only while the
 * tab is visible, one request in flight at a time, and stop after three
 * failures.
 */

const api = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('@/lib/api-client', () => ({ api: api.call }));

const KEY_A = 'aaaa000000000001';

const response = (queue: number) => ({
  items: [
    {
      nodeId: KEY_A,
      error: null,
      resyncQueueLen: queue,
      resyncErrors: 0,
      rcEntries: 10,
    },
  ],
  fetchedAt: '2026-08-20T12:00:00.000Z',
});

/** Flush the promise chain a settled fetch leaves behind. */
async function settle() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Advance fake time and let whatever it triggered settle. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  api.call.mockReset();
  api.call.mockResolvedValue(response(0));
  Object.defineProperty(document, 'hidden', {
    configurable: true,
    get: () => false,
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNodeStatsPoll', () => {
  it('reads once on mount and then stops when nothing is moving', async () => {
    const { unmount } = renderHook(() =>
      useNodeStatsPoll({ busyWorkers: false })
    );
    await settle();
    expect(api.call).toHaveBeenCalledTimes(1);

    await advance(NODE_STATS_POLL_MS * 3);
    // One read when the page opened is not a timer. Nothing further.
    expect(api.call).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('keeps polling while a worker is busy', async () => {
    renderHook(() => useNodeStatsPoll({ busyWorkers: true }));
    await settle();
    expect(api.call).toHaveBeenCalledTimes(1);

    for (let i = 2; i <= 4; i += 1) {
      await advance(NODE_STATS_POLL_MS);
      expect(api.call).toHaveBeenCalledTimes(i);
    }
  });

  it('keeps polling while a resync queue is non-empty, and stops when it drains', async () => {
    // The self-limiting half of the trigger, and the reason the hook computes
    // it rather than taking it as a prop.
    api.call.mockResolvedValue(response(500));
    renderHook(() => useNodeStatsPoll({ busyWorkers: false }));
    await settle();

    await advance(NODE_STATS_POLL_MS);
    expect(api.call).toHaveBeenCalledTimes(2);

    api.call.mockResolvedValue(response(0));
    await advance(NODE_STATS_POLL_MS);
    expect(api.call).toHaveBeenCalledTimes(3);

    // Queue drained: the chain must not re-arm.
    await advance(NODE_STATS_POLL_MS * 3);
    expect(api.call).toHaveBeenCalledTimes(3);
  });

  it('issues no request after unmount', async () => {
    const { unmount } = renderHook(() =>
      useNodeStatsPoll({ busyWorkers: true })
    );
    await settle();
    const before = api.call.mock.calls.length;

    unmount();
    await advance(60_000);
    expect(api.call).toHaveBeenCalledTimes(before);
  });

  it('stops while the tab is hidden and reads once on the way back', async () => {
    const { rerender } = renderHook(() =>
      useNodeStatsPoll({ busyWorkers: true })
    );
    await settle();
    expect(api.call).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => true,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await advance(NODE_STATS_POLL_MS * 3);
    // The overnight-tab case: nothing at all while hidden.
    expect(api.call).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: () => false,
    });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    // Immediately, not after a full interval: what is on screen is as old as
    // the tab has been hidden.
    expect(api.call).toHaveBeenCalledTimes(2);

    rerender();
    await advance(NODE_STATS_POLL_MS);
    expect(api.call).toHaveBeenCalledTimes(3);
  });

  it('gives up after three consecutive failures', async () => {
    api.call.mockRejectedValue(new Error('cluster down'));
    const { result } = renderHook(() =>
      useNodeStatsPoll({ busyWorkers: true })
    );
    await settle();
    await advance(NODE_STATS_POLL_MS);
    await advance(NODE_STATS_POLL_MS);

    expect(api.call).toHaveBeenCalledTimes(3);
    expect(result.current.stoppedReason).toBe('errors');
    expect(result.current.polling).toBe(false);

    // Hammering a broken cluster for hours while showing a stale number is
    // worse than saying you stopped.
    await advance(NODE_STATS_POLL_MS * 5);
    expect(api.call).toHaveBeenCalledTimes(3);
  });

  it('recovers its failure count on a successful read', async () => {
    api.call
      .mockRejectedValueOnce(new Error('blip'))
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue(response(1));

    const { result } = renderHook(() =>
      useNodeStatsPoll({ busyWorkers: true })
    );
    await settle();
    await advance(NODE_STATS_POLL_MS);
    await advance(NODE_STATS_POLL_MS);

    expect(result.current.stoppedReason).toBeNull();
    await advance(NODE_STATS_POLL_MS * 3);
    expect(api.call.mock.calls.length).toBeGreaterThan(3);
  });

  it('never has two requests in flight, however slow the cluster is', async () => {
    // The whole reason this is a re-arming setTimeout chain rather than a
    // setInterval: a 25-second fan-out under a 10-second interval would stack.
    let inFlight = 0;
    let maxInFlight = 0;
    api.call.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 25_000));
      inFlight -= 1;
      return response(1);
    });

    renderHook(() => useNodeStatsPoll({ busyWorkers: true }));
    await advance(60_000);

    expect(maxInFlight).toBe(1);
  });
});
