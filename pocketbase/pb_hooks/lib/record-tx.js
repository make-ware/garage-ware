//
// Run a record request hook's body inside a single transaction that the record
// write itself joins.
//
// The problem this solves: in a *Request hook, `e.app` is the plain request app.
// `e.next()` hands off to PocketBase's default handler, which submits its upsert
// form against `e.App` — and if that app is not transactional, the save opens
// and commits a transaction of its own. Anything the hook writes afterwards is a
// separate, unprotected write against an already-committed record. The default
// handler also writes the HTTP response from inside that call (see
// `execAfterSuccessTx` in apis/record_helpers.go), so a later failure cannot even
// be reported: the caller has already been told the write succeeded.
//
// Reassigning `e.app` to the transactional app *before* `e.next()` fixes both
// halves. The default handler reads `e.App` when it builds the form, so the
// record save joins this transaction; and `execAfterSuccessTx` sees a non-nil
// `TxInfo()` and defers the response until the transaction completes. Nesting is
// safe by construction — `BaseApp.runInTransaction` runs inline when the app's
// DB is already a `*dbx.Tx` (core/db_tx.go).
//
// Net effect: the record, its audit row, and its balance update commit together
// or not at all, and a failure in any of them reaches the caller as an error
// rather than a 200 with a silently missing trail.
//
// Lives in a plain `.js` (not `*.pb.js`, which PocketBase would load as a hook
// file in its own right) and must be `require`d INSIDE each handler: Goja runs
// every callback in a fresh executor and will not carry top-level declarations
// from main.pb.js into them.

/**
 * @param {core.RecordRequestEvent} e the hook event
 * @param {(txApp: core.App) => void} fn body to run; receives the transactional
 *   app. Call `e.next()` inside it at the point the record should be written.
 *   Throwing rolls the whole thing back.
 */
function withRecordTx(e, fn) {
  e.app.runInTransaction((txApp) => {
    // Must be assigned before fn() calls e.next(), or the save will not join.
    e.app = txApp;
    fn(txApp);
  });
}

module.exports = { withRecordTx };
