# PocketBase + Garage S3 (via the in-cluster gateway)

How to point PocketBase's file storage (and backups) at the **Garage S3 gateway**
described in [K8S_GARAGE_S3.md](K8S_GARAGE_S3.md), and how to wire that gateway in
as a dependency of the `starter-ware` deployment.

By default PocketBase stores uploads on the local filesystem under
`pb_data/storage` (the `pocketbase-data` PVC in this project — see
[PB_UPLOADS.md](PB_UPLOADS.md#storage-options)). Switching to S3 offloads that data
to Garage, which means uploads survive a PVC loss and the PVC only has to hold the
SQLite DB.

---

## How the pieces connect

```
 webapp ──▶ pocketbase (ns: starter-ware) ──S3──▶ garage.garage-system.svc:3900
                                                        │  (HAProxy gateway x2)
                                                        ▼
                                              Garage @ <GARAGE_NODE_IP>:3900
```

PocketBase is the **S3 client**. The Garage gateway is a plain ClusterIP service in
the `garage-system` namespace, so PocketBase reaches it cross-namespace via its FQDN:

```
http://garage.garage-system.svc.cluster.local:3900
```

Because the gateway logs the **source pod IP**, the PocketBase pod will show up by
name in `which-garage-clients.sh` and the "Garage Gateway" Grafana dashboard once it
starts serving files.

> **Path-style is mandatory.** Garage (like MinIO) does not support virtual-hosted
> bucket addressing (`bucket.host`). PocketBase must use **path-style** requests
> (`host/bucket`). In the Dashboard this is the **"Force path-style addressing"**
> checkbox — it must be **on**.

---

## 1. Add the gateway as a dependency

The gateway lives in its own manifests (the `k8s/garage` kustomize from the S3-proxy
repo). It is **not** part of this repo's `k8s/` directory, so deploy it separately —
once per cluster.

```sh
# from the s3-proxy repo
kubectl apply -k k8s/garage
kubectl -n garage-system rollout status deploy/garage-gateway
```

That creates the `garage` Service in `garage-system`. Nothing else in `starter-ware`
needs to change to *reach* it — cross-namespace ClusterIP DNS already works.

### Optional: a namespace-local alias

So the PocketBase config references a short, stable name that's local to
`starter-ware` (and so the dependency is explicit in this repo's manifests), add an
`ExternalName` Service that aliases the cross-namespace FQDN. Save as
`k8s/15-garage-s3-externalname.yaml`:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: garage-s3
  namespace: starter-ware
  labels:
    app.kubernetes.io/part-of: starter-ware
spec:
  type: ExternalName
  # CNAME to the gateway Service in the garage-system namespace.
  externalName: garage.garage-system.svc.cluster.local
  ports:
    - name: s3
      port: 3900
```

Then PocketBase can use the endpoint `http://garage-s3.starter-ware.svc.cluster.local:3900`
(or just `http://garage-s3:3900` from inside the pod). Apply it with the rest:

```sh
kubectl apply -f k8s/
```

> **NetworkPolicy:** if you run default-deny egress in `starter-ware`, also allow the
> PocketBase pod egress to the gateway (`garage-system`, TCP 3900). With no policies
> in place, no change is needed.

---

## 2. Create a bucket and credentials in Garage

S3 storage needs a bucket and an access key/secret pair. On the Garage node:

```sh
# create the bucket
garage bucket create pocketbase

# create an app key (prints Key ID + Secret — save the secret, it's shown once)
garage key create pocketbase-app

# grant the key read/write on the bucket
garage bucket allow pocketbase --read --write --key pocketbase-app
```

Note the **region** from your Garage config (`metadata_dir`/`s3_api.s3_region`,
commonly `garage`). PocketBase requires a region value even though Garage is
single-region.

You now have the four values PocketBase needs:

| Field      | Value                                                            |
|------------|-----------------------------------------------------------------|
| Endpoint   | `http://garage.garage-system.svc.cluster.local:3900` (or the `garage-s3` alias) |
| Bucket     | `pocketbase`                                                     |
| Region     | `garage` (whatever your Garage `s3_region` is)                   |
| Access key | the Key ID from `garage key create`                             |
| Secret     | the Secret from `garage key create`                            |

---

## 3. Configure PocketBase

### Option A — Dashboard (simplest, recommended)

PocketBase v0.23 stores S3 config in its settings DB, not in env vars, so the
straightforward path is the admin UI:

1. Open the admin UI: `http://localhost/_/` (see [k8s/README.md](../k8s/README.md#6-verify)).
2. Go to **Settings → Files storage**.
3. Switch the storage to **S3** and fill in:
   - **Endpoint:** `http://garage.garage-system.svc.cluster.local:3900`
   - **Bucket:** `pocketbase`
   - **Region:** `garage`
   - **Access key** / **Secret:** from step 2
   - **Force path-style addressing:** ✅ **on**
4. Click **Test connection**, then **Save**.

Repeat under **Settings → Backups** if you also want PocketBase backups written to
Garage (separate S3 block, same values, ideally a different bucket).

> **Migrating existing files:** turning on S3 does *not* copy files already on the
> PVC. For a fresh deployment, configure S3 before users upload anything. To migrate
> an existing instance, copy `pb_data/storage/` into the bucket first (e.g. with
> `aws s3 sync --endpoint-url ...` using the same path-style flag), then flip the
> setting.

### Option B — Automated bootstrap (GitOps-friendly)

To keep credentials out of the DB snapshot and make the config reproducible, inject
them from a Kubernetes Secret and apply them on boot from a PocketBase JS hook.

**1. Create the Secret:**

```sh
kubectl -n starter-ware create secret generic pocketbase-s3 \
  --from-literal=S3_ENDPOINT=http://garage.garage-system.svc.cluster.local:3900 \
  --from-literal=S3_BUCKET=pocketbase \
  --from-literal=S3_REGION=garage \
  --from-literal=S3_ACCESS_KEY=<key-id> \
  --from-literal=S3_SECRET=<secret>
```

**2. Mount it as env in [k8s/20-pocketbase-deployment.yaml](../k8s/20-pocketbase-deployment.yaml)**
on the `pocketbase` container:

```yaml
          envFrom:
            - secretRef:
                name: pocketbase-s3
```

**3. Apply the settings on boot** — add to [pocketbase/pb_hooks/main.pb.js](../pocketbase/pb_hooks/main.pb.js):

```js
// Configure S3 file storage from env (Garage via the in-cluster gateway).
// Runs on every boot; only re-saves when something changed.
onBootstrap((e) => {
  e.next() // let core bootstrap finish first

  const endpoint = $os.getenv("S3_ENDPOINT")
  if (!endpoint) return // S3 not configured → keep local filesystem storage

  const settings = $app.settings()
  settings.s3.enabled         = true
  settings.s3.endpoint        = endpoint
  settings.s3.bucket          = $os.getenv("S3_BUCKET")
  settings.s3.region          = $os.getenv("S3_REGION")
  settings.s3.accessKey       = $os.getenv("S3_ACCESS_KEY")
  settings.s3.secret          = $os.getenv("S3_SECRET")
  settings.s3.forcePathStyle  = true // required for Garage/MinIO

  $app.save(settings)
  console.log("✅ PocketBase S3 storage configured for", endpoint)
})
```

> The exact settings field names come from the PocketBase JSVM reference
> (<https://pocketbase.io/jsvm/>) — verify against the version pinned in
> [pocketbase/CHANGELOG.md](../pocketbase/CHANGELOG.md) (currently v0.23.x) if a
> field is rejected on save. The Dashboard route (Option A) is authoritative if you
> hit a mismatch.

---

## 4. Verify

1. Restart PocketBase so the new config/hook takes effect:
   ```sh
   kubectl -n starter-ware rollout restart deploy/pocketbase
   kubectl -n starter-ware rollout status deploy/pocketbase
   ```
2. Upload a file through the app (e.g. a Todo attachment) or the admin UI.
3. Confirm the object landed in Garage:
   ```sh
   garage bucket info pocketbase   # object count / size should increase
   ```
4. Confirm PocketBase shows up as a gateway client (from the S3-proxy repo):
   ```sh
   ./k8s/garage/which-garage-clients.sh
   # → ... S3   starter-ware/pocketbase-xxxx @ <node>
   ```
5. The file URL still resolves the same way (PocketBase proxies S3 fetches) — see
   [PB_UPLOADS.md](PB_UPLOADS.md#file-urls). Clients don't talk to Garage directly.

---

## Notes & gotchas

- **PVC still required.** PocketBase keeps its SQLite DB on the PVC even with S3
  storage; don't remove the `pocketbase-data` volume. Only `pb_data/storage` moves
  to S3.
- **Still single-instance.** S3 storage does **not** make PocketBase horizontally
  scalable — the SQLite DB is still single-writer, so `replicas: 1` / `Recreate`
  stays (see [k8s/README.md](../k8s/README.md#notes)).
- **Use `http://` not `https://`** for the endpoint unless your Garage node
  terminates TLS — the gateway forwards L4/TCP as-is.
- **Thumbnails** are generated by PocketBase and cached back into the bucket; the
  first request for a new thumb size is slightly slower.
