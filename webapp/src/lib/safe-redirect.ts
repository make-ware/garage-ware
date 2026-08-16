/**
 * Constrain a post-login redirect to this origin.
 *
 * `ProtectedRoute` / `AdminRoute` put the intended destination in `?returnUrl=`
 * and the login form navigates to it. Passed through unchecked, that is an open
 * redirect: `/login?returnUrl=https%3A%2F%2Fevil.example` sends someone who just
 * typed their password on our domain straight to somebody else's — the classic
 * setup for a convincing credential-harvesting page.
 *
 * Only same-site paths are honoured. Anything else falls back, because a
 * destination we cannot vouch for is not better than the default one.
 */
export function safeRedirect(
  raw: string | null | undefined,
  fallback = '/'
): string {
  if (!raw) return fallback;

  let value = raw.trim();
  if (!value) return fallback;

  // The param is written with encodeURIComponent; tolerate both spellings, and
  // a double-encoded one, without looping forever on malformed input.
  for (let i = 0; i < 2 && /%[0-9a-f]{2}/i.test(value); i++) {
    try {
      const decoded = decodeURIComponent(value);
      if (decoded === value) break;
      value = decoded;
    } catch {
      return fallback;
    }
  }

  // Must be a path on this site. Reject anything with a scheme or an authority:
  // "//evil.example" and "https://evil.example" are both off-site, and
  // "\\/evil.example" is treated as a protocol-relative URL by some browsers.
  if (!value.startsWith('/')) return fallback;
  if (value.startsWith('//') || value.startsWith('/\\')) return fallback;

  return value;
}
