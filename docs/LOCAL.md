# Local development with Docker Postgres

Install Node 22+, Docker with Compose, and Make. Start Docker, then run:

```bash
make up
```

This installs dependencies if missing, starts Postgres, applies the existing
versioned migrations, and starts Vite and the API in the background. Open
http://localhost:5173. For provider keys, copy `.env.example` to `.env` on first
setup and edit it. Existing `.env` files are left in place.

| Command | Action |
| --- | --- |
| `make setup` | Install missing dependencies, start Postgres, apply migrations |
| `make up` | Set up and start the app in the background |
| `make dev` | Set up and run the app in the foreground; Ctrl+C stops it |
| `make restart` | Restart the background app |
| `make stop` | Stop the background app, leaving Postgres running |
| `make down` | Stop the app and Postgres, retaining database files |
| `make status` | Show database and app health |
| `make logs` | Follow the app log |
| `make db-up` / `make db-stop` | Start / stop Postgres |
| `make db-migrate` | Apply local migrations |
| `make db-shell` | Open a local psql session |
| `make test-db` | Run adapter integration checks using temporary test projects |
| `make check` / `make build` | Run repository checks / build the frontend |

The database is `postgresql://ontolab:ontolab@127.0.0.1:55432/ontolab`. These
credentials are for the loopback-only development container. Set
`ONTOLAB_DB_PORT` when running Make to use a different port. The app uses
ports 5173 and 3000. Stop any earlier manually started server before the first
`make up`; subsequent background app processes are managed by `make stop` and
`make restart`. Logs and the process ID are stored in ignored `.data/local-dev/`.

## Local settings

The Make runner sets the local database URL, `STORE_MODE=postgres`,
`API_PORT=3000` and an empty mount path for its child processes. Provider
settings still load from your dotenv files. Running `npm run dev` directly uses
the database configured in your environment. Without a database URL it uses
on-disk storage.

## Data

New Docker databases start empty. Remote projects are not copied automatically.
Projects, original files, parsed text, chunks, versions and run history are
stored in the `ontolab-local_postgres-data` Docker volume. `make down` stops
services without deleting that volume. The configuration follows the
[Postgres image storage layout](https://hub.docker.com/_/postgres) and
[Compose volume persistence](https://docs.docker.com/compose/gettingstarted/).

Deleting a Docker volume removes its contents. Docker development commands operate on the local Compose project.
