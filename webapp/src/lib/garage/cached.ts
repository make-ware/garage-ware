import 'server-only';
import { z } from 'zod';
import { GarageClusterCacheMutator } from '@garage-ware/shared/mutators';
import { getPbAsSuperuser } from '@/lib/auth/server';
import { GarageClient } from './client';
import * as cluster from './cluster';
import {
  ClusterHealthSchema,
  ClusterLayoutSchema,
  ClusterStatusSchema,
  type ClusterHealth,
  type ClusterLayout,
  type ClusterStatus,
} from './schemas';

/**
 * Stale-while-revalidate reads of the Garage cluster, backed by the
 * `GarageClusterCache` collection.
 *
 * The dashboard used to make a live admin-API round trip for each of these on
 * every load — the layout three times over, plus a cluster-wide status fan-out
 * that waits on every peer. None of it is realtime: a layout changes when an
 * operator changes it. So a read serves what was last stored and, if that has
 * aged past its TTL, refreshes it behind the response.
 *
 * **Only display paths may use this.** Every storage invariant is enforced
 * against the layout, and a stale layout must not decide whether capacity
 * exists — so claim mutations, transfer sends and returns, bucket quota
 * validation, and invite settlement all keep calling `cluster.getLayout`
 * directly. The rule is not stylistic: the whole point of caching here is that
 * being a minute out of date is harmless for *showing* a number and unsafe for
 * *checking* one.
 *
 * Deliberately not re-exported from `./index`, which every Garage consumer
 * imports — the barrel would then drag `lib/auth/server` (and PocketBase) into
 * modules that only want the HTTP client. Import this file directly.
 *
 * Behaviour, in the order the cases are decided:
 *   - **Fresh row** — parse and return. Zero Garage calls, zero writes.
 *   - **Stale row** — return it immediately, refresh in the background.
 *   - **Miss, or a payload that no longer parses** — block on Garage, write
 *     through, return. Garage v2 is documented as an early implementation that
 *     may change, so a row written under an older shape is a miss, not a
 *     usable value.
 *   - **Garage unreachable** — a stale row is served whatever its age. There
 *     is no maximum staleness on purpose: an outage is precisely what the
 *     cache rides out, and the alternative is an error page. With no row at
 *     all the error propagates, exactly as it did before this cache existed.
 */

export const CACHE_KEY_LAYOUT = 'layout';
export const CACHE_KEY_STATUS = 'status';
export const CACHE_KEY_HEALTH = 'health';
export const CACHE_KEY_REPLICATION_FACTOR = 'replication_factor';

/**
 * How long each kind of read is trusted without re-asking Garage.
 *
 * Layout and replication factor only move when an operator reconfigures the
 * cluster, so their TTLs are about bounding how long a change stays invisible
 * on an admin screen, not about accuracy. Status and health carry per-node
 * liveness, which does move on its own — hence the shorter window.
 */
const TTL_MS = {
  [CACHE_KEY_LAYOUT]: 60_000,
  [CACHE_KEY_STATUS]: 30_000,
  [CACHE_KEY_HEALTH]: 30_000,
  [CACHE_KEY_REPLICATION_FACTOR]: 3_600_000,
} as const;

/**
 * Refreshes running right now, keyed by cache key.
 *
 * One dashboard load fans out into several handlers that all want the layout.
 * Without this they would each miss, each call `GetClusterLayout`, and each
 * write the row back — turning one cold load into N round trips against the
 * thing being cached. Cross-process races are absorbed by `upsertByKey`
 * instead: the unique index rejects the loser, which re-reads and updates.
 */
const inFlight = new Map<string, Promise<unknown>>();

/**
 * PocketBase stores dates as `2026-08-08 10:00:00.000Z`. `Date.parse` handles
 * that only through its implementation-defined fallback, so normalise the
 * separator rather than depend on it. An unparseable or absent timestamp reads
 * as "age unknown", which the caller treats as stale — serve it, then refresh,
 * which writes a timestamp and ends the ambiguity.
 */
function parseFetchedAt(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value.trim().replace(' ', 'T'));
  return Number.isNaN(ms) ? null : ms;
}

