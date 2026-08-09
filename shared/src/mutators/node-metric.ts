import { RecordService } from 'pocketbase';
import type { ListResult } from 'pocketbase';
import {
  type NodeMetric,
  type NodeMetricInput,
  NodeMetricInputSchema,
} from '../schema/node-metric';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/** Filters for browsing the metrics history. Every field is optional. */
export interface NodeMetricQuery {
  nodeId?: string;
  /** PB-format UTC timestamp ("YYYY-MM-DD HH:mm:ss.sssZ"), server-generated. */
  since?: string;
}

/**
 * Read access to the per-node metrics history.
 *
 * Read-only in practice: the rows are written by the `node-metrics-scrape`
 * cron in pb_hooks/main.pb.js via the JSVM layer, and the collection's write
 * rules are null, so `create`/`update`/`delete` inherited from BaseMutator
 * would be rejected by PocketBase. Nothing in the app should call them.
 *
 * The admin charts page does not read through here either — it uses the
 * bucketed `/api/node-metrics/history` PB route (proxied by
 * /next-api/garage/node-metrics), which aggregates in-process instead of
 * paging tens of thousands of raw rows over HTTP.
 */
export class NodeMetricMutator extends BaseMutator<
  NodeMetric,
  NodeMetricInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<NodeMetric> {
    return this.pb.collection('NodeMetrics');
  }

  protected setDefaults(): MutatorOptions {
    return {
      expand: [],
      filter: [],
      sort: ['-created'],
    };
  }

  protected async validateInput(
    input: NodeMetricInput
  ): Promise<NodeMetricInput> {
    return NodeMetricInputSchema.parse(input);
  }

  /** Paged, filtered browse, newest first. */
  async search(
    page: number,
    perPage: number,
    query: NodeMetricQuery = {}
  ): Promise<ListResult<NodeMetric>> {
    const filters: string[] = [];
    if (query.nodeId) filters.push(`node_id = "${query.nodeId}"`);
    if (query.since) filters.push(`created >= "${query.since}"`);
    return this.getList(page, perPage, filters);
  }
}
