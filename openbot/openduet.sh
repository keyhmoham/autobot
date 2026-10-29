#!/usr/bin/env sh
# One command for the whole OpenDuet platform in containers.
#
#   ./openduet.sh up [--nomad] [--no-bots]   build and start everything (detached)
#   ./openduet.sh down [-v]                  stop it (data volumes are kept unless -v)
#   ./openduet.sh restart [service]          restart one service, or all of them
#   ./openduet.sh logs [service]             follow logs
#   ./openduet.sh ps                         show what is running
#   ./openduet.sh cli <command...>           run the openduet CLI against this stack
#
# `up` makes .env from .env.example the first time, and the secrets the stack needs (the encryption
# key, the gateway key, the supervisor's and computers' tokens, the worker's secret) whenever one is
# missing. It never changes one that is already set: data is encrypted with them.
set -eu
cd "$(dirname "$0")"

compose() {
  docker compose -f docker-compose.yml -f docker-compose.platform.yml "$@"
}

secret() {
  head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
}

# Append NAME=value to .env unless it already holds a value, from the environment or the file.
ensure_setting() {
  name="$1"
  value="$2"
  eval "current=\${$name:-}"
  if [ -z "$current" ] && ! grep -qs "^$name=." .env; then
    # A blank line for this name from .env.example would win over nothing; drop it first.
    if grep -qs "^$name=$" .env; then
      sed -i.bak "/^$name=$/d" .env && rm -f .env.bak
    fi
    printf '%s=%s\n' "$name" "$value" >> .env
    echo "made $name in .env"
  fi
}

prepare() {
  if [ ! -f .env ]; then
    cp .env.example .env
    # The example's key is a placeholder everybody has; a new deployment gets its own.
    sed -i.bak '/^KEY_ENCRYPTION_KEY=/d' .env && rm -f .env.bak
    echo "made .env from .env.example"
  fi
  ensure_setting KEY_ENCRYPTION_KEY "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  ensure_setting BETTER_AUTH_SECRET "$(secret)"
  ensure_setting LLM_GATEWAY_KEY "odg-$(secret)"
  ensure_setting SUPERVISOR_TOKEN "$(secret)"
  ensure_setting COMPUTER_TOKEN "$(secret)"
  ensure_setting WORKER_SHARED_SECRET "$(secret)"
  ensure_setting COMPOSE_PROJECT_NAME "openduet"
}

cmd="${1:-up}"
[ $# -gt 0 ] && shift

case "$cmd" in
  up)
    profiles=""
    services=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --nomad)
          profiles="--profile nomad"
          export COMPUTER_BACKEND=nomad
          ;;
        --no-bots)
          # The platform without the Bots that run in their own containers; built-in Bots still run.
          services="postgres migrate agent-computer supervisor server worker"
          ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
      esac
      shift
    done
    prepare
    [ -n "$profiles" ] && mkdir -p "${NOMAD_DATA_DIR:-/tmp/openduet-nomad}"
    # shellcheck disable=SC2086 # word splitting is wanted: these are lists.
    compose $profiles up -d --build $services
    port="$(grep -s '^SERVER_PORT=' .env | tail -1 | cut -d= -f2)"
    echo
    echo "OpenDuet:  http://localhost:${port:-3001}"
    echo "Then open Admin → Models to add a model provider and its keys, and Admin → Billing to"
    echo "decide whether work is charged. From a terminal: ./openduet.sh cli login http://localhost:${port:-3001}"
    ;;
  down) compose --profile nomad down "$@" ;;
  restart) compose restart "$@" ;;
  logs) compose logs -f "$@" ;;
  ps) compose ps "$@" ;;
  cli) exec bun cli/src/index.ts "$@" ;;
  *)
    echo "usage: $0 {up [--nomad] [--no-bots] | down [-v] | restart [service] | logs [service] | ps | cli <command...>}" >&2
    exit 2
    ;;
esac
