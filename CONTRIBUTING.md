# Contributing

Use Node 22 and pnpm 8. Never commit environment files, database dumps,
certificates, private keys, provider tokens, or generated one-time keys.

## Local checks

```bash
corepack pnpm install
corepack pnpm format:check
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

For PostgreSQL integration tests, create an explicitly disposable local
database named `llm_gateway_test`, apply the tracked migrations, and export
`GATEWAY_TEST_DATABASE_URL`. Tests refuse non-local hosts and other database
names.

Create migrations only with Prisma Migrate against a disposable database. If
a generated migration would discard existing values, amend that generated
migration with an explicit data-preserving transition and replay the complete
history from empty before submitting it.

## Pull requests

- Keep provider behavior inside one adapter.
- Add adapter conformance and strict-wire tests.
- Preserve auth-before-body, bounded streams, conservative accounting, and
  no-content logging.
- Update OpenAPI, the admin client, README, and migration notes when contracts
  change.
- Include a threat-model note for authentication, encryption, permissions,
  networking, or credential-lifecycle changes.
