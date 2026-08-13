import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type ClusterEvent,
  type ClusterEventCategory,
  type ClusterEventInput,
  ClusterEventInputSchema,
  type ClusterEventKind,
  type ClusterEventSeverity,
  type ClusterEventSource,
} from '../schema/cluster-event';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/**
 * PocketBase filters are string-interpolated here as everywhere else in this
 * directory; this collection is the one that takes free text and dates from a
 * query string, so strip the character that would end the literal.
 */
function quote(value: string): string {
  return value.replace(/"/g, '');
}

/** Filters for the admin timeline. Every field is optional. */
export interface ClusterEventQuery {
  nodeId?: string;
  kind?: ClusterEventKind;
  source?: ClusterEventSource;
  severity?: ClusterEventSeverity;
  category?: ClusterEventCategory;
  /** Inclusive lower bound on `occurred_at`, as a PB date string. */
  since?: string;
  /** Inclusive upper bound on `occurred_at`, as a PB date string. */
  until?: string;
}

/**
 * Read access to the cluster timeline.
 *
 * Read-only in practice, like StorageClaimAuditMutator: the collection's write
 * rules are all null, so the inherited `create`/`update`/`delete` would be
 * rejected for any caller but a superuser. Detector rows are written by
 * pb_hooks/lib/cluster-events.js through the JSVM; manual rows and annotations
 * go through /next-api/garage/events, which authenticates as a superuser.
 *
 * Sorted by `occurred_at`, not `created` — a note written today about last
 * Tuesday belongs on last Tuesday.
 */
export class ClusterEventMutator extends BaseMutator<
  ClusterEvent,
  ClusterEventInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<ClusterEvent> {
    return this.pb.collection('ClusterEvents');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-occurred_at', '-created'],
    };
  }

  protected async validateInput(
    input: ClusterEventInput
  ): Promise<ClusterEventInput> {
    return ClusterEventInputSchema.parse(input);
  }

  /**
   * Open manual rows — the ones that put a node "under repair". Cluster-wide
   * notes are included; the caller keys by `node_id` and ignores the blanks.
   */
  async listOpenManual(): Promise<ListResult<ClusterEvent>> {
    return this.getList(1, 200, ['source = "manual"', 'ended_at = ""']);
  }

  /** Paged, filtered browse for /admin/events. */
  async search(
    page: number,
    perPage: number,
    query: ClusterEventQuery = {}
  ): Promise<ListResult<ClusterEvent>> {
    const filters: string[] = [];
    if (query.nodeId) filters.push(`node_id = "${quote(query.nodeId)}"`);
    if (query.kind) filters.push(`kind = "${query.kind}"`);
    if (query.source) filters.push(`source = "${query.source}"`);
    if (query.severity) filters.push(`severity = "${query.severity}"`);
    if (query.category) filters.push(`category = "${query.category}"`);
    if (query.since) filters.push(`occurred_at >= "${quote(query.since)}"`);
    if (query.until) filters.push(`occurred_at <= "${quote(query.until)}"`);
    return this.getList(page, perPage, filters);
  }
}
