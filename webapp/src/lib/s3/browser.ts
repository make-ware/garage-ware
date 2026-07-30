'use client';

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import type { S3Config } from './config';

/**
 * Browser-side S3-gateway access for the in-app file browser.
 *
 * Unlike `lib/garage/` (server-only, talks to the Garage *admin* API with the
 * cluster's `GARAGE_ADMIN_TOKEN`), this module runs entirely in the browser and
 * signs requests with the **user-supplied S3 credentials** typed into the
 * credential gate. The secret never leaves the tab — it is not sent to our
 * server, not stored by PocketBase, and not placed in any URL/query string. It
 * is used only by the AWS SDK to sign requests sent directly to the gateway.
 *
 * Because requests go browser → gateway (no Next.js proxy), the gateway/bucket
 * must allow this app's origin via CORS (Allow-Origin, methods GET/PUT/HEAD,
 * the `authorization`/`x-amz-*`/`content-type` request headers, and an exposed
 * `ETag`) — otherwise the browser blocks the requests before they are sent.
 */

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Object {
  key: string;
  size: number;
  lastModified: string | null;
}

export interface S3Listing {
  prefix: string;
  folders: string[];
  objects: S3Object[];
}

/** Error surfaced to the UI. `isAuthError` triggers re-prompting for the secret. */
export class S3BrowserError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly isAuthError = false
  ) {
    super(message);
    this.name = 'S3BrowserError';
  }
}

/**
 * Build an S3 client for the Garage gateway using the caller's credentials.
 * The gateway endpoint + region come from runtime config (see `./config`), not
 * build-time env, so the same image works against any cluster.
 *
 * Uses `config.endpoint` (`GARAGE_S3_ENDPOINT`): this client runs in the browser
 * and signs requests directly against the gateway, so it needs an endpoint with
 * CORS configured for the app's origin.
 */
export function s3FromCredentials(
  credentials: S3Credentials,
  config: S3Config
): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials,
  });
}

interface S3ErrorShape {
  name?: string;
  message?: string;
  $metadata?: { httpStatusCode?: number };
}

/**
 * Map an AWS SDK S3 error (or a fetch/CORS failure) to a typed
 * `S3BrowserError` with a clean, user-facing message.
 */
function toS3Error(err: unknown): S3BrowserError {
  // A CORS rejection or network failure surfaces as a TypeError from fetch
  // ("Failed to fetch") with no `$metadata` — the SDK never saw a response.
  if (err instanceof TypeError) {
    return new S3BrowserError(
      0,
      'Could not reach the storage gateway. The bucket may not allow browser ' +
        '(CORS) access from this site.'
    );
  }

  const e = err as S3ErrorShape;
  const name = e?.name ?? '';
  const status = e?.$metadata?.httpStatusCode;

  if (name === 'InvalidAccessKeyId' || name === 'SignatureDoesNotMatch') {
    return new S3BrowserError(401, 'Invalid S3 credentials', true);
  }
  if (name === 'AccessDenied') {
    return new S3BrowserError(
      403,
      'This key is not permitted to access this bucket',
      true
    );
  }
  if (name === 'NoSuchKey' || name === 'NotFound') {
    return new S3BrowserError(404, 'Object not found');
  }
  if (name === 'NoSuchBucket') {
    return new S3BrowserError(404, 'Bucket not found on the storage cluster');
  }
  if (status === 401 || status === 403) {
    return new S3BrowserError(status, 'S3 request was rejected', true);
  }
  return new S3BrowserError(status ?? 500, e?.message || 'S3 request failed');
}

/** List objects under `prefix`, folder-style (collapsing on `/`). */
export async function listObjects(
  s3: S3Client,
  bucket: string,
  prefix: string
): Promise<S3Listing> {
  try {
    const out = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        Delimiter: '/',
      })
    );

    const folders = (out.CommonPrefixes ?? [])
      .map((p) => p.Prefix)
      .filter((p): p is string => Boolean(p));

    const objects = (out.Contents ?? [])
      // Drop the prefix's own placeholder key (the "folder" marker).
      .filter((o) => o.Key && o.Key !== prefix)
      .map((o) => ({
        key: o.Key as string,
        size: o.Size ?? 0,
        lastModified: o.LastModified?.toISOString() ?? null,
      }));

    return { prefix, folders, objects };
  } catch (err) {
    throw toS3Error(err);
  }
}

/** Part size for multipart uploads — also the threshold below which the SDK
 * sends a single PutObject. 8 MiB keeps individual requests small. */
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;

/**
 * Upload (or overwrite) a single object from a browser File using a multipart
 * upload, so files of any size stream up in parts rather than buffering whole.
 * `onProgress` is called with a 0–100 percentage as parts complete (only when
 * the total size is known, which it always is for a File).
 */
export async function uploadObject(
  s3: S3Client,
  bucket: string,
  key: string,
  file: File,
  onProgress?: (percent: number) => void
): Promise<void> {
  try {
    const upload = new Upload({
      client: s3,
      // The SDK accepts a Blob/File body directly in the browser.
      params: {
        Bucket: bucket,
        Key: key,
        Body: file,
        ContentType: file.type || 'application/octet-stream',
      },
      partSize: UPLOAD_PART_SIZE,
      queueSize: 4, // upload up to 4 parts concurrently
      leavePartsOnError: false, // abort + clean up orphaned parts on failure
    });

    if (onProgress) {
      upload.on('httpUploadProgress', ({ loaded, total }) => {
        if (loaded != null && total) {
          onProgress(Math.round((loaded / total) * 100));
        }
      });
    }

    await upload.done();
  } catch (err) {
    throw toS3Error(err);
  }
}

/** Download a single object as a Blob. */
export async function downloadObject(
  s3: S3Client,
  bucket: string,
  key: string
): Promise<Blob> {
  try {
    const out = await s3.send(
      new GetObjectCommand({ Bucket: bucket, Key: key })
    );
    if (!out.Body) throw new S3BrowserError(404, 'Object not found');
    const bytes = await out.Body.transformToByteArray();
    // Copy into a fresh ArrayBuffer-backed view so the Blob part is typed as
    // ArrayBuffer (not the generic ArrayBufferLike the SDK returns).
    return new Blob([new Uint8Array(bytes)], {
      type: out.ContentType ?? 'application/octet-stream',
    });
  } catch (err) {
    if (err instanceof S3BrowserError) throw err;
    throw toS3Error(err);
  }
}
