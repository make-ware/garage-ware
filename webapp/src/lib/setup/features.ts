/**
 * Feature flags for the community self-service flows.
 *
 * Deliberately NOT `server-only`, like `signup-mode.ts`: the parsing is shared
 * with tests, and the values are public by design — `/next-api/config/features`
 * serves them to the browser so the UI can hide gated flows. Only the env read
 * is server-side, and it happens at request time (never build time) so one
 * image can be pointed at any deployment via plain env.
 *
 * Both flags default OFF. Parsing fails closed: only an explicit `true` or `1`
 * enables — the same ethos as `parseSignupMode` never falling back to `open`,
 * because a typo in an env var must not silently throw a door open.
 */

/** Only `true` or `1` (trimmed, case-insensitive) enables; anything else is off. */
export function parseFeatureFlag(raw: string | undefined | null): boolean {
  const value = (raw ?? '').trim().toLowerCase();
  return value === 'true' || value === '1';
}

/**
 * FEATURE_NODE_CLAIMS — may non-admin users claim node ownership and grant
 * storage sourced from nodes they own? Off = fully admin-only: no new
 * self-claims, and existing NodeOwners rows go inert (kept, not deleted) via
 * the gate in `assertNodeOwner`.
 */
export function featureNodeClaims(): boolean {
  return parseFeatureFlag(process.env.FEATURE_NODE_CLAIMS);
}

/**
 * FEATURE_ASSET_CLAIMS — may users self-claim pre-existing Garage access keys
 * (by proving the secret) and buckets (derived from an owned key)? Off = the
 * admin `keys/import` / `buckets/import` routes are the only onboarding path
 * for existing assets.
 */
export function featureAssetClaims(): boolean {
  return parseFeatureFlag(process.env.FEATURE_ASSET_CLAIMS);
}
