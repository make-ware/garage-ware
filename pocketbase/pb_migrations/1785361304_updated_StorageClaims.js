/// <reference path="../pb_data/types.d.ts" />

// Turn StorageClaims into an append-only ledger:
//   - drop the UNIQUE (user, node_id) index so a pair can hold many entries
//   - drop the min:0 floor on quota_gb so an entry can reclaim space
//   - add an optional `note` recording why the adjustment was made
//
// The index swap is ordered drop-then-add on purpose: the replacement carries
// the same name, and PocketBase rejects a collection holding two indexes named
// `idx_storageclaims_user_node`.
migrate((app) => {
  const addNote = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;

  addNote.fields.add(new TextField({
    "name": "note",
    "id": "textva304bmfya",
    "required": false,
    "max": 500
  }));

  app.save(addNote);

  const modifyQuota = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  modifyQuota.fields.getByName("quota_gb").min = null;
  app.save(modifyQuota);

  const swapIndex = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  const uniqueIdx = swapIndex.indexes.findIndex(idx => idx === "CREATE UNIQUE INDEX `idx_storageclaims_user_node` ON `StorageClaims` (`user`, `node_id`)");
  if (uniqueIdx !== -1) {
    swapIndex.indexes.splice(uniqueIdx, 1);
  }
  swapIndex.indexes.push("CREATE INDEX `idx_storageclaims_user_node` ON `StorageClaims` (`user`, `node_id`)");
  return app.save(swapIndex);
}, (app) => {
  // Reverting re-imposes UNIQUE (user, node_id) and min:0. Existing ledger data
  // will block it: collapse each (user, node) pair down to a single
  // non-negative row before migrating down.
  const swapIndex = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  const plainIdx = swapIndex.indexes.findIndex(idx => idx === "CREATE INDEX `idx_storageclaims_user_node` ON `StorageClaims` (`user`, `node_id`)");
  if (plainIdx !== -1) {
    swapIndex.indexes.splice(plainIdx, 1);
  }
  swapIndex.indexes.push("CREATE UNIQUE INDEX `idx_storageclaims_user_node` ON `StorageClaims` (`user`, `node_id`)");
  app.save(swapIndex);

  const revertQuota = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  revertQuota.fields.getByName("quota_gb").min = 0;
  app.save(revertQuota);

  const revertNote = app.findCollectionByNameOrId("pb_71igpo3jjenzjd0") // StorageClaims;
  revertNote.fields.removeByName("note");
  return app.save(revertNote);
});
