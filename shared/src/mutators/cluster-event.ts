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
  /**
   * Open conditions or finished ones. `ended_at = ""` means unresolved for
   * every source — see the field's docblock; `resolved` therefore also matches
   * the point-in-time rows, which are born closed.
   */
  status?: 'ongoing' | 'resolved';
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
   * Every unresolved row, whatever wrote it — an admin's open note (which puts
   * a node "under repair") and the detector's open conditions alike.
   *
   * **One predicate, not one per source.** `ended_at = ""` means unresolved
   * across the whole collection now that point-in-time rows are born closed and
   * 1787800000_close_legacy_events.js has said the same of the history. This
   * used to filter `source = "manual"` because that was the only source that
   * ever left a row open; keeping the filter would have hidden every detected
   * outage from the cluster map, which is the surface that most wants one.
   *
   * Callers key by `node_id` and ignore the blanks — a cluster-wide note has
   * none — and split on `source` for wording, since "under repair" is a human
   * saying so and an open `node_state` row is not.
   *
   * Deliberately unwindowed: an outage that has been running for six weeks is
   * exactly the one worth flagging. `(source, ended_at)` is indexed for it.
   */
  async listOpen(): Promise<ListResult<ClusterEvent>> {
    return this.getList(1, 200, ['ended_at = ""']);
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
    if (query.status)
      filters.push(
        query.status === 'ongoing' ? 'ended_at = ""' : 'ended_at != ""'
      );
    return this.getList(page, perPage, filters);
  }
}
