import 'server-only';

/**
 * Did a UNIQUE index reject this PocketBase write, on this field?
 *
 * Every claim route in the app leans on a UNIQUE index as its concurrency
 * control rather than a pre-flight existence check — `NodeOwners.node_id`,
 * `AccessKeys.garage_key_id`, `Buckets.garage_bucket_id` — because a
 * check-then-act pair lets two simultaneous claims both pass. That only works
 * if the resulting failure can be told apart from every other failure, which is
 * what this does.
 *
 * PocketBase surfaces a constraint violation as a **400 carrying a per-field
 * validation object**, `{ <field>: { code, message } }`, and the code for a
 * UNIQUE index rejection is `validation_not_unique`. **The code is the signal,
 * not the field name.** Matching on "a 400 mentioning this field" catches every
 * other per-field validation error too — a name over its max length, a value
 * failing a pattern — and reports it as a collision, sending the user to look
 * for a conflicting record that does not exist.
 *
 * Kept narrow on purpose, and it fails in the safe direction: a code we do not
 * recognise is reported as itself and becomes a 500, because a claim that failed
 * for an unknown reason must never report itself as "already claimed".
 *
 * The `field` argument is not decoration. `Buckets` carries **two** unique
 * indexes and they mean different things: `garage_bucket_id` means the bucket
 * is already claimed, `name` means a different bucket is already registered
 * under that alias. A caller that matched on "any unique violation" would tell
 * a user their bucket was taken when the real problem was a name collision.
 */

/**
 * PocketBase's validation code for a value rejected by a UNIQUE index. Confirmed
 * against the shipped binary rather than inferred from a response we happened to
 * see, since everything below turns on it.
 */
const NOT_UNIQUE_CODE = 'validation_not_unique';

export function isUniqueViolation(err: unknown, field: string): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { status?: number; response?: { data?: unknown } };
  if (e.status !== 400) return false;
  const data = e.response?.data;
  if (!data || typeof data !== 'object') return false;
  const entry = (data as Record<string, unknown>)[field];
  if (!entry || typeof entry !== 'object') return false;
  return (entry as { code?: unknown }).code === NOT_UNIQUE_CODE;
}
