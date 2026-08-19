/**
 * Deployment self-check.
 *
 * Everything this reports used to fail silently, in a log nobody reads: an
 * unset APP_PUBLIC_URL skips every outgoing email, unset GARAGE_ADMIN_* makes
 * the metrics cron warn-and-skip every 15 minutes, unconfigured SMTP makes
 * admin invites 502 and storage invites vanish, and an unreachable Garage
 * rendered as the literal string "fetch failed" in a red banner.
 *
 * Two rules hold this together:
 *
 *   1. **Never read the cache.** Every Garage call here is live. The whole
 *      point is to answer "can this deployment reach the cluster *now*", and
 *      lib/garage/cached.ts is explicitly designed to serve a stale layout
 *      through an outage — exactly the wrong answer for this page.
 *   2. **Never render a secret.** Env vars report set/unset. The Garage admin
 *      token never appears in a payload, a hint, or the copy-for-support block.
 */
import { cluster } from '@/lib/garage';
import { GarageClient } from '@/lib/garage/client';
import { GarageError } from '@/lib/garage/errors';
import {
  errorResponse,
  getPbAsSuperuser,
  requireAdminOrUnclaimed,
} from '@/lib/auth/server';
import { effectiveSignupMode } from '@/lib/setup/signup-mode';
import { featureAssetClaims, featureNodeClaims } from '@/lib/setup/features';
import { hostsMatch, requestPublicHost } from '@/lib/setup/public-url';
import { expectedClaimToken } from '@/lib/setup/claim';
import {
  worstState,
  type Check,
  type Diagnostics,
} from '@/lib/setup/diagnostics';

export const dynamic = 'force-dynamic';

/** How stale a metrics sample may be before it means the cron is not running. */
const SCRAPE_STALE_MS = 45 * 60 * 1000;

function envSet(name: string): boolean {
  return Boolean(process.env[name]?.trim());
}

/** Host only — never the full URL, which may carry a token in some setups. */
function hostOf(raw: string | undefined): string {
  if (!raw) return 'unset';
  try {
    return new URL(raw).host;
  } catch {
    return 'malformed URL';
  }
}

async function checkPocketBase(): Promise<Check> {
  const missing = [
    'POCKETBASE_ADMIN_EMAIL',
    'POCKETBASE_ADMIN_PASSWORD',
  ].filter((n) => !envSet(n));
  if (missing.length > 0) {
    return {
      id: 'pocketbase-superuser',
      label: 'PocketBase superuser',
      state: 'fail',
      detail: `${missing.join(' and ')} not set.`,
      hint: 'Storage invites, user-to-user transfers, cluster events and the cluster read cache all fail without these. In Docker the container generates them on first boot — check /data/pb_superuser.env, or set both as container env.',
    };
  }
  try {
    await getPbAsSuperuser();
    return {
      id: 'pocketbase-superuser',
      label: 'PocketBase superuser',
      state: 'ok',
      detail: 'Credentials are set and authenticate successfully.',
    };
  } catch {
    return {
      id: 'pocketbase-superuser',
      label: 'PocketBase superuser',
      state: 'fail',
      detail: 'Credentials are set but PocketBase rejected them.',
      hint: 'Reset with: pocketbase superuser upsert <email> <password> --dir=/data/pb_data, using the same values as POCKETBASE_ADMIN_EMAIL/PASSWORD.',
    };
  }
}

function garageFailureHint(err: GarageError): string {
  switch (err.code) {
    case 'not_configured':
      return 'Set GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN. Mint a token on a cluster node with: garage admin-token create --name garage-ware';
    case 'unreachable':
      return `Nothing accepted a connection at ${hostOf(process.env.GARAGE_ADMIN_URL)}. Check the cluster is running and that this is the admin port (3903 by default), not the S3 port (3900).`;
    case 'dns':
      return `The hostname in GARAGE_ADMIN_URL did not resolve. From inside this container, can you reach ${hostOf(process.env.GARAGE_ADMIN_URL)}?`;
    case 'tls':
      return 'The TLS handshake failed. If the cluster uses a private CA, the certificate must be trusted by this container.';
    case 'timeout':
      return 'The cluster accepted the connection but did not answer within 15s. It may be overloaded, or a firewall may be dropping the response.';
    case 'auth':
      return 'GARAGE_ADMIN_TOKEN was rejected. Mint a fresh one with: garage admin-token create --name garage-ware';
    case 'not_found':
      return 'The endpoint answered but does not expose the v2 admin API. Check GARAGE_ADMIN_URL points at the admin port (3903), not the S3 gateway.';
    case 'quorum':
      return 'The cluster is reachable but has lost quorum — too few nodes are up. Check node health before anything else here.';
    case 'schema':
      return 'The cluster answered in a shape this version does not understand; it may be running an incompatible Garage release.';
    default:
      // Anything else means something answered but did not behave like the v2
      // admin API. Overwhelmingly that is GARAGE_ADMIN_URL aimed at the S3
      // gateway instead of the admin port, which returns a 400 rather than the
      // 404 the `not_found` branch above would have caught.
      return `Something answered at ${hostOf(process.env.GARAGE_ADMIN_URL)} but not as the Garage v2 admin API. Check GARAGE_ADMIN_URL points at the admin port (3903 by default), not the S3 port (3900).`;
  }
}

