# Helm deployment

The chart runs the public data plane, private control plane, scheduler worker,
and a pre-install/pre-upgrade migration job as separate workloads.

## Prerequisites

- PostgreSQL 16 or newer
- an ingress controller for the public data service
- a namespace or pod allowed to reach the private control service
- either an RSA private key stored in a Kubernetes Secret or an Azure Key
  Vault key-version URL

Create the runtime secret without placing values in a Helm values file:

```bash
kubectl create secret generic llm-gateway \
  --from-literal=database-url='postgresql://...' \
  --from-literal=session-hmac="$(openssl rand -hex 32)" \
  --from-file=local-rsa.pem=/secure/path/llm-gateway-wrap-key.pem
```

The migration job validates both `migrations.expectedHost` and
`migrations.expectedDatabase` before applying DDL. The database URL should also
carry the TLS settings required by the PostgreSQL server.

## Install

```bash
helm upgrade --install gateway ./deploy/helm/llm-gateway \
  --namespace llm-gateway --create-namespace \
  --set publicBaseUrl=https://gateway.example.com \
  --set migrations.expectedHost=postgres.example.internal \
  --set migrations.expectedDatabase=llm_gateway
```

The default NetworkPolicy denies control-plane ingress unless the caller's
namespace has this label:

```bash
kubectl label namespace my-admin llm-gateway-control-access=true
```

Narrow `networkPolicy.controlPodSelector` as well when only one application in
that namespace should have access. Do not expose the control Service through a
public ingress.

For the local-RSA wrapper, an unprivileged init container copies the
group-readable Kubernetes Secret projection into an `emptyDir`, takes
ownership, and tightens it to mode `0600`. The gateway mounts only that prepared
copy, preserving its owner-only key invariant.

For Azure Key Vault, set `keyWrapper=azure-key-vault`, provide an immutable
`azureKeyVaultKeyId`, and configure workload identity for the pod separately.
The example chart intentionally does not create cloud identity resources.

To use an independently deployed Agent SDK bridge, add its API key to the
existing Secret, then set `agentSdk.enabled=true` and `agentSdk.url`. Use HTTPS
unless a service mesh or isolated cluster network justifies explicitly setting
`agentSdk.allowInsecure=true`. Accounts remain on `direct` until linked through
the control API.
