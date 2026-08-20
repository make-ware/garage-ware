/**
 * A client-side reimplementation of Garage's cluster layout assignment, so an
 * admin can see what a change would do **before** making it.
 *
 * ## Why this is a reimplementation and not a call to Garage
 *
 * Garage does expose a preview — `PreviewClusterLayoutChanges` — but it only
 * operates on changes that have already been **staged**, and there is no safe
 * undo: `RevertClusterLayout` clears the staging area by *incrementing the
 * layout version*. So "let me just preview it" would leave a permanent mark on
 * the operator's cluster, and a planner built on it would be a mutation tool
 * wearing a read-only label. Nothing in this module talks to Garage, and
 * nothing that imports it may either — the whole what-if lives in the browser.
 *
 * ## What is exact and what is an approximation
 *
 * The result type carries the distinction rather than a comment carrying it:
 *
 * - **`exact`** — the partition size, and therefore effective cluster capacity
 *   and total usable bytes. These are the solution to a max-flow feasibility
 *   problem that has a closed form (below), and reproduce Garage's own
 *   `partitionSize` for a given set of roles. The planner checks that claim
 *   against the operator's live cluster on every page load.
 * - **`estimated`** — the per-node and per-zone partition split. This one is
 *   *provably* not reproducible in general: Garage picks among the optimal
 *   assignments with `optimize_flow_with_cost`, a negative-cycle-cancelling
 *   heuristic bounded by cycle length, and its cost function charges +1 only
 *   for a (partition, node) pair that was not previously assigned. In the
 *   documented Example 2 every split of dc3's 256 partitions with
 *   `node3 ∈ [128, 256]` has cost exactly 0 — 193/63, 128/128 and this
 *   module's answer are all optima. Chasing Garage's particular tie-break
 *   would be fitting to an implementation detail.
 *
 * Field names carry it too: `estimatedPartitions`, `estimatedUsableBytes`,
 * `exactPartitionSizeBytes`. A call site cannot pick up an estimate believing
 * it is a measurement without typing the word.
 *
 * ## The algorithm
 *
 * Garage divides data into {@link PARTITION_COUNT} partitions and stores each
 * on `replicationFactor` nodes spread across as many distinct zones as the
 * zone-redundancy parameter demands. Node capacity is a **weight**, not a
 * limit. Internally it builds one flow graph per partition —
 *
 * ```
 *   Source → Pup(p)        capacity k          (replicas that must be in distinct zones)
 *   Source → Pdown(p)      capacity rf − k     (the remainder, zone-unconstrained)
 *   Pup(p)  → PZ(p, z)     capacity 1
 *   Pdown(p)→ PZ(p, z)     capacity rf
 *   PZ(p,z) → N(n)         capacity 1          (n ∈ z)
 *   N(n)    → Sink         capacity ⌊cap_n / P⌋
 * ```
 *
 * — and binary-searches the largest partition size `P` whose max-flow equals
 * `PARTITION_COUNT · rf`. `k` is the *effective zone redundancy*:
 * `atLeast`'s value, or `min(storageZones, rf)` under `maximum`.
 *
 * ### Step 1 — partition size, in closed form
 *
 * All {@link PARTITION_COUNT} partitions are structurally identical, so the
 * whole graph collapses to three per-zone quantities:
 *
 * ```
 *   c_n = min(⌊cap_n / P⌋, PARTITION_COUNT)        // gateways and 0-capacity → 0
 *   m_z = min(#{ n ∈ z : c_n ≥ 1 }, rf − k + 1)    // replicas one zone may hold
 *   C_z = Σ_{n ∈ z} c_n
 *
 *   feasible(P)  ⇔  Σ_z min(C_z, PARTITION_COUNT · m_z)  ≥  PARTITION_COUNT · rf
 * ```
 *
 * This **equals** the max-flow value. One direction is the cut; the other is
 * symmetry: take any aggregate `s_z ≤ min(C_z, 256·m_z)` with `Σ s_z = 256·rf`,
 * scale it down by 1/256 to a per-partition `t_z`, and every per-partition
 * constraint holds — `t_z ≤ rf − k + 1` with `Σ t_z = rf` forces
 * `Σ min(t_z, 1) ≥ k`, which is exactly the distinct-zone requirement. Flow
 * integrality closes it. `layout-sim.test.ts` verifies the equality against a
 * literal Ford–Fulkerson oracle over the graph above, because this shortcut is
 * the whole reason no flow solver ships to the browser.
 *
 * Three terms in that formula are easy to drop and each produces confident
 * garbage:
 *
 * 1. **`min(·, PARTITION_COUNT)` per node** — a node holds at most one replica
 *    of any given partition. Without it, rf=3 across two enormous nodes reports
 *    feasible at every `P` and the planner invents unbounded capacity.
 * 2. **The node-count term in `m_z`** — a one-node zone can never supply more
 *    than `PARTITION_COUNT` replicas however large its disk.
 * 3. **`rf − k + 1`, used unconditionally** — not `ceil(rf / zoneCount)`. They
 *    coincide at rf=3 and diverge at rf=5 over 2 zones, where a partition
 *    legitimately puts 4 replicas in one zone and 1 in the other.
 *
 * ### Steps 2 and 3 — where the partitions land
 *
 * {@link distribute} runs twice: once over zones (capacity
 * `min(C_z, 256·m_z)`, total `256·rf`), then once per zone over that zone's
 * nodes (capacity `c_n`, total the zone's share). **Both levels seed from the
 * previous layout.** Seeding only the node level lets the zone step invent
 * movement the node step must then absorb, and `partitionsMoved` reports
 * traffic that would never happen.
 *
 * That seeding is what reproduces the documented Example 1 exactly: a fourth
 * 1000 MB node added to dc1 in a 3-zone cluster receives **0 partitions**,
 * because dc1's 256 replicas are already covered by the incumbent's seed and
 * moving any of them buys no capacity — the other zones still bound the total.
 *
 * ---
 *
 * **Hazard — this module is display-only, and the guard is structural.** The
 * same rule `lib/metrics/data-coverage.ts` carries, for the same reason:
 * `storedPartitions × partitionSize` is a strictly *better* answer to "how much
 * of this node is usable" than `capacity / replicationFactor`, and routinely a
 * lower one. The per-node claim invariant is *defined* on the latter and
 * enforced by `assertClaimDeltaAllowed`; substituting this module's figure
 * would silently revalue every node's ceiling downward and could retroactively
 * invalidate existing claims. So it stays in **bytes**, never GB, with no `gb`
 * in any identifier and none of `lib/storage/units.ts`'s `gb*` helpers imported
 * — the ledger speaks GB, so a bytes-named value crossing into it is visible.
 * `layout-sim-boundary.test.ts` asserts that nothing in the accounting path
 * imports this file, so the rule survives people who have never read it.
 */

