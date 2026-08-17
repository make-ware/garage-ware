import { describe, expect, it } from 'vitest';
import { ownedBucketKeyFor, type BucketKeyGrant } from './bucket-claim';

/**
 * The whole bucket-claim admission test lives in one pure function, so the
 * permission matrix can be exercised here rather than only end-to-end.
 */

const MINE = 'GKmine00000000000000';
const THEIRS = 'GKtheirs000000000000';

function grant(
  accessKeyId: string,
  permissions: BucketKeyGrant['permissions']
): BucketKeyGrant {
  return { accessKeyId, permissions };
}

describe('ownedBucketKeyFor', () => {
  it('accepts a key of mine that Garage marks owner', () => {
    expect(
      ownedBucketKeyFor(
        [grant(MINE, { read: true, write: true, owner: true })],
        [MINE]
      )
    ).toBe(MINE);
  });

  it('REFUSES read+write without owner', () => {
    // A grant somebody gave me is not ownership. On a shared bucket this is
    // what stops a read/write grantee taking the record from the owner.
    expect(
      ownedBucketKeyFor(
        [grant(MINE, { read: true, write: true, owner: false })],
        [MINE]
      )
    ).toBeNull();
  });

  it('REFUSES read-only', () => {
    expect(ownedBucketKeyFor([grant(MINE, { read: true })], [MINE])).toBeNull();
  });

  it('treats an absent owner flag as no, not as unknown', () => {
    // All three flags are optional in Garage's schema, so a key with no
    // permissions may omit them rather than send false.
    expect(ownedBucketKeyFor([grant(MINE, {})], [MINE])).toBeNull();
  });

  it("REFUSES somebody else's owner key", () => {
    expect(
      ownedBucketKeyFor([grant(THEIRS, { owner: true })], [MINE])
    ).toBeNull();
  });

  it('picks my owner key out of a crowd', () => {
    expect(
      ownedBucketKeyFor(
        [
          grant(THEIRS, { owner: true, read: true, write: true }),
          grant('GKother0000000000000', { read: true }),
          grant(MINE, { owner: true }),
        ],
        [MINE]
      )
    ).toBe(MINE);
  });

  it('reports WHICH key proved it, for the audit line', () => {
    const second = 'GKsecond000000000000';
    expect(
      ownedBucketKeyFor([grant(second, { owner: true })], [MINE, second])
    ).toBe(second);
  });

  it('handles a bucket with no keys, and an undefined key list', () => {
    expect(ownedBucketKeyFor([], [MINE])).toBeNull();
    expect(ownedBucketKeyFor(undefined, [MINE])).toBeNull();
  });

  it('refuses when the caller owns no keys at all', () => {
    expect(ownedBucketKeyFor([grant(MINE, { owner: true })], [])).toBeNull();
  });
});
