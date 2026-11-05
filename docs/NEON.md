# Optional Postgres storage

OntoLab can store the local workspace in Postgres. A Neon database or a
Postgres instance you manage both work. For a development database managed
with Docker Compose, see [local development](LOCAL.md).

Set the following values in your local environment or dotenv file:

- `STORE_MODE=postgres` to select Postgres explicitly. A configured `DATABASE_URL` also selects it.
- `DATABASE_URL` for the runtime connection.
- `DATABASE_URL_UNPOOLED` for the direct migration connection when your runtime URL is pooled.

Run `npm run db:migrate` before starting OntoLab. The migration runner checks
applied checksums, takes an advisory lock and applies each migration in a
transaction. The schema lives under `ontolab`.

Projects, uploads, runs and version history use the database. Keep your data
directory across restarts if you rely on the locally generated graph
connection key. Download project archives from **Export** for portable copies.
