import 'server-only';
import type { ClaimAuditSource } from '@garage-ware/shared';

/**
 * Attribution headers for a StorageClaims write.
 *
 * StorageClaims' write rules are null, so every claim mutation is made with the
 * memoized superuser client from `getPbAsSuperuser()`. That leaves the PocketBase
 * audit hook looking at a service account where it needs a human, so the real
 * actor rides along on the request and `resolveActor()` in
 * pocketbase/pb_hooks/lib/claim-audit.js picks it up.
 *
 * The hook honours these ONLY when the request already carries superuser auth,
 * which is what stops a browser forging one. Header names are matched there
 * lowercased with `-` replaced by `_` (docs/PB_FILTERS.md), so `X-Claim-Actor-Id`
 * arrives as `x_claim_actor_id`.
 *
 * `source` must be a value the hook's own allow-list recognises; anything else
 * is silently downgraded to `api` rather than rejected, since the column is a
 * select field and an unknown value would roll back the write it describes.
 */
export function actorHeaders(
  user: { id: string; email?: string },
  source: Extract<ClaimAuditSource, 'api' | 'node-owner'>
): Record<string, string> {
  return {
    'X-Claim-Actor-Id': user.id,
    'X-Claim-Actor-Email': user.email ?? '',
    'X-Claim-Source': source,
  };
}
