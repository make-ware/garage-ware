import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  multiResponseSchema,
  outcomeForNode,
  toNodeOutcomes,
} from './multi-node';

const schema = multiResponseSchema(z.array(z.string()));

describe('multiResponseSchema', () => {
  it('parses a well-formed envelope', () => {
    const parsed = schema.parse({
      success: { nodeA: ['x'] },
      error: { nodeB: 'unreachable' },
    });
    expect(parsed.success.nodeA).toEqual(['x']);
    expect(parsed.error.nodeB).toBe('unreachable');
  });

  it('accepts both maps empty — the shape is valid even when it says nothing', () => {
    expect(() => schema.parse({ success: {}, error: {} })).not.toThrow();
  });

  // The load-bearing one. A Garage build that stopped emitting `error` must be
  // a validation failure, not a cluster-wide all-clear.
  it('rejects a body missing the error map', () => {
    expect(() => schema.parse({ success: { nodeA: ['x'] } })).toThrow();
  });

  it('rejects a body missing the success map', () => {
    expect(() => schema.parse({ error: {} })).toThrow();
  });
});

describe('toNodeOutcomes', () => {
  it('returns the union of both maps', () => {
    const outcomes = toNodeOutcomes({
      success: { a: ['ok'] },
      error: { b: 'boom' },
    });
    expect(outcomes).toHaveLength(2);
    expect(outcomes.find((o) => o.nodeId === 'a')?.ok).toBe(true);
    expect(outcomes.find((o) => o.nodeId === 'b')?.ok).toBe(false);
  });

  it('resolves a node present in both maps as a failure', () => {
    const outcomes = toNodeOutcomes({
      success: { a: ['partial'] },
      error: { a: 'timed out' },
    });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toEqual({ nodeId: 'a', ok: false, error: 'timed out' });
  });

  it('returns nothing for an empty envelope', () => {
    expect(toNodeOutcomes({ success: {}, error: {} })).toEqual([]);
  });
});

describe('outcomeForNode', () => {
  it('reads a success', () => {
    const o = outcomeForNode({ success: { a: 1 }, error: {} }, 'a');
    expect(o).toEqual({ nodeId: 'a', ok: true, value: 1 });
  });

  it('reads an error', () => {
    const o = outcomeForNode({ success: {}, error: { a: 'nope' } }, 'a');
    expect(o).toEqual({ nodeId: 'a', ok: false, error: 'nope' });
  });

  it('prefers the error map when a node is in both', () => {
    const o = outcomeForNode({ success: { a: 1 }, error: { a: 'nope' } }, 'a');
    expect(o?.ok).toBe(false);
  });

  // The 200-that-means-nothing case. Callers must handle null as failure.
  it('returns null when the envelope mentions the node in neither map', () => {
    expect(outcomeForNode({ success: {}, error: {} }, 'a')).toBeNull();
    expect(outcomeForNode({ success: { b: 1 }, error: {} }, 'a')).toBeNull();
  });
});
