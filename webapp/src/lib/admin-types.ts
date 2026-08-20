/**
 * Shapes the admin console pages share.
 *
 * These were previously redeclared in each page, which is how `/admin/users`
 * and `/admin/claims` ended up disagreeing about what a user's "granted"
 * figure means. One declaration means the compiler finds every consumer when
 * the payload changes.
 */
import type { ClusterLayout } from '@/lib/garage';
import type { StagedRoleChangeLike } from '@/lib/cluster/staged-changes';

/** Just enough to identify a user — for pickers and lookups. */
export interface AdminUserRef {
  id: string;
  email: string;
  name?: string;
}

/**
 * A user as served by `GET /next-api/garage/users`, including their complete
 * storage position.
 *
 * `net_granted_gb` is the number to show as "granted": claims on nodes still in
 * the layout, plus transfers received, minus transfers sent. It is the same
 * `netGrantedGb` the user sees on their own dashboard.
 */
export interface AdminUser extends AdminUserRef {
  claims_gb: number;
  sent_gb: number;
  received_gb: number;
  net_granted_gb: number;
  allocated_gb: number;
  available_gb: number;
  used_bytes: number;
  created?: string;
}

/** `GET /next-api/garage/cluster/layout` — the layout plus its replication factor. */
export interface LayoutResponse extends ClusterLayout {
  replicationFactor: number;
}

/**
 * `GET|POST /next-api/garage/cluster/staging` — the layout, what is staged on
 * it, and the nodes a change may name.
 *
 * Every `id` in here is a **node key**: the route key-reduces the roles, the
 * staged changes and the candidate list alike, and resolves a key back to the
 * full id server-side against a live read.
 */
export interface StagingCandidate {
  id: string;
  name: string | null;
  /** `null` for a node Garage can see that has no role yet. */
  zone: string | null;
  inLayout: boolean;
  isUp: boolean;
}

export interface StagingRolePayload {
  id: string;
  zone: string;
  /** `null` is a gateway — Garage's own encoding, not "unknown". */
  capacity: number | null;
  tags: string[];
}

export interface StagingPayload {
  version: number;
  replicationFactor: number;
  parameters?: ClusterLayout['parameters'];
  partitionSize?: number;
  roles: StagingRolePayload[];
  staged: StagedRoleChangeLike[];
  /** Echoed back on a stage request; a mismatch server-side is a 409. */
  stagedFingerprint: string;
  stagedParametersPending: boolean;
  candidates: StagingCandidate[];
  fetchedAt: string;
  /** POST only: false when the change staged but the timeline row did not. */
  logged?: boolean;
}

/** One change as the browser submits it. Capacity is in **bytes**, SI. */
export type StageChangeRequest =
  | { action: 'remove'; nodeId: string }
  | {
      action: 'assign';
      nodeId: string;
      zone: string;
      gateway: boolean;
      capacityBytes: number | null;
      tags: string[];
    };

/** `GET /next-api/garage/cluster/layout-history` — counts, never timestamps. */
export interface LayoutHistoryPayload {
  currentVersion: number;
  minAck: number;
  versions: {
    version: number;
    status: 'Current' | 'Draining' | 'Historical';
    storageNodes: number;
    gatewayNodes: number;
  }[];
}
