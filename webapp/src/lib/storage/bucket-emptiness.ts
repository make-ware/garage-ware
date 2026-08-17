/**
 * Is a bucket empty enough to delete?
 *
 * Deliberately **not** `server-only` and typed *structurally*, so it imports
 * nothing from `lib/garage/*` — the same arrangement as `ownedBucketKeyFor` in
 * `bucket-claim.ts`. The rule is one pure function a test can drive across
 * every shape Garage can return, rather than a condition buried in a route.
 *
 * **Garage is the authority, not this.** `DeleteBucket` refuses a non-empty
 * bucket with a `400 "Bucket is not empty"` whatever we do, and the two reads
 * are not atomic — an upload can land between the check and the delete. This
 * exists so the refusal can say *how* full the bucket is before the user has
 * typed its name into a confirmation dialog, and so the app never issues a
 * delete it can already tell will fail.
 *
 * **It fails closed.** The spec never defines what "empty" means to Garage — it
 * exposes six separate counters and says which of them gates the delete
 * nowhere — and our schema keeps them all optional because the spec is
 * self-declared early-stage. So an absent counter is "not known to be empty",
 * never "empty". Guessing permissively here would mean issuing a delete against
 * a bucket we cannot describe, and the whole reason bucket deletion is exposed
 * to users at all is that it can only ever destroy nothing.
 */

/** The counters `GetBucketInfo` reports, all optional as Garage may omit them. */
export interface BucketContents {
  objects?: number;
  bytes?: number;
  unfinishedUploads?: number;
  unfinishedMultipartUploads?: number;
}

export interface BucketEmptiness {
  empty: boolean;
  /** True when a counter was missing, so `empty: false` means "unknown". */
  unknown: boolean;
  objects: number | null;
  bytes: number | null;
  /** Unfinished + unfinished-multipart, when both are known. */
  unfinishedUploads: number | null;
}

/**
 * A counter Garage did not report reads as `null`, which is not zero.
 */
function reading(value: number | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function describeBucketEmptiness(
  info: BucketContents | null | undefined
): BucketEmptiness {
  const objects = reading(info?.objects);
  const bytes = reading(info?.bytes);
  const unfinished = reading(info?.unfinishedUploads);
  const multipart = reading(info?.unfinishedMultipartUploads);

  const unknown =
    objects === null ||
    bytes === null ||
    unfinished === null ||
    multipart === null;

  const counts = [objects, bytes, unfinished, multipart];
  const anythingStored = counts.some((c) => c !== null && c > 0);

  return {
    empty: !unknown && !anythingStored,
    unknown,
    objects,
    bytes,
    unfinishedUploads:
      unfinished === null && multipart === null
        ? null
        : (unfinished ?? 0) + (multipart ?? 0),
  };
}
