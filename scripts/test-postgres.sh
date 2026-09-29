#!/bin/sh
set -eu
# Override PG_BIN when PostgreSQL lives elsewhere.
PG_BIN="${PG_BIN:-/opt/homebrew/opt/postgresql@14/bin}"
test_db_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-telegram-pg.XXXXXX")
test_port="${TEST_PG_PORT:-55439}"
"$PG_BIN/initdb" -D "$test_db_dir/data" -A trust -U bot_test --no-locale > "$test_db_dir/init.log"
"$PG_BIN/pg_ctl" -D "$test_db_dir/data" -l "$test_db_dir/server.log" -o "-h 127.0.0.1 -p $test_port" -w start
trap '"$PG_BIN/pg_ctl" -D "$test_db_dir/data" -m fast -w stop' EXIT INT TERM
TEST_DATABASE_URL="postgresql://bot_test@127.0.0.1:$test_port/postgres" npm test
# Keep test data for inspection; never delete existing files here.
