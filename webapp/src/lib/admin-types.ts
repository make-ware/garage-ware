/**
 * Shapes the admin console pages share.
 *
 * These were previously redeclared in each page, which is how `/admin/users`
 * and `/admin/claims` ended up disagreeing about what a user's "granted"
 * figure means. One declaration means the compiler finds every consumer when
 * the payload changes.
 */
import type { ClusterLayout } from '@/lib/garage';

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
