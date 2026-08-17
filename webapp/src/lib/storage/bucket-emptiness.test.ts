import { describe, expect, it } from 'vitest';
import { describeBucketEmptiness } from './bucket-emptiness';

/**
 * The guard that decides whether the app will issue a bucket delete at all.
 * Garage enforces the same rule, so a mistake here cannot destroy data — but a
 * mistake in the permissive direction means offering a delete that can only
 * fail, and one in the strict direction means a bucket nobody can remove.
 */

const EMPTY = {
  objects: 0,
  bytes: 0,
  unfinishedUploads: 0,
  unfinishedMultipartUploads: 0,
};

describe('describeBucketEmptiness', () => {
  it('an all-zero bucket is empty', () => {
    const r = describeBucketEmptiness(EMPTY);
    expect(r.empty).toBe(true);
    expect(r.unknown).toBe(false);
  });

  it('refuses on stored objects', () => {
    expect(describeBucketEmptiness({ ...EMPTY, objects: 1 }).empty).toBe(false);
  });

  it('refuses on stored bytes even with no object count', () => {
    expect(describeBucketEmptiness({ ...EMPTY, bytes: 1 }).empty).toBe(false);
  });

  it('refuses on unfinished multipart uploads — the counter we were dropping', () => {
    // Garage reports six counters and never says which gate the delete, so an
    // in-flight multipart upload counts as "not empty" here.
    expect(
      describeBucketEmptiness({ ...EMPTY, unfinishedMultipartUploads: 1 }).empty
    ).toBe(false);
  });

  it('refuses on plain unfinished uploads', () => {
    expect(
      describeBucketEmptiness({ ...EMPTY, unfinishedUploads: 2 }).empty
    ).toBe(false);
  });

  it('FAILS CLOSED when a counter is missing', () => {
    // Our schema keeps every counter optional because the spec is self-declared
    // early-stage. That looseness must never become a reason to delete: an
    // absent counter is "not known to be empty", never "empty".
    const r = describeBucketEmptiness({ objects: 0, bytes: 0 });
    expect(r.empty).toBe(false);
    expect(r.unknown).toBe(true);
  });

  it('fails closed on no info at all', () => {
    expect(describeBucketEmptiness(null).empty).toBe(false);
    expect(describeBucketEmptiness(undefined).unknown).toBe(true);
  });

  it('reports the figures a refusal message needs', () => {
    const r = describeBucketEmptiness({
      objects: 82431,
      bytes: 1_400_000_000_000,
      unfinishedUploads: 1,
      unfinishedMultipartUploads: 2,
    });
    expect(r.objects).toBe(82431);
    expect(r.bytes).toBe(1_400_000_000_000);
    expect(r.unfinishedUploads).toBe(3);
  });

  it('distinguishes a zero reading from a missing one', () => {
    expect(describeBucketEmptiness(EMPTY).objects).toBe(0);
    expect(describeBucketEmptiness({ bytes: 0 }).objects).toBeNull();
  });
});
