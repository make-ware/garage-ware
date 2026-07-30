# Garage S3 Gateway

In-cluster gateway to an external **GarageHQ** node.

Throughout this doc `<GARAGE_NODE_IP>` stands for the address of your Garage
node (an IP or a resolvable hostname) — substitute your own.

Pods talk to a stable in-cluster DNS name; an HAProxy gateway proxies the traffic
to Garage and records **which pod made each connection** (logs + Prometheus
metrics). HAProxy runs in L4/TCP mode, so it's protocol-agnostic and works for
the S3, Web, Admin, and K2V APIs alike.

```
 pod ──▶ garage.garage-system.svc:3900 ──▶ [HAProxy gateway x2] ──▶ <GARAGE_NODE_IP>:3900
                                                  │
                                                  ├─ tcplog (source pod IP)  → which-garage-clients.sh
                                                  └─ /metrics (prometheus)   → ServiceMonitor → Grafana
```

## Endpoints for your pods

| API   | DNS name                                       | Port | Garage port |
|-------|------------------------------------------------|------|-------------|
| S3    | `garage.garage-system.svc.cluster.local`       | 3900 | 3900        |
| Web   | `garage.garage-system.svc.cluster.local`       | 3902 | 3902        |
| Admin | `garage.garage-system.svc.cluster.local`       | 3903 | 3903        |
| K2V   | `garage.garage-system.svc.cluster.local`       | 3904 | 3904        |

From a pod **inside** `garage-system` the short name `garage:3900` works too.

Example S3 endpoint config:

```
AWS_ENDPOINT_URL = http://garage.garage-system.svc.cluster.local:3900
# (use https:// instead if your Garage node terminates TLS)
```

## Deploy

```bash
kubectl apply -k k8s/garage
# or, with microk8s:
microk8s kubectl apply -k k8s/garage

kubectl -n garage-system rollout status deploy/garage-gateway
```

## Observability

**1. Who's talking to Garage (per-pod):**

```bash
./k8s/garage/which-garage-clients.sh            # last 1h
SINCE=15m ./k8s/garage/which-garage-clients.sh  # custom window
KUBECTL="microk8s kubectl" ./k8s/garage/which-garage-clients.sh
```

Sample output:

```
Pods connecting to Garage via the gateway (last 1h):

     412 conns  S3      default/web-app-7c9f-abcde @ node-a
      18 conns  Admin   default/backup-job-xyz @ node-b
```

This works because Calico does **not** source-NAT pod→ClusterIP traffic, so
HAProxy sees the real client pod IP and we join it against `kubectl get pods`.

**2. Grafana dashboard:** auto-imported by the Grafana sidecar — open Grafana
(whatever address your install is reachable at, e.g. the `NodePort` on a cluster
node) → dashboard **"Garage Gateway"** (backend health, sessions,
connections/sec, throughput per API).

**3. Live HAProxy stats page:**

```bash
kubectl -n garage-system port-forward svc/garage-gateway-metrics 8404:8404
# then open http://localhost:8404/stats   (raw metrics at /metrics)
```

## Operations

- **Change the Garage IP/ports:** edit the backends in
  [10-haproxy-config.yaml](10-haproxy-config.yaml), re-apply, then
  `kubectl -n garage-system rollout restart deploy/garage-gateway`
  (HAProxy doesn't hot-reload a mounted ConfigMap).
- **A backend shows DOWN in stats/Grafana:** that Garage API may not be enabled
  on the node (e.g. Admin/Web/K2V are optional in Garage's config). The S3
  backend should always be up. The TCP health check only confirms the port
  accepts connections.
- **High availability:** 2 replicas with a rolling update (`maxUnavailable: 0`)
  spread across both nodes, so S3 traffic keeps flowing through node reboots.

## Why a gateway instead of a direct Service?

A selector-less `Service` + `EndpointSlice` could route straight to Garage with
slightly lower latency, but it gives **no per-pod visibility** without extra
Calico flow-log tooling. Routing through HAProxy is what makes "see which pods
are communicating" possible while keeping a single stable endpoint for clients.
