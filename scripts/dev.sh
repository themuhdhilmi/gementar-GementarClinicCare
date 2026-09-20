#!/usr/bin/env bash
#
# Run every ClinicCare service with one command.
#
#   ./scripts/dev.sh              API and web, watch mode, logs interleaved
#   ./scripts/dev.sh --prod       build both, then run the compiled output
#                                 (fast to boot, no watchers; still your local .env)
#   ./scripts/dev.sh --api        API only
#   ./scripts/dev.sh --web        web only
#   ./scripts/dev.sh --seed       seed a tenant and administrator first
#   ./scripts/dev.sh --no-migrate skip applying migrations on start
#
# Ctrl-C stops everything, including the processes npm spawned underneath.
# SIGTERM does the same, for when this runs under a process manager.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

API_PORT="${API_PORT:-3001}"
WEB_PORT="${WEB_PORT:-3000}"

MODE=dev
RUN_API=true
RUN_WEB=true
DO_MIGRATE=true
DO_SEED=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --prod|--production) MODE=prod ;;
    --api|--api-only) RUN_WEB=false ;;
    --web|--web-only) RUN_API=false ;;
    --seed) DO_SEED=true ;;
    --no-migrate) DO_MIGRATE=false ;;
    -h|--help) sed -n '3,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1 (try --help)" >&2; exit 2 ;;
  esac
  shift
done

# ----------------------------------------------------------------- output

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; BLUE=$'\033[34m'; CYAN=$'\033[36m'; RESET=$'\033[0m'
else
  BOLD=''; DIM=''; RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; RESET=''
fi

say()  { printf '%s\n' "${BOLD}▸${RESET} $*"; }
warn() { printf '%s\n' "${YELLOW}!${RESET} $*" >&2; }
die()  { printf '%s\n' "${RED}✗${RESET} $*" >&2; exit 1; }
ok()   { printf '%s\n' "${GREEN}✓${RESET} $*"; }

# ----------------------------------------------------------------- checks

command -v node >/dev/null || die "Node is not installed. This project needs Node 20 or newer."
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "$NODE_MAJOR" -ge 20 ]] || die "Node $NODE_MAJOR is too old; this project needs 20 or newer."

port_busy() {
  if command -v ss >/dev/null; then
    ss -tln 2>/dev/null | grep -q ":$1 "
  elif command -v lsof >/dev/null; then
    lsof -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
  else
    return 1
  fi
}

check_port() {
  local port="$1" name="$2"
  if port_busy "$port"; then
    die "Port $port is already in use, so $name cannot start. Stop the other process, or set ${name^^}_PORT."
  fi
}

[[ -d node_modules ]] || { say "Installing dependencies"; npm install; }

if [[ ! -f apps/api/.env ]]; then
  cp apps/api/.env.example apps/api/.env
  warn "Created apps/api/.env from the example."
  warn "Fill in DATABASE_URL, then generate the two keys:"
  warn "    node scripts/random-key.mjs   # APP_KEK_V1"
  warn "    node scripts/random-key.mjs   # APP_HASH_PEPPER"
  die  "Edit apps/api/.env and run this again."
fi

if ! grep -qE '^DATABASE_URL="?postgres(ql)?://[^"]*[^"/]' apps/api/.env; then
  die "apps/api/.env has no usable DATABASE_URL. Point it at your PostgreSQL database."
fi
for key in APP_KEK_V1 APP_HASH_PEPPER; do
  if ! grep -qE "^${key}=.+" apps/api/.env; then
    die "apps/api/.env is missing $key. Generate one with: node scripts/random-key.mjs"
  fi
done

[[ -f apps/web/.env.local ]] || {
  cp apps/web/.env.example apps/web/.env.local
  ok "Created apps/web/.env.local from the example."
}

$RUN_API && check_port "$API_PORT" api
$RUN_WEB && check_port "$WEB_PORT" web

# ------------------------------------------------------------- preparation

