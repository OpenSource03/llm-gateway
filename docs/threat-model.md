# Threat model

## Assets

- Provider access/refresh tokens and account identity.
- Data-plane and control-plane bearer keys.
- Key-encryption material.
- Routing, usage, quota, and audit metadata.
- Availability of provider subscriptions and their usage limits.

## Trust boundaries

- Public clients to the data plane.
- Integrating BFFs to the private control plane.
- Gateway roles to PostgreSQL and the key wrapper.
- Gateway roles to an optional private Agent SDK bridge.
- An optional Codex Desktop auth bridge from a local ChatGPT bearer to a
  Keychain-backed gateway data key.
- Provider adapters to fixed upstream provider hosts.
- Migration jobs to the DDL-capable database role.

## Primary threats and controls

| Threat                     | Control                                                                            |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Stolen data key            | 256 random bits, hash-only storage, revocation, expiry, caps                       |
| Stolen control key         | Resource scopes, optional CIDRs, private ingress, audit credential ID              |
| Actor spoofing             | Actor headers accepted only from keys explicitly allowed to delegate               |
| OAuth interception/replay  | PKCE/state, encrypted single-use attempts, expiry and consumed status              |
| Database disclosure        | Per-row AES-GCM; wrapped random data keys; no plaintext credentials                |
| SSRF                       | Provider endpoints compiled into adapters; redirects fail closed                   |
| Bridge impersonation       | Fixed configured origin, dedicated API key, TLS or explicit private-network opt-in |
| Malicious request/schema   | Authentication first, byte/depth/count limits, allowlisted reconstruction          |
| Prompt/output disclosure   | Content is neither persisted nor logged; public errors are sanitized               |
| Cross-account leakage      | Account/model eligibility checks, sticky routes hashed with deployment HMAC        |
| Cap/concurrency races      | PostgreSQL locks, reservations, leases, idempotent reconciliation                  |
| Stream interruption        | Upstream cancellation, conservative reservation, exactly-once finalization         |
| Cache destruction          | Stable catalog/prompt construction and account stickiness                          |
| Local auth-bridge exposure | Loopback-only bind/client checks, fixed origin, canonical data paths, no proxy env |
| ChatGPT bearer disclosure  | Removed before proxy cloning; never forwarded, persisted, or logged                |
| Supply-chain compromise    | Lockfile, pinned Actions, CodeQL, gitleaks, Trivy, SBOM, signed images             |

## Residual risks

Consumer subscription transports are not stable public APIs. Providers may
change validation, model entitlement, quotas, or policy. The gateway cannot
reproduce private harness state byte-for-byte and must never claim to be an
official provider application.

The optional Agent SDK bridge executes the official SDK/Claude subprocess but
remains an unofficial translation service. Compromise of that bridge exposes
the Claude profiles mounted into it. Isolate it from public ingress and from
unrelated workloads.

The optional Codex auth bridge runs with the local macOS user's privileges. It
does not make a ChatGPT bearer valid at the gateway, but a compromise of that
user can call the loopback bridge or retrieve credentials allowed by the same
Keychain ACL. Keep the listener on loopback, use HTTPS for remote gateway
origins, and revoke the gateway data key after local-user compromise.