/** Partitions the ring is divided into. Fixed in Garage; not a parameter. */
export const PARTITION_COUNT = 256;

/**
 * Zone usable/declared ratio below which the planner calls a zone
 * over-declared — the Example-1 shape, where capacity has been handed to
 * Garage that no amount of rebalancing can reach.
 *
 * 0.9 rather than something tighter: a heterogeneous cluster legitimately
 * wastes a few percent to integer partition counts, and a warning that fires on
 * a healthy cluster is a warning operators learn to scroll past. Exported so
 * the UI copy, the detection and the tests cannot drift — the convention
 * `data-coverage.ts` already follows.
 */
export const ZONE_OVER_DECLARED_RATIO = 0.9;

/** One node as the planner describes it — a real role, or a hypothetical. */
export interface SimNodeInput {
  /**
   * Node key for a node already in the layout, or a synthetic draft id for one
   * that does not exist yet. Never a full 64-character node id: this module
   * runs in the browser, and the full id is a credential.
   */
  id: string;
  zone: string;
  /**
   * Declared capacity in **bytes**. `null` marks a gateway. `0` is accepted and
   * behaves like a gateway for the arithmetic, but is reported as a storage
   * node — the form rejects it, and it should not be mistaken for one.
   */
  capacityBytes: number | null;
}

/**
 * Garage's `zoneRedundancy` layout parameter, in the two shapes the admin API
 * uses.
 */
export type SimZoneRedundancy =
  { mode: 'maximum' } | { mode: 'atLeast'; atLeast: number };

export interface SimInput {
  nodes: readonly SimNodeInput[];
  replicationFactor: number;
  zoneRedundancy: SimZoneRedundancy;
  /**
   * Baseline partition counts by node id — Garage's own numbers where they are
   * trustworthy, otherwise a simulation of the unmodified layout. Absent means
   * "assign from scratch": every delta is then `null` rather than a made-up
   * zero, because a fabricated baseline produces a fabricated
   * {@link SimSuccess.estimated.partitionsMoved}, and that is the number an
   * operator would act on.
   */
  previous?: Readonly<Record<string, number>>;
}