async function checkGarage(): Promise<Check[]> {
  const missing = GarageClient.missingEnv();
  if (missing.length > 0) {
    return [
      {
        id: 'garage-admin-api',
        label: 'Garage admin API',
        state: 'fail',
        detail: `${missing.join(' and ')} not set — this deployment is not connected to a cluster.`,
        hint: garageFailureHint({ code: 'not_configured' } as GarageError),
      },
      {
        id: 'garage-layout',
        label: 'Garage layout',
        state: 'unknown',
        detail: 'Cannot be read until the admin API is configured.',
      },
    ];
  }

  const garage = GarageClient.fromEnv();
  let health;
  try {
    // Live, never getCachedHealth — a stale "all fine" is the wrong answer here.
    health = await cluster.getHealth(garage);
  } catch (err) {
    const ge = err instanceof GarageError ? err : null;
    return [
      {
        id: 'garage-admin-api',
        label: 'Garage admin API',
        state: 'fail',
        detail: ge
          ? `${ge.message} (${hostOf(process.env.GARAGE_ADMIN_URL)})`
          : 'The Garage admin API call failed for an unrecognised reason.',
        hint: ge ? garageFailureHint(ge) : undefined,
      },
      {
        id: 'garage-layout',
        label: 'Garage layout',
        state: 'unknown',
        detail: 'Cannot be read while the admin API check is failing.',
      },
    ];
  }

  const healthy = health.status === 'healthy';
  const apiCheck: Check = {
    id: 'garage-admin-api',
    label: 'Garage admin API',
    state: healthy ? 'ok' : 'warn',
    detail: `Reachable at ${hostOf(process.env.GARAGE_ADMIN_URL)}. Cluster reports "${health.status}" — ${health.connectedNodes}/${health.knownNodes} nodes connected, ${health.partitionsAllOk}/${health.partitions} partitions fully OK.`,
    hint: healthy
      ? undefined
      : 'The cluster is reachable but not fully healthy. Check node status on the Cluster page.',
  };

  let layoutCheck: Check;
  try {
    // Replication factor is a separate call — the layout does not carry it.
    const [layout, replicationFactor] = await Promise.all([
      cluster.getLayout(garage),
      cluster.getReplicationFactor(garage),
    ]);
    const storageNodes = layout.roles.filter((r) => (r.capacity ?? 0) > 0);
    if (layout.roles.length === 0) {
      layoutCheck = {
        id: 'garage-layout',
        label: 'Garage layout',
        state: 'warn',
        detail: 'No layout has been applied to this cluster.',
        // Without a layout every node values at zero, so no claim can be
        // granted and no bucket can be created — the app looks broken.
        hint: 'Assign roles and apply a layout on a cluster node (garage layout assign / garage layout apply). Until then no storage can be claimed or allocated.',
      };
    } else {
      layoutCheck = {
        id: 'garage-layout',
        label: 'Garage layout',
        state: 'ok',
        detail: `Layout version ${layout.version}, replication factor ${replicationFactor}, ${storageNodes.length} storage node(s).`,
      };
    }
  } catch {
    layoutCheck = {
      id: 'garage-layout',
      label: 'Garage layout',
      state: 'unknown',
      detail: 'The layout could not be read even though the API answered.',
    };
  }

  return [apiCheck, layoutCheck];
}

