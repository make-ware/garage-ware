import 'server-only';
import { z } from 'zod';
import { GarageClient } from './client';
import {
  ClusterHealthSchema,
  ClusterLayoutHistorySchema,
  ClusterLayoutSchema,
  ClusterStatisticsSchema,
  ClusterStatusSchema,
  type ClusterHealth,
  type ClusterLayout,
  type ClusterLayoutHistory,
  type ClusterStatistics,
  type ClusterStatus,
} from './schemas';

export async function getHealth(client: GarageClient): Promise<ClusterHealth> {
  return client.request('/v2/GetClusterHealth', ClusterHealthSchema);
}

export async function getStatus(client: GarageClient): Promise<ClusterStatus> {
  return client.request('/v2/GetClusterStatus', ClusterStatusSchema);
}

export async function getStatistics(
  client: GarageClient
): Promise<ClusterStatistics> {
  return client.request('/v2/GetClusterStatistics', ClusterStatisticsSchema);
}

export async function getLayout(client: GarageClient): Promise<ClusterLayout> {
  return client.request('/v2/GetClusterLayout', ClusterLayoutSchema);
}

/**
 * A role change to **stage**. `capacity: null` is what makes a node a gateway;
 * a `remove` carries nothing else.
 *
 * `id` is a **full** 64-character node id — the only identifier Garage's layout
 * API accepts. Callers resolve a node key to one through
 * `lib/garage/node-resolve.ts` and never hand a key to this function.
 */
export type RoleChangeRequest =
  | { id: string; remove: true }
  | { id: string; zone: string; capacity: number | null; tags: string[] };

/**
 * Stage role changes. **This is the only layout mutation this app ever makes.**
 *
 * `ApplyClusterLayout`, `RevertClusterLayout` and `ClusterLayoutSkipDeadNodes`
 * are deliberately not wrapped here and must not be — staging alone cannot move
 * a byte of data, while applying moves all of it with no undo. A human runs
 * `garage layout apply` on a cluster host, after reading `garage layout show`.
 * `cluster/staging-boundary.test.ts` fails the build if those operation names
 * appear anywhere under `lib/garage/` or `app/next-api/`.
 *
 * `parameters` is never sent: this app does not stage zone-redundancy changes,
 * and `UpdateClusterLayout` treats an absent `parameters` as "leave them
 * alone". Capacity is in **bytes** — Garage's own unit here, SI, so 100 GB is
 * `100000000000`.
 *
 * Contrary to the CLI, the API requires `zone`, `capacity` **and** `tags`
 * together on an assign: anything omitted is written as empty, which is how a
 * zone-only edit would silently drop a node's `name:` tag. Callers prefill all
 * three.
 *
 * The response is a full `GetClusterLayoutResponse`, so it is strictly fresher
 * than a follow-up read and a caller needs no second call to refresh.
 */
export async function updateLayout(
  client: GarageClient,
  roles: readonly RoleChangeRequest[]
): Promise<ClusterLayout> {
  return client.request('/v2/UpdateClusterLayout', ClusterLayoutSchema, {
    method: 'POST',
    body: { roles },
  });
}

/** Past layout versions — counts only; Garage records no timestamps for them. */
export async function getLayoutHistory(
  client: GarageClient
): Promise<ClusterLayoutHistory> {
  return client.request(
    '/v2/GetClusterLayoutHistory',
    ClusterLayoutHistorySchema
  );
}

/**
 * Replication factor is set in the Garage daemon config (replication_mode).
 * The /health endpoint exposes it via partition counts; we surface it explicitly
 * via /GetClusterStatistics if available, falling back to a sane default.
 *
 * For UI calculations we treat usable_capacity = sum(node.capacity) / replication_factor.
 * When replication factor is unknown we conservatively assume 3.
 */
const ReplicationProbeSchema = z.object({
  replicationFactor: z.number().int().min(1).optional(),
});

export async function getReplicationFactor(
  client: GarageClient
): Promise<number> {
  try {
    const probe = await client.request(
      '/v2/GetClusterStatistics',
      ReplicationProbeSchema.passthrough()
    );
    if (probe.replicationFactor) return probe.replicationFactor;
  } catch {
    // ignore — fall through to default
  }
  return 3;
}