/** Fetch from Garage and write the row back, deduped per key in this process. */
function refreshAndStore<T extends object>(
  key: string,
  fetchLive: () => Promise<T>
): Promise<T> {
  const existing = inFlight.get(key);
  if (existing) return existing as Promise<T>;

  const pending = (async () => {
    try {
      const fresh = await fetchLive();
      const pb = await getPbAsSuperuser();
      await new GarageClusterCacheMutator(pb).upsertByKey(
        key,
        fresh as unknown as Record<string, unknown>,
        new Date().toISOString()
      );
      return fresh;
    } finally {
      inFlight.delete(key);
    }
  })();

  inFlight.set(key, pending);
  return pending;
}

interface ReadThroughOptions<T extends object> {
  key: string;
  ttlMs: number;
  /** Parses the stored payload. A parse failure is treated as a miss. */
  payloadSchema: z.ZodType<T>;
  fetchLive: () => Promise<T>;
}

async function readThroughCache<T extends object>({
  key,
  ttlMs,
  payloadSchema,
  fetchLive,
}: ReadThroughOptions<T>): Promise<T> {
  let stored: T | null = null;
  let fetchedAt: number | null = null;

  try {
    const pb = await getPbAsSuperuser();
    const row = await new GarageClusterCacheMutator(pb).findByKey(key);
    if (row) {
      const parsed = payloadSchema.safeParse(row.payload);
      if (parsed.success) {
        stored = parsed.data;
        fetchedAt = parseFetchedAt(row.fetched_at);
      } else {
        console.warn(
          `[garage-cache] stored ${key} payload no longer parses; refetching`
        );
      }
    }
  } catch (err) {
    // PocketBase unreachable, or superuser credentials missing. The cache is
    // an optimisation; losing it must not cost more than the round trip it was
    // saving, so fall through to a live fetch.
    console.error('[garage-cache] read failed:', key, err);
  }

  if (stored !== null) {
    if (fetchedAt !== null && Date.now() - fetchedAt <= ttlMs) return stored;
    // Stale. Serve it now; a failed refresh is only a log, which is what keeps
    // a Garage outage from reaching the browser.
    refreshAndStore(key, fetchLive).catch((err) =>
      console.error('[garage-cache] background refresh failed:', key, err)
    );
    return stored;
  }

  return refreshAndStore(key, fetchLive);
}

export async function getCachedLayout(): Promise<ClusterLayout> {
  return readThroughCache({
    key: CACHE_KEY_LAYOUT,
    ttlMs: TTL_MS[CACHE_KEY_LAYOUT],
    payloadSchema: ClusterLayoutSchema,
    fetchLive: () => cluster.getLayout(GarageClient.fromEnv()),
  });
}

export async function getCachedStatus(): Promise<ClusterStatus> {
  return readThroughCache({
    key: CACHE_KEY_STATUS,
    ttlMs: TTL_MS[CACHE_KEY_STATUS],
    payloadSchema: ClusterStatusSchema,
    fetchLive: () => cluster.getStatus(GarageClient.fromEnv()),
  });
}

export async function getCachedHealth(): Promise<ClusterHealth> {
  return readThroughCache({
    key: CACHE_KEY_HEALTH,
    ttlMs: TTL_MS[CACHE_KEY_HEALTH],
    payloadSchema: ClusterHealthSchema,
    fetchLive: () => cluster.getHealth(GarageClient.fromEnv()),
  });
}

/**
 * Wrapped in an object rather than stored as a bare number, so every row in the
 * collection holds a JSON object and `payload` has one shape.
 */
const ReplicationFactorPayloadSchema = z.object({
  replicationFactor: z.number().int().min(1),
});

export async function getCachedReplicationFactor(): Promise<number> {
  const payload = await readThroughCache({
    key: CACHE_KEY_REPLICATION_FACTOR,
    ttlMs: TTL_MS[CACHE_KEY_REPLICATION_FACTOR],
    payloadSchema: ReplicationFactorPayloadSchema,
    fetchLive: async () => ({
      replicationFactor: await cluster.getReplicationFactor(
        GarageClient.fromEnv()
      ),
    }),
  });
  return payload.replicationFactor;
}
