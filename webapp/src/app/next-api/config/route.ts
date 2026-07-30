/**
 * Public runtime config for the browser.
 *
 * The in-app S3 file browser ([webapp/src/lib/s3/browser.ts]) and the bucket
 * "connect" page need the S3 gateway endpoint + region. These values are
 * NON-SECRET — the browser sends them in plaintext to the gateway on every
 * request — but they must be configurable per deployment WITHOUT rebuilding the
 * image. So they are read from the server-side env at request time here, rather
 * than inlined as `NEXT_PUBLIC_*` at build time (which would bake one value into
 * the client bundle and ignore the runtime env entirely).
 *
 * No auth gate: the values are public, and requiring a PB session would couple
 * config loading to auth for zero security benefit.
 *
 * `GARAGE_S3_ENDPOINT` is the gateway the in-app file browser's S3 client talks
 * to; it signs requests in the browser and so needs CORS configured for the
 * app's origin. It is REQUIRED and deliberately has no default — a fallback
 * would silently point every unconfigured deployment at whichever cluster the
 * default named, so an unset value is a configuration error, not something to
 * paper over. `GARAGE_PUBLIC_S3_ENDPOINT` is an OPTIONAL public-facing endpoint
 * shown on the bucket "connect" page for users to paste into their own S3 tools;
 * when unset it falls back to `GARAGE_S3_ENDPOINT`, so single-endpoint
 * deployments need no extra config.
 */

export const dynamic = 'force-dynamic';

export function GET() {
  const s3Endpoint = process.env.GARAGE_S3_ENDPOINT;
  if (!s3Endpoint) {
    return Response.json(
      {
        error:
          'GARAGE_S3_ENDPOINT is not set. Point it at this deployment’s Garage S3 gateway (e.g. https://s3.example.com) and restart.',
      },
      { status: 500 }
    );
  }
  return Response.json({
    s3Endpoint,
    s3PublicEndpoint: process.env.GARAGE_PUBLIC_S3_ENDPOINT ?? s3Endpoint,
    s3Region: process.env.GARAGE_S3_REGION ?? 'us-east-1',
  });
}