if [[ ! -f apps/api/src/generated/prisma/client.ts ]]; then
  say "Generating the Prisma client"
  npm run db:generate --silent --workspace @gementar/api
fi

if $RUN_API && $DO_MIGRATE; then
  say "Applying database migrations"
  if ! npm run db:migrate --silent --workspace @gementar/api; then
    die "Migrations failed. Is DATABASE_URL correct and the server reachable?"
  fi
fi

if $DO_SEED; then
  say "Seeding a tenant, branch and administrator"
  npm run db:seed --workspace @gementar/api
fi

if [[ "$MODE" == prod ]]; then
  say "Building both applications"
  npm run build
fi

# --------------------------------------------------------------- processes

PIDS=()
NAMES=()

SHUTTING_DOWN=false

cleanup() {
  $SHUTTING_DOWN && return 0
  SHUTTING_DOWN=true
  printf '\n'
  say "Stopping services"
  for pid in "${PIDS[@]}"; do
    # Each service is its own session, so signalling the group takes down npm
    # and everything it spawned, instead of orphaning the real server.
    kill -TERM -- "-${pid}" 2>/dev/null || kill -TERM "${pid}" 2>/dev/null || true
  done
  local waited=0
  while (( waited < 10 )); do
    local alive=false
    for pid in "${PIDS[@]}"; do
      if kill -0 -- "-${pid}" 2>/dev/null; then alive=true; fi
    done
    $alive || break
    sleep 0.5
    (( waited += 1 ))
  done
  for pid in "${PIDS[@]}"; do
    kill -KILL -- "-${pid}" 2>/dev/null || true
  done
  ok "Stopped"
}
trap 'cleanup; exit 0' INT TERM
trap cleanup EXIT

start() {
  local name="$1" colour="$2"
  shift 2
  local prefix="${colour}[${name}]${RESET}"
  # setsid puts the service and its log prefixer in a new session, so that $!
  # is the session leader and one signal reaches the whole tree.
  setsid bash -c "$* 2>&1 | sed -u \"s|^|${prefix} |\"" &
  PIDS+=("$!")
  NAMES+=("$name")
}

wait_for() {
  local url="$1" name="$2" tries=90
  while (( tries-- > 0 )); do
    if curl -fsS -o /dev/null --max-time 2 "$url" 2>/dev/null; then
      ok "$name is up at $url"
      return 0
    fi
    sleep 1
  done
  warn "$name did not answer at $url yet; it may still be compiling."
}

printf '\n'
say "Starting ClinicCare (${MODE} mode)"

if $RUN_API; then
  if [[ "$MODE" == prod ]]; then
    start api "$CYAN" "cd '$ROOT/apps/api' && node --env-file=.env dist/main.js"
  else
    start api "$CYAN" "npm run start:dev --workspace @gementar/api"
  fi
fi

if $RUN_WEB; then
  if [[ "$MODE" == prod ]]; then
    start web "$BLUE" "npm run start --workspace @gementar/web -- --port $WEB_PORT"
  else
    start web "$BLUE" "npm run dev --workspace @gementar/web -- --port $WEB_PORT"
  fi
fi

if command -v curl >/dev/null; then
  ( $RUN_API && wait_for "http://localhost:${API_PORT}/api/v1/health" "API"
    $RUN_WEB && wait_for "http://localhost:${WEB_PORT}/login" "Web"
    printf '%s\n' "${DIM}   Sign in at http://localhost:${WEB_PORT}/login — Ctrl-C stops everything.${RESET}"
  ) &
fi

# Watch the services themselves. If one dies, take the others down rather than
# leaving half a system running behind a green terminal.
while true; do
  for i in "${!PIDS[@]}"; do
    if ! kill -0 "${PIDS[$i]}" 2>/dev/null; then
      $SHUTTING_DOWN && exit 0
      warn "${NAMES[$i]} exited. Stopping the rest."
      exit 1
    fi
  done
  sleep 2
done
