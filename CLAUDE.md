# LLM Gateway contributor instructions

This repository is a standalone, public, self-hosted subscription LLM gateway.
It has no dependency on Arcademy or any integrating application's database,
authentication system, or source tree.

## Commands

- `corepack pnpm install`
- `corepack pnpm typecheck`
- `corepack pnpm test`
- `corepack pnpm test:integration`
- `corepack pnpm build`
- `corepack pnpm prisma:validate`
- `corepack pnpm prisma:migrate:dev --name <name>` against an explicitly
  disposable database

Use pnpm only. Generate migrations with Prisma Migrate; never use `db push` or
hand-write a migration as a substitute. Data-preserving SQL may be added to a
generated migration and must be replayed from empty afterward.

## Security invariants

- Never persist or log prompts, outputs, reasoning, tool inputs/results, raw
  provider errors, OAuth codes, authorization headers, plaintext client/control
  keys, or plaintext provider credentials.
- Authenticate before parsing request bodies. Keep all bounds, deadlines,
  backpressure, cancellation, and conservative accounting behavior.
- Provider endpoints are adapter-owned constants. Requests, database rows, and
  configuration must not select arbitrary upstream origins.
- Provider credentials remain per-row envelope encrypted. Data/control keys
  remain high entropy and hash-only at rest.
- Control API keys are server-side credentials. Browser code must never receive
  one. Actor delegation is accepted only from explicitly enabled keys.
- Public provider/model discovery is live and key-scoped. Never add a bundled
  model list.
- Keep routing sticky where possible so multi-account balancing does not destroy
  provider prompt caches.
- New providers implement the complete adapter contract and conformance tests;
  do not scatter provider switches through shared routing code.
- Direct provider execution remains the default. External transports are
  selected per account, use deployment-owned fixed origins and credentials,
  and must preserve client-side tool passthrough and sticky profile routing.
- Do not vendor Meridian source while its repository lacks a standalone
  license text. Keep the optional integration version-pinned and out of the
  default runtime image.
- Do not claim private subscription transports are official or byte-identical
  to first-party clients. Preserve measured compatibility profiles and explicit
  boundaries.

## Database and deployment

PostgreSQL is the only durable dependency. Runtime roles receive DML only;
migrations run through an explicit job with a separately pinned target. The
data plane may be public, but the control plane must default to private ingress.
Local RSA wrapping is a supported deployment mode only when the key is a
regular owner-only file mounted read-only.

## Verification

Protocol changes require focused fixtures plus the complete unit and database
integration suites. Authentication, key lifecycle, actor delegation,
encryption, audit, or scoping changes require an explicit adversarial review.
Live tests must use synthetic prompts and structural logging only, then remove
temporary keys and rows.
