# D1 migrations

`0001_initial_schema.sql` defines the initial ReachFlow database schema and
seeds `registration_mode` to `INVITE_ONLY`. Add future changes as new numbered
`.sql` migration files; do not edit an already-applied migration.

The migration has been executed against Node's built-in `node:sqlite` in-memory
database for SQL validation. It has not been applied to local or remote D1.
Wrangler's `migrations_dir` is configured to this directory.

Do not apply migrations to a remote D1 database until a real database has been
created and its ID has replaced the local placeholder in `wrangler.jsonc`.
