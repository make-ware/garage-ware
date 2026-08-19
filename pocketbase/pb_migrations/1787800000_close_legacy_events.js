/// <reference path="../pb_data/types.d.ts" />
//
// Close every historical timeline row that was never open.
//
// `ClusterEvents.ended_at` now carries three states in one column:
//
//   ended_at = ""            still open — an unresolved condition
//   ended_at = occurred_at   an instant
//   ended_at > occurred_at   a resolved condition; the pair bounds it
//
// The detector never wrote `ended_at` at all, so by that rule every row it has
// ever written reads as "still open" — the entire history would render "in
// progress" the moment the UI starts honouring the rule, and the reconciliation
// pass in pb_hooks/lib/cluster-events.js would try to resolve conditions that
// were never conditions. This closes them at the instant they happened, which
// is what they always were: the detector simply had no way to say so.
//
// **`source = 'manual'` is excluded, and that exclusion is the whole care in
// this file.** An open manual note is *legitimately* open — it is the "under
// repair" marker, and `ended_at = ""` on it is a live piece of state a human
// set through the log dialog's "still ongoing" checkbox. Closing those would
// silently clear the repair marker on every node in the cluster. `action` rows
// are already born closed (see webapp/src/lib/cluster/timeline-write.ts), so
// the `ended_at = ''` predicate passes over them untouched.
//
// NO SCHEMA OR RULE CHANGES — this is data only, in the shape of
// 1787500000_shorten_node_ids.js. It must run after
// 1787700000_updated_ClusterEvents.js, and ships in the same image as the code
// that depends on it.
//
// Hand-written rather than generated; see 1786200000_updated_Buckets.js for why
// `yarn db:migrate` cannot run at all against this history.
migrate((app) => {
  app
    .db()
    .newQuery(
      "UPDATE `ClusterEvents` SET occurrence_count = 0 WHERE occurrence_count IS NULL"
    )
    .execute();

  app
    .db()
    .newQuery(
      "UPDATE `ClusterEvents` SET ended_at = occurred_at " +
        "WHERE ended_at = '' AND source != 'manual'"
    )
    .execute();
}, (app) => {
  // Deliberately a no-op. Reverting would mean blanking `ended_at` on every
  // non-manual row, which would put the whole history back to "in progress" —
  // and there is nothing to distinguish a row this migration closed from one
  // the detector has since closed on purpose, so it would also destroy the real
  // end times of resolved outages. Reverting the code without the data is safe:
  // the old UI only ever read `ended_at` on `source = 'manual'` rows, which
  // this never touched. Same posture as 1787500000_shorten_node_ids.js.
});