export interface SimNodeResult {
  id: string;
  zone: string;
  /** No declared capacity at all — Garage stores nothing on it by definition. */
  gateway: boolean;
  declaredCapacityBytes: number | null;
  estimatedPartitions: number;
  estimatedUsableBytes: number;
  /** Usable as a percentage of declared; `null` for a gateway or 0 capacity. */
  estimatedUsablePct: number | null;
  /** The node's `c_n`: the most partitions it could hold at this partition size. */
  maxPartitions: number;
  previousPartitions: number | null;
  /** Signed change from the baseline; `null` when there is no baseline. */
  partitionDelta: number | null;
}

export interface SimZoneResult {
  zone: string;
  /** Nodes with a declared capacity, gateways excluded. */
  storageNodeCount: number;
  declaredCapacityBytes: number;
  estimatedPartitions: number;
  estimatedUsableBytes: number;
  estimatedUsablePct: number | null;
  /** `m_z` — replicas of any one partition this zone may hold. */
  replicasPerPartition: number;
  /** `min(C_z, PARTITION_COUNT · m_z)` — the zone's ceiling in partitions. */
  maxPartitions: number;
  /**
   * Would the cluster's partition size grow if this zone alone had unbounded
   * capacity? This is the panel `garage layout show` cannot give you: the
   * answer to *why* the partition size is what it is. False for every zone
   * means no single zone is the constraint and more than one has to grow.
   */
  limiting: boolean;
  previousPartitions: number | null;
  partitionDelta: number | null;
}

export type SimWarningKind = 'zero-partition-node' | 'zone-over-declared';

export interface SimWarning {
  kind: SimWarningKind;
  /** Node id for `zero-partition-node`, zone name for `zone-over-declared`. */
  subject: string;
  zone: string;
  declaredCapacityBytes: number;
  usableCapacityBytes: number;
}

export type SimFailureReason =
  | 'not-enough-nodes'
  | 'not-enough-zones'
  | 'invalid-redundancy'
  | 'capacity-too-small'
  | 'capacity-out-of-range';

/**
 * Why no layout exists. Deliberately counts only — **no capacity figures.** An
 * infeasible topology must render no numbers at all, because a partition size
 * or a usable total beside "this cannot work" is the one thing an operator
 * would copy down.
 */
export interface SimFailureDetail {
  storageNodeCount: number;
  storageZoneCount: number;
  replicationFactor: number;
  /** The `k` that was asked for, where one was named. */
  requestedZoneRedundancy: number | null;
}

export interface SimFailure {
  ok: false;
  reason: SimFailureReason;
  detail: SimFailureDetail;
}

export interface SimSuccess {
  ok: true;
  /** Reproduces Garage exactly — see the module docblock. */
  exact: {
    partitionSizeBytes: number;
    /** Data the cluster can hold, once: `PARTITION_COUNT · P`. */
    effectiveCapacityBytes: number;
    /** Disk that data occupies across every replica: `PARTITION_COUNT · rf · P`. */
    totalUsableBytes: number;
    totalDeclaredBytes: number;
    effectiveZoneRedundancy: number;
    replicationFactor: number;
  };
  /** An approximation of Garage's tie-break — see the module docblock. */
  estimated: {
    nodes: SimNodeResult[];
    zones: SimZoneResult[];
    /**
     * `Σ max(0, delta)` — a **lower bound** on the movement this change costs.
     * A node whose count is unchanged can still swap which partitions it holds,
     * and no aggregate can see that. `null` without a baseline.
     */
    partitionsMoved: number | null;
  };
  warnings: SimWarning[];
}

export type SimResult = SimSuccess | SimFailure;

/** A storage node reduced to what the feasibility test reads. */
interface StorageEntry {
  id: string;
  zone: string;
  capacityBytes: number;
}

/**
 * `⌊cap / p⌋`, corrected for IEEE-754.
 *
 * `Math.floor(a / b)` on doubles can land one either side of the true quotient
 * for large operands. At the binary-search boundary an off-by-one in `q` is an
 * off-by-one in the partition size, which shifts every usable figure the
 * planner prints — so the correction is explicit rather than trusted.
 */
