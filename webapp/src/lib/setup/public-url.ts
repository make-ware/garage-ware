/**
 * Which host the browser actually reached this app on, and whether
 * APP_PUBLIC_URL agrees with it.
 *
 * Pure, and deliberately separate from the status route: the route pulls in the
 * Garage client and a superuser PocketBase login, neither of which a test of
 * two strings should have to stand up. Same arrangement as `signup-gate.js`.
 *
 * **`new URL(req.url).host` is not the browser's host**, which is what this
 * module exists to say. Next.js builds a Route Handler's absolute URL from the
 * server's own bind address, so under the container's `next start --hostname
 * 0.0.0.0 --port 3000` every request reads back as `0.0.0.0:3000` whatever was
 * typed — and the `app-public-url` check warned on every Docker deployment,
 * correctly configured or not, which is worse than not checking: a signal that
 * is always red teaches an operator to ignore the page it lives on.
 *
 * The Host header is the browser's. Nginx inside the container forwards it
 * verbatim (`proxy_set_header Host $host`), and an outer proxy that rewrites it
 * is expected to put the original in `X-Forwarded-Host`.
 */

/**
 * The host the caller used, lowercased, or `null` when nothing said.
 *
 * Neither header is trustworthy — both are client-supplied and an outer proxy
 * may forge either — but nothing is authorized on the answer. It decides a line
 * of advisory copy, so being wrong costs a misleading hint, not access.
 */
export function requestPublicHost(headers: Headers): string | null {
  // A chain of proxies appends to X-Forwarded-Host, so the client-facing hop
  // is first. `host` is the fallback because nginx passes it through unchanged.
  const forwarded = headers.get('x-forwarded-host')?.split(',')[0];
  const raw = (forwarded ?? headers.get('host'))?.trim();
  return raw ? raw.toLowerCase() : null;
}

/**
 * Compare two hosts, ignoring a port that is implied by its scheme.
 *
 * A browser omits `:443` from the Host header while `APP_PUBLIC_URL` is written
 * with an explicit scheme, so a literal comparison reports a mismatch between
 * two spellings of the same host. Any other port is significant and is kept.
 */
export function hostsMatch(a: string, b: string): boolean {
  const strip = (h: string) => h.toLowerCase().replace(/:(?:80|443)$/, '');
  return strip(a) === strip(b);
}