function checkS3(): Check {
  const endpoint = process.env.GARAGE_S3_ENDPOINT?.trim();
  if (!endpoint) {
    return {
      id: 's3-gateway',
      label: 'S3 gateway',
      state: 'fail',
      detail: 'GARAGE_S3_ENDPOINT is not set.',
      hint: 'The in-app file browser and the bucket "connect" page return an error without it. Point it at this cluster’s S3 gateway.',
    };
  }
  const advertised = process.env.GARAGE_PUBLIC_S3_ENDPOINT?.trim();
  return {
    id: 's3-gateway',
    label: 'S3 gateway',
    state: 'ok',
    detail:
      `Configured: ${hostOf(endpoint)} (region ${process.env.GARAGE_S3_REGION ?? 'us-east-1'})` +
      (advertised ? `, advertised to users as ${hostOf(advertised)}` : ''),
    // CORS cannot be checked from the server — the browser is the one being
    // blocked, and it is a per-bucket setting, not a gateway one.
    hint: 'Each bucket must also allow CORS from this app’s origin (GET/PUT/HEAD, the authorization/x-amz-*/content-type request headers, ETag exposed) or the in-app file browser will be blocked by the browser. See docker/README.md.',
  };
}

function checkAppUrl(req: Request): Check {
  const configured = process.env.APP_PUBLIC_URL?.trim();
  if (!configured) {
    return {
      id: 'app-public-url',
      label: 'Public URL',
      state: 'warn',
      detail: 'APP_PUBLIC_URL is not set.',
      hint: 'Storage-invite emails and daily usage alerts are skipped entirely without it — the invite row is still written, but nobody is told.',
    };
  }
  // NOT `new URL(req.url).host` — Next.js builds that from the server's own
  // bind address, so behind the container's `--hostname 0.0.0.0 --port 3000`
  // it reads `0.0.0.0:3000` on every request and this check never passed.
  const requestHost = requestPublicHost(req.headers);
  const configuredHost = hostOf(configured);
  if (
    requestHost &&
    configuredHost !== 'malformed URL' &&
    !hostsMatch(requestHost, configuredHost)
  ) {
    return {
      id: 'app-public-url',
      label: 'Public URL',
      state: 'warn',
      detail: `APP_PUBLIC_URL is ${configuredHost}, but this page was served from ${requestHost}.`,
      hint: 'Links in outgoing email will point at the configured host. If that is not how users reach this app, they will follow a broken link.',
    };
  }
  return {
    id: 'app-public-url',
    label: 'Public URL',
    state: 'ok',
    detail: `Set to ${configuredHost}.`,
  };
}

async function checkSmtp(): Promise<Check> {
  try {
    const pb = await getPbAsSuperuser();
    const settings = (await pb.settings.getAll()) as {
      smtp?: { enabled?: boolean; host?: string; port?: number };
      meta?: { senderAddress?: string };
    };
    if (!settings.smtp?.enabled) {
      return {
        id: 'smtp',
        label: 'Email (SMTP)',
        state: 'warn',
        detail:
          'SMTP is not enabled, so PocketBase falls back to a local sendmail binary that this container does not have.',
        hint: 'Inviting a user from /admin/users will fail with a 502, storage-invite emails are silently dropped, and password resets never arrive. Configure it at /_/#/settings/mail.',
      };
    }
    return {
      id: 'smtp',
      label: 'Email (SMTP)',
      state: 'ok',
      detail: `Enabled via ${settings.smtp.host ?? 'unknown host'}:${settings.smtp.port ?? '?'}, sending as ${settings.meta?.senderAddress ?? 'unset sender'}.`,
    };
  } catch {
    return {
      id: 'smtp',
      label: 'Email (SMTP)',
      state: 'unknown',
      detail: 'Mail settings could not be read.',
      hint: 'This needs a working PocketBase superuser — fix that check first.',
    };
  }
}

async function checkScrape(): Promise<Check> {
  if (GarageClient.missingEnv().length > 0) {
    return {
      id: 'metrics-scrape',
      label: 'Metrics collection',
      state: 'warn',
      detail:
        'The scraper cannot run without GARAGE_ADMIN_URL and GARAGE_ADMIN_TOKEN.',
      hint: 'It warns and skips every 15 minutes; the metrics charts stay empty.',
    };
  }
  try {
    const pb = await getPbAsSuperuser();
    const latest = await pb
      .collection('NodeMetrics')
      .getList(1, 1, { sort: '-created' });
    const newest = latest.items[0];
    if (!newest) {
      return {
        id: 'metrics-scrape',
        label: 'Metrics collection',
        state: 'warn',
        detail: 'No samples have been recorded yet.',
        hint: 'The scrape cron runs every 15 minutes. If this persists, check the PocketBase log for [node-metrics] warnings.',
      };
    }
    const age = Date.now() - new Date(newest.created as string).getTime();
    const minutes = Math.round(age / 60000);
    if (age > SCRAPE_STALE_MS) {
      return {
        id: 'metrics-scrape',
        label: 'Metrics collection',
        state: 'warn',
        detail: `The most recent sample is ${minutes} minutes old.`,
        hint: 'The cron runs every 15 minutes. Check the PocketBase log for [node-metrics] warnings.',
      };
    }
    return {
      id: 'metrics-scrape',
      label: 'Metrics collection',
      state: 'ok',
      detail: `Most recent sample ${minutes} minute(s) ago.`,
    };
  } catch {
    return {
      id: 'metrics-scrape',
      label: 'Metrics collection',
      state: 'unknown',
      detail: 'Sample history could not be read.',
    };
  }
}