function floorDiv(cap: number, p: number): number {
  let q = Math.floor(cap / p);
  if ((q + 1) * p <= cap) q++;
  else if (q * p > cap) q--;
  return q;
}

/** `c_n` at partition size `p`, with `overrideZone`'s nodes treated as unbounded. */
function nodeCapacityInPartitions(
  entry: StorageEntry,
  p: number,
  partitionCount: number,
  unboundedZone?: string
): number {
  if (unboundedZone !== undefined && entry.zone === unboundedZone) {
    return partitionCount;
  }
  return Math.min(floorDiv(entry.capacityBytes, p), partitionCount);
}

function feasibleForEntries(
  entries: readonly StorageEntry[],
  replicationFactor: number,
  effectiveZoneRedundancy: number,
  partitionSizeBytes: number,
  partitionCount: number,
  unboundedZone?: string
): boolean {
  const zoneReplicaCap =
    replicationFactor - effectiveZoneRedundancy + 1; /* rf − k + 1 */
  const byZone = new Map<string, { sum: number; eligible: number }>();
  for (const entry of entries) {
    const c = nodeCapacityInPartitions(
      entry,
      partitionSizeBytes,
      partitionCount,
      unboundedZone
    );
    const acc = byZone.get(entry.zone) ?? { sum: 0, eligible: 0 };
    acc.sum += c;
    if (c >= 1) acc.eligible += 1;
    byZone.set(entry.zone, acc);
  }
  let supply = 0;
  for (const { sum, eligible } of byZone.values()) {
    const m = Math.min(eligible, zoneReplicaCap);
    supply += Math.min(sum, partitionCount * m);
  }
  return supply >= partitionCount * replicationFactor;
}

/**
 * Can the cluster be laid out with partitions of exactly this size?
 *
 * Exported for the max-flow oracle in the tests, which needs to drive the same
 * predicate at a small `partitionCount` so a literal Ford–Fulkerson over the
 * graph in the module docblock terminates. Nothing in the app calls it
 * directly — {@link simulateLayout} owns the binary search.
 */
export function isPartitionSizeFeasible(
  nodes: readonly SimNodeInput[],
  replicationFactor: number,
  effectiveZoneRedundancy: number,
  partitionSizeBytes: number,
  partitionCount: number = PARTITION_COUNT
): boolean {
  return feasibleForEntries(
    storageEntries(nodes),
    replicationFactor,
    effectiveZoneRedundancy,
    partitionSizeBytes,
    partitionCount
  );
}

/** Nodes that declare capacity. Gateways and 0-capacity nodes are not storage. */
function storageEntries(nodes: readonly SimNodeInput[]): StorageEntry[] {
  const out: StorageEntry[] = [];
  for (const n of nodes) {
    if (n.capacityBytes === null || n.capacityBytes <= 0) continue;
    out.push({ id: n.id, zone: n.zone, capacityBytes: n.capacityBytes });
  }
  return out;
}

/**
 * The largest feasible partition size, or `null` when even 1 byte is too big.
 *
 * `hi` is `⌊total / (256·rf)⌋ + 1`, which is provably infeasible — at that size
 * `Σ_n ⌊cap_n / P⌋ ≤ total / P < 256·rf` — and far tighter than searching to
 * the total capacity. Monotonicity survives the node-count term in `m_z`
 * (`P↑ ⇒ c_n↓ ⇒ eligible↓ ⇒ m_z↓ ⇒ supply↓`), and the tests brute-force it
 * rather than take the argument on trust.
 */
