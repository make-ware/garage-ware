/**
 * Liveness probe for the whole container, not just half of it.
 *
 * nginx already exposes `/health`, but that proxies straight to PocketBase — it
 * proves the process that rarely dies is alive, and says nothing about Next.js.
 * This is what the image's HEALTHCHECK hits: reaching it proves Next.js is
 * serving, and its body proves Next.js can reach PocketBase.
 *
 * Unauthenticated, and deliberately says nothing about configuration or the
 * Garage cluster — that is `/next-api/status`, which is gated. A probe endpoint
 * that reports your backend's state to anyone who asks is a different thing.
 */
export const dynamic = 'force-dynamic';

function pbUrl(): string {
  const serverUrl = process.env.POCKETBASE_URL;
  if (serverUrl) return serverUrl;
  const publicUrl = process.env.NEXT_PUBLIC_POCKETBASE_URL;
  if (publicUrl && /^https?:\/\//i.test(publicUrl)) return publicUrl;
  return 'http://localhost:8090';
}

export async function GET() {
  let pocketbase = false;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3_000);
    try {
      const res = await fetch(`${pbUrl().replace(/\/+$/, '')}/api/health`, {
        signal: controller.signal,
        cache: 'no-store',
      });
      pocketbase = res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    pocketbase = false;
  }

  // 503 when a dependency is down so orchestrators restart or drain us, rather
  // than a 200 that reports "degraded" in a body nothing reads.
  return Response.json(
    { status: pocketbase ? 'ok' : 'degraded', pocketbase },
    { status: pocketbase ? 200 : 503 }
  );
}
