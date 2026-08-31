# Migrating an embedded installation

1. Back up PostgreSQL and the external key wrapper without printing either.
2. Restore the backup into a disposable clone.
3. Apply every standalone migration to the clone.
4. Compare table counts and verify that every encrypted credential decrypts
   with the existing wrapper.
5. Create a standalone control key and run control/data compatibility tests.
6. Stop the embedded gateway before pointing the standalone service at the
   original database.
7. Apply migrations with the dedicated migration role.
8. Start control, worker, then data roles and verify catalogs/tool workflows.
9. Move the integrating dashboard to the private control API.
10. Remove database and key-wrapper access from the old host.

Legacy `arcgw_*` client keys and the `/api/llm-gateway` data prefix remain
accepted during migration. Existing version-1 encrypted envelopes retain their
original authenticated-data prefix; new envelopes use the generic version-2
prefix.
