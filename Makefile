.DEFAULT_GOAL := help
.PHONY: help setup up dev stop restart down status logs db-up db-stop db-migrate db-shell test-db check build

LOCAL = npx --no-install tsx scripts/local-dev.ts

help:
	@printf '%s\n' \
	  'make up          Start Docker Postgres, migrate, and run the app in the background' \
	  'make dev         Start Docker Postgres, migrate, and run the app in the foreground' \
	  'make restart     Restart the local app' \
	  'make stop        Stop the app, keeping Postgres running' \
	  'make down        Stop the app and Postgres, keeping database files' \
	  'make status      Show database and app health' \
	  'make logs        Follow the app log' \
	  'make setup       Install missing dependencies, start Postgres, and migrate' \
	  'make db-shell    Open psql in the local database' \
	  'make test-db     Run Postgres integration checks locally' \
	  'make check       Run typecheck, lint, and tests' \
	  'make build       Build the frontend'

setup:
	@test -d node_modules || npm ci
	@test -d website/node_modules || npm --prefix website ci
	@$(LOCAL) db-up
	@$(LOCAL) db-migrate

up: setup
	@$(LOCAL) start

dev: setup
	@$(LOCAL) dev

restart: setup
	@$(LOCAL) restart

stop:
	@$(LOCAL) stop

down: stop
	@$(LOCAL) db-stop

status:
	@$(LOCAL) status

logs:
	@tail -n 60 -f .data/local-dev/server.log

db-up:
	@$(LOCAL) db-up

db-stop:
	@$(LOCAL) db-stop

db-migrate: db-up
	@$(LOCAL) db-migrate

db-shell: db-up
	@$(LOCAL) db-shell

test-db: setup
	@$(LOCAL) test-db

check:
	@npm run check

build:
	@npm run build
