#!/bin/sh
# Applies any new database migrations, then starts the server.
# Migrations only apply what is new, so this is safe on every start.
set -e

node db/migrate.mjs

exec node server.js