function solvePartitionSize(
  entries: readonly StorageEntry[],
  replicationFactor: number,
  effectiveZoneRedundancy: number
): number | null {
  const feasible = (p: number) =>
    feasibleForEntries(
      entries,
      replicationFactor,
      effectiveZoneRedundancy,
      p,
      PARTITION_COUNT
    );
  if (!feasible(1)) return null;
  const total = entries.reduce((sum, e) => sum + e.capacityBytes, 0);
  let lo = 1;
  let hi = Math.floor(total / (PARTITION_COUNT * replicationFactor)) + 1;
  while (lo + 1 < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (feasible(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Split `amount` across `weights` by largest remainder, ties broken on
 * `tieKey` so the output does not depend on input order.
 */
function apportion(
  amount: number,
  weights: readonly number[],
  tieKey: readonly string[]
): number[] {
  const out = weights.map(() => 0);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  if (amount <= 0 || totalWeight <= 0) return out;

  const fractions: { index: number; fraction: number }[] = [];
  let assigned = 0;
  for (let i = 0; i < weights.length; i++) {
    const exact = (amount * weights[i]) / totalWeight;
    const base = Math.floor(exact);
    out[i] = base;
    assigned += base;
    fractions.push({ index: i, fraction: exact - base });
  }
  // Every fraction is < 1 and they sum to the remainder, so the remainder can
  // never exceed the count of *positive* fractions — a zero-weight participant
  // sorts last and is never reached.
  fractions.sort(
    (a, b) =>
      b.fraction - a.fraction || compareKeys(tieKey[a.index], tieKey[b.index])
  );
  let remainder = amount - assigned;
  for (let i = 0; remainder > 0 && i < fractions.length; i++, remainder--) {
    out[fractions[i].index]++;
  }
  return out;
}

function compareKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Place exactly `total` units across participants capped at `cap`, starting
 * from `seed` and moving as little as possible.
 *
 * Clamp the seed into `[0, cap]`; if short, fill proportional to remaining
 * headroom; if over, shed proportional to what each holds. Apportionment is
 * largest-remainder so the sum is exact in one pass — `|diff| ≤ Σ weights`
 * always holds here, which is what makes a single round sufficient. The loop
 * and the trailing single-unit sweep are belt-and-braces, and the
 * postconditions are asserted rather than assumed: a silent violation here
 * reads downstream as a capacity figure, not as a bug.
 *
 * Used twice — over zones, then over each zone's nodes — because "minimal
 * movement subject to a cap" is the same problem at both levels, and two
 * implementations would be two implementations that disagree.
 */
function distribute(
  seed: readonly number[],
  cap: readonly number[],
  total: number,
  tieKey: readonly string[]
): number[] {
  const n = cap.length;
  const x = cap.map((c, i) =>
    Math.max(0, Math.min(c, Math.round(seed[i] ?? 0)))
  );

  for (let round = 0; round <= n + 1; round++) {
    const sum = x.reduce((a, b) => a + b, 0);
    const diff = total - sum;
    if (diff === 0) break;
    const weights = diff > 0 ? x.map((value, i) => cap[i] - value) : x.slice();
    const shares = apportion(Math.abs(diff), weights, tieKey);
    for (let i = 0; i < n; i++) {
      const step = Math.min(shares[i], weights[i]);
      x[i] += diff > 0 ? step : -step;
    }
  }

  const order = x
    .map((_, i) => i)
    .sort((a, b) => compareKeys(tieKey[a], tieKey[b]));
  let sum = x.reduce((a, b) => a + b, 0);
  while (sum < total) {
    const i = order.find((j) => x[j] < cap[j]);
    if (i === undefined) break;
    x[i]++;
    sum++;
  }
  while (sum > total) {
    const i = order.find((j) => x[j] > 0);
    if (i === undefined) break;
    x[i]--;
    sum--;
  }

  if (sum !== total) {
    throw new Error(
      `layout-sim: distribute could not place ${total} units (placed ${sum})`
    );
  }
  for (let i = 0; i < n; i++) {
    if (!Number.isInteger(x[i]) || x[i] < 0 || x[i] > cap[i]) {
      throw new Error(
        `layout-sim: distribute produced ${x[i]} outside [0, ${cap[i]}]`
      );
    }
  }
  return x;
}

/**
 * Simulate what Garage would do with this set of nodes.
 *
 * Pure, synchronous and cheap enough to run from a `useMemo` on every
 * keystroke — the whole point of the closed form in the docblock is that no
 * flow solver runs in the browser.
 */
export function simulateLayout(input: SimInput): SimResult {
  const { nodes, replicationFactor, zoneRedundancy, previous } = input;

  const entries = storageEntries(nodes);
  const storageZones = [...new Set(entries.map((e) => e.zone))];
  const requestedZoneRedundancy =
    zoneRedundancy.mode === 'atLeast' ? zoneRedundancy.atLeast : null;
  const detail: SimFailureDetail = {
    storageNodeCount: entries.length,
    storageZoneCount: storageZones.length,
    replicationFactor,
    requestedZoneRedundancy,
  };
  const fail = (reason: SimFailureReason): SimFailure => ({
    ok: false,
    reason,
    detail,
  });

  if (
    !Number.isInteger(replicationFactor) ||
    replicationFactor < 1 ||
    entries.length < replicationFactor
  ) {
    return fail('not-enough-nodes');
  }
  // `atLeast` outside [1, rf] is not merely unsatisfiable — `rf − k` is the
  // capacity of the Source→Pdown edge, so a k above rf makes the graph itself
  // meaningless rather than infeasible.
  if (
    requestedZoneRedundancy !== null &&
    (!Number.isInteger(requestedZoneRedundancy) ||
      requestedZoneRedundancy < 1 ||
      requestedZoneRedundancy > replicationFactor)
  ) {
    return fail('invalid-redundancy');
  }
  if (
    requestedZoneRedundancy !== null &&
    storageZones.length < requestedZoneRedundancy
  ) {
    return fail('not-enough-zones');
  }

  const totalDeclaredBytes = entries.reduce(
    (sum, e) => sum + e.capacityBytes,
    0
  );
  // Beyond 2^53 the `floorDiv` correction stops being able to distinguish
  // adjacent integers, so every figure below would be quietly approximate.
  // 9 PB of declared capacity is a real cluster; a wrong answer for it is not
  // better than no answer.
  if (!Number.isFinite(totalDeclaredBytes) || totalDeclaredBytes >= 2 ** 53) {
    return fail('capacity-out-of-range');
  }

  const effectiveZoneRedundancy =
    requestedZoneRedundancy ?? Math.min(storageZones.length, replicationFactor);

  const partitionSizeBytes = solvePartitionSize(
    entries,
    replicationFactor,
    effectiveZoneRedundancy
  );
  if (partitionSizeBytes === null) return fail('capacity-too-small');

  // ── Step 2: partitions per zone ────────────────────────────────────────
  const zoneReplicaCap = replicationFactor - effectiveZoneRedundancy + 1;
  const capacityByNode = new Map<string, number>();
  for (const entry of entries) {
    capacityByNode.set(
      entry.id,
      nodeCapacityInPartitions(entry, partitionSizeBytes, PARTITION_COUNT)
    );
  }

  const zoneNames = [...storageZones].sort(compareKeys);
  const zoneEntries = new Map<string, StorageEntry[]>(
    zoneNames.map((zone) => [zone, []])
  );
  for (const entry of entries) zoneEntries.get(entry.zone)!.push(entry);

  const seedFor = (id: string) => (previous ? (previous[id] ?? 0) : 0);

  const zoneCaps: number[] = [];
  const zoneSeeds: number[] = [];
  const zoneReplicas: number[] = [];
  for (const zone of zoneNames) {
    const inZone = zoneEntries.get(zone)!;
    const eligible = inZone.filter((e) => capacityByNode.get(e.id)! >= 1);
    const sum = inZone.reduce((a, e) => a + capacityByNode.get(e.id)!, 0);
    const m = Math.min(eligible.length, zoneReplicaCap);
    zoneReplicas.push(m);
    zoneCaps.push(Math.min(sum, PARTITION_COUNT * m));
    // Only eligible nodes can carry a seed forward; a node that has just been
    // shrunk below one partition contributes nothing but would otherwise pin
    // partitions to a zone that cannot hold them.
    zoneSeeds.push(eligible.reduce((a, e) => a + seedFor(e.id), 0));
  }

  const zonePartitions = distribute(
    zoneSeeds,
    zoneCaps,
    PARTITION_COUNT * replicationFactor,
    zoneNames
  );

  // ── Step 3: partitions per node, within each zone ──────────────────────
  const partitionsByNode = new Map<string, number>();
  zoneNames.forEach((zone, zi) => {
    const eligible = zoneEntries
      .get(zone)!
      .filter((e) => capacityByNode.get(e.id)! >= 1)
      .sort((a, b) => compareKeys(a.id, b.id));
    const placed = distribute(
      eligible.map((e) => seedFor(e.id)),
      eligible.map((e) => capacityByNode.get(e.id)!),
      zonePartitions[zi],
      eligible.map((e) => e.id)
    );
    eligible.forEach((e, i) => partitionsByNode.set(e.id, placed[i]));
  });

  // ── Results ────────────────────────────────────────────────────────────
  const nodeResults: SimNodeResult[] = nodes.map((node) => {
    const partitions = partitionsByNode.get(node.id) ?? 0;
    const usable = partitions * partitionSizeBytes;
    const declared = node.capacityBytes;
    const previousPartitions = previous ? (previous[node.id] ?? 0) : null;
    return {
      id: node.id,
      zone: node.zone,
      gateway: declared === null,
      declaredCapacityBytes: declared,
      estimatedPartitions: partitions,
      estimatedUsableBytes: usable,
      estimatedUsablePct:
        declared !== null && declared > 0 ? (usable / declared) * 100 : null,
      maxPartitions: capacityByNode.get(node.id) ?? 0,
      previousPartitions,
      partitionDelta:
        previousPartitions === null ? null : partitions - previousPartitions,
    };
  });

  const zoneResults: SimZoneResult[] = zoneNames.map((zone, zi) => {
    const inZone = zoneEntries.get(zone)!;
    const partitions = zonePartitions[zi];
    const usable = partitions * partitionSizeBytes;
    const declared = inZone.reduce((a, e) => a + e.capacityBytes, 0);
    const previousPartitions = previous
      ? inZone.reduce((a, e) => a + (previous[e.id] ?? 0), 0)
      : null;
    return {
      zone,
      storageNodeCount: inZone.length,
      declaredCapacityBytes: declared,
      estimatedPartitions: partitions,
      estimatedUsableBytes: usable,
      estimatedUsablePct: declared > 0 ? (usable / declared) * 100 : null,
      replicasPerPartition: zoneReplicas[zi],
      maxPartitions: zoneCaps[zi],
      // `P` is maximal, so `feasible(P + 1)` is false by construction. This
      // zone is the constraint exactly when removing *its* ceiling alone makes
      // one more byte per partition fit. One boolean, no second search — and
      // no need to bound a growth loop for the rf=1 case, where one unbounded
      // zone would satisfy the whole cluster at every partition size.
      limiting: feasibleForEntries(
        entries,
        replicationFactor,
        effectiveZoneRedundancy,
        partitionSizeBytes + 1,
        PARTITION_COUNT,
        zone
      ),
      previousPartitions,
      partitionDelta:
        previousPartitions === null ? null : partitions - previousPartitions,
    };
  });

  const partitionsMoved = previous
    ? nodeResults.reduce((a, n) => a + Math.max(0, n.partitionDelta ?? 0), 0)
    : null;

  return {
    ok: true,
    exact: {
      partitionSizeBytes,
      effectiveCapacityBytes: PARTITION_COUNT * partitionSizeBytes,
      totalUsableBytes:
        PARTITION_COUNT * replicationFactor * partitionSizeBytes,
      totalDeclaredBytes,
      effectiveZoneRedundancy,
      replicationFactor,
    },
    estimated: {
      nodes: nodeResults,
      zones: zoneResults,
      partitionsMoved,
    },
    warnings: collectWarnings(nodeResults, zoneResults),
  };
}

/**
 * The two shapes worth interrupting an operator for, both **derived from the
 * result** rather than pattern-matched against the documented example.
 *
 * - A storage node with declared capacity that would hold **nothing**. This is
 *   Garage's most surprising documented behaviour: a fourth equal node added to
 *   one zone of a 3-zone cluster stores 0 B, because the other zones still
 *   bound the total and the optimizer will not pay data movement for no
 *   capacity gain.
 * - A zone whose usable capacity falls materially below what it declares
 *   ({@link ZONE_OVER_DECLARED_RATIO}) — the same phenomenon before it reaches
 *   zero, and the reading that tells an operator *where* the wasted disk is.
 */
function collectWarnings(
  nodes: readonly SimNodeResult[],
  zones: readonly SimZoneResult[]
): SimWarning[] {
  const warnings: SimWarning[] = [];
  for (const node of nodes) {
    if (node.gateway) continue;
    const declared = node.declaredCapacityBytes ?? 0;
    if (declared <= 0 || node.estimatedPartitions > 0) continue;
    warnings.push({
      kind: 'zero-partition-node',
      subject: node.id,
      zone: node.zone,
      declaredCapacityBytes: declared,
      usableCapacityBytes: 0,
    });
  }
  for (const zone of zones) {
    if (zone.declaredCapacityBytes <= 0) continue;
    const ratio = zone.estimatedUsableBytes / zone.declaredCapacityBytes;
    if (ratio >= ZONE_OVER_DECLARED_RATIO) continue;
    warnings.push({
      kind: 'zone-over-declared',
      subject: zone.zone,
      zone: zone.zone,
      declaredCapacityBytes: zone.declaredCapacityBytes,
      usableCapacityBytes: zone.estimatedUsableBytes,
    });
  }
  return warnings;
}