async function checkDrift(): Promise<Check> {
  try {
    const pb = await getPbAsSuperuser();
    const drifted = await pb
      .collection('StorageUserBalances')
      .getList(1, 1, { filter: 'last_drift_gb != 0' });
    if (drifted.totalItems > 0) {
      return {
        id: 'balance-drift',
        label: 'Storage balances',
        state: 'warn',
        detail: `${drifted.totalItems} user balance(s) were corrected by a rebuild.`,
        // Per the accounting design, a non-zero correction means an incremental
        // hook missed a write path — not routine maintenance.
        hint: 'A non-zero drift is a bug, not housekeeping: it means an incremental balance update was missed. Worth reporting.',
      };
    }
    return {
      id: 'balance-drift',
      label: 'Storage balances',
      state: 'ok',
      detail: 'No drift recorded between the ledgers and their roll-ups.',
    };
  } catch {
    return {
      id: 'balance-drift',
      label: 'Storage balances',
      state: 'unknown',
      detail: 'Balance records could not be read.',
    };
  }
}

async function checkAccess(): Promise<Check> {
  const mode = effectiveSignupMode();
  const modeText =
    mode === 'invite'
      ? 'invite only — an address needs a pending storage invite, or an admin-created account'
      : mode === 'open'
        ? 'open — anyone who can reach the sign-up page may create an account'
        : 'closed (the default) — only administrators can create accounts';
  const featureText = `Node claiming is ${featureNodeClaims() ? 'enabled' : 'off (admin-only)'}; key/bucket claiming is ${featureAssetClaims() ? 'enabled' : 'off (admin-only)'}.`;
  try {
    const pb = await getPbAsSuperuser();
    const admins = await pb.collection('Admins').getList(1, 1);
    const tokenLive = (await expectedClaimToken()) !== null;
    if (admins.totalItems === 0) {
      return {
        id: 'access',
        label: 'Access control',
        state: 'warn',
        detail: `No administrator has claimed this instance yet. Sign-up is ${modeText}.`,
        hint: 'While unclaimed, sign-up stays open regardless of SIGNUP_MODE so the owner can create their account. Claim it at /setup.',
      };
    }
    return {
      id: 'access',
      label: 'Access control',
      state: mode === 'open' ? 'warn' : 'ok',
      detail: `${admins.totalItems} administrator(s). Sign-up is ${modeText}. ${featureText}${tokenLive ? ' A setup claim token is still present.' : ''}`,
      hint:
        mode === 'open'
          ? 'If this deployment is reachable from the internet, consider SIGNUP_MODE=closed or invite.'
          : undefined,
    };
  } catch {
    return {
      id: 'access',
      label: 'Access control',
      state: 'unknown',
      detail: `Sign-up is ${modeText}; the administrator list could not be read.`,
    };
  }
}

export async function GET(req: Request) {
  try {
    await requireAdminOrUnclaimed(req);

    // Independent probes, so one slow call does not serialise the rest.
    const [pocketbase, garage, smtp, scrape, drift, access] = await Promise.all(
      [
        checkPocketBase(),
        checkGarage(),
        checkSmtp(),
        checkScrape(),
        checkDrift(),
        checkAccess(),
      ]
    );

    const checks: Check[] = [
      pocketbase,
      ...garage,
      checkS3(),
      checkAppUrl(req),
      smtp,
      scrape,
      drift,
      access,
    ];

    const body: Diagnostics = {
      generatedAt: new Date().toISOString(),
      overall: worstState(checks),
      checks,
    };
    return Response.json(body);
  } catch (err) {
    return errorResponse(err);
  }
}
