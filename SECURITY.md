# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting for this repository. Do not open
a public issue containing credentials, exploit details, provider tokens, or a
working bypass.

Include the affected version, deployment topology, reproduction steps, and the
minimum sanitized evidence needed to verify the issue. Never attach a real
OAuth token, client/control key, database dump, prompt, or model output.

## Supported versions

Until 1.0, only the newest tagged release receives security fixes. Pin exact
image digests and review release notes before upgrading.

## Deployment expectations

- Expose only the data plane publicly.
- Keep the control API on a private network and behind TLS.
- Use scoped control keys; never ship one to browser code.
- Treat `control-keys:write` as root-equivalent and reserve it for key
  administration.
- Use distinct runtime and migration database roles.
- Mount local RSA keys read-only with owner-only permissions, or use an
  immutable managed KMS key version.
- Put an edge/WAF rate limit in front of public inference.
- Back up PostgreSQL and key-encryption material separately.
- Connect only provider adapters you have staged with your own accounts.
- Keep an Agent SDK bridge private and use a dedicated random bridge key; it
  must never reuse a gateway data or control key.

## Data handling guarantee

The project intentionally stores only routing/account metadata, normalized
quota/usage data, and redacted audits. Prompts, outputs, reasoning, tool
arguments/results, raw upstream errors, authorization headers, and plaintext
credentials do not belong in logs, metrics, traces, audit rows, or request
history.
