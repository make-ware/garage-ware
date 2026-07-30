import 'server-only';
import { z } from 'zod';
import { GarageClient } from './client';
import {
  ClusterHealthSchema,
  ClusterLayoutSchema,
  ClusterStatisticsSchema,
  ClusterStatusSchema,
  type ClusterHealth,
  type ClusterLayout,
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
