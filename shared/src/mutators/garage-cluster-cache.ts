import { RecordService } from 'pocketbase';
import {
  type GarageClusterCache,
  type GarageClusterCacheInput,
  GarageClusterCacheInputSchema,
} from '../schema/garage-cluster-cache';
import type { TypedPocketBase } from '../types';
import { BaseMutator, type MutatorOptions } from './base';

/** Escape a value for interpolation into a PocketBase filter string. */
function quote(value: string): string {
  return value.replace(/"/g, '');
}

/**
 * Read/write access to the last-known Garage cluster responses.
 *
 * Every rule on the collection is null, so this only works through a superuser
 * client — which is deliberate; see the schema notes. The mutator is used
 * exclusively by webapp/src/lib/garage/cached.ts.
 */
export class GarageClusterCacheMutator extends BaseMutator<
  GarageClusterCache,
  GarageClusterCacheInput
> {
  constructor(pb: TypedPocketBase, options?: Partial<MutatorOptions>) {
    super(pb, options);
  }

  protected getCollection(): RecordService<GarageClusterCache> {
    return this.pb.collection('GarageClusterCache');
  }

  protected async validateInput(
    input: GarageClusterCacheInput
  ): Promise<GarageClusterCacheInput> {
    return GarageClusterCacheInputSchema.parse(input);
  }

  /** The stored row for a cache key, or null if nothing has been cached yet. */
  async findByKey(key: string): Promise<GarageClusterCache | null> {
    return this.getFirstByFilter(`key = "${quote(key)}"`);
  }

  /**
   * Write a payload under its natural key.
   *
   * `BaseMutator.upsert` keys on the record id, which a caller holding only a
   * cache key does not have — hence this one. The create branch is wrapped
   * because two processes can miss the same key at the same moment: the unique
   * index rejects the loser, which then re-reads the winner's row and updates
   * it. Last write wins, and both are fresh, so which one wins does not matter.
   */
  async upsertByKey(
    key: string,
    payload: Record<string, unknown>,
    fetchedAt: string
  ): Promise<GarageClusterCache> {
    const existing = await this.findByKey(key);
    if (existing) {
      return this.update(existing.id, {
        payload,
        fetched_at: fetchedAt,
      } as Partial<GarageClusterCache>);
    }

    try {
      return await this.create({ key, payload, fetched_at: fetchedAt });
    } catch (err) {
      const raced = await this.findByKey(key);
      if (!raced) throw err;
      return this.update(raced.id, {
        payload,
        fetched_at: fetchedAt,
      } as Partial<GarageClusterCache>);
    }
  }
}
