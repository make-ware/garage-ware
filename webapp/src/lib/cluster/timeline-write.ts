import 'server-only';
import type {
  ClusterEventCategory,
  ClusterEventKind,
  ClusterEventSeverity,
} from '@garage-ware/shared';
import { getPbAsSuperuser } from '@/lib/auth/server';

/**
 * Append one `source: 'action'` row to the cluster timeline — a record that a
 * named human pressed a button, as distinct from the detector's observations
 * and an admin's hand-written notes.
 *
 * ClusterEvents' write rules are all null, so this authenticates as a superuser.
 *
 * **It never throws.** Every caller has already changed the cluster (or the
 * database) by the time it runs, and there is nothing to roll back to: failing
 * the request would tell the operator their action did not happen and invite
 * them to repeat it. Callers surface the boolean as `logged` instead. Same
 * trade the StorageInvites email hook makes for the same reason.
 */
export interface TimelineActionRow {
  kind: ClusterEventKind;
  /** Empty for a cluster-scoped event. */
  nodeId: string;
  title: string;
  severity: ClusterEventSeverity;
  category?: ClusterEventCategory;
  detail?: string;
  /** Raw values only — the UI formats by `kind`, never the other way round. */
  previousValue?: string;
  newValue?: string;
  actorId: string;
  actorEmail: string;
  /** Prefix for the console line when the write fails. */
  logLabel: string;
}

export async function writeTimelineActionRow(
  input: TimelineActionRow
): Promise<boolean> {
  // `ended_at` equals `occurred_at`, for two reasons. It is honest — the action
  // is the instant being recorded, and these actions have no knowable duration,
  // so claiming one would be a fabrication. And it is belt and braces against
  // the "under repair" marker: that state is `source = "manual" && ended_at =
  // ""`, which `source: 'action'` already excludes, but a row closed the moment
  // it opens cannot be caught by a future query keying on `ended_at` alone.
  const occurredAt = new Date().toISOString();
  try {
    const pb = await getPbAsSuperuser();
    await pb.collection('ClusterEvents').create({
      kind: input.kind,
      source: 'action',
      severity: input.severity,
      category: input.category ?? 'maintenance',
      node_id: input.nodeId,
      node_hostname: '',
      node_zone: '',
      // No node name in the title: the timeline resolves names live from the
      // layout via <NodeIdentity>, and this repo never denormalizes one onto a
      // row.
      title: input.title,
      detail: input.detail ?? '',
      previous_value: input.previousValue ?? '',
      new_value: input.newValue ?? '',
      occurred_at: occurredAt,
      ended_at: occurredAt,
      actor_id: input.actorId,
      actor_email: input.actorEmail,
    });
    return true;
  } catch (err) {
    console.error(`${input.logLabel} timeline row failed`, err);
    return false;
  }
}
