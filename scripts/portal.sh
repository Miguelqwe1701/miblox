#!/usr/bin/env bash
# Start, stop or restart the MiBlox portal for local development.
#
# Uses a pidfile rather than pkill: matching on a command-line pattern can
# catch the shell that is running this script, which kills your own session.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PIDFILE="${ROOT}/data/portal.pid"
LOGFILE="${ROOT}/data/portal.log"

: "${MIBLOX_PORT:=3000}"
: "${MIBLOX_CLIENT_DIR:=${ROOT}/packages/client/dist}"
: "${MIBLOX_PLACES_DIR:=${ROOT}/places}"
: "${MIBLOX_TICKET_SECRET:=dev-ticket-secret-change-me}"
export MIBLOX_PORT MIBLOX_CLIENT_DIR MIBLOX_PLACES_DIR MIBLOX_TICKET_SECRET

stop_portal() {
  # A stale pidfile - one left behind by a crash, or restored from git - would
  # otherwise leave the running portal alone and let the replacement fail with
  # EADDRINUSE while "restart" still reported success.
  if [[ -f "$PIDFILE" ]]; then
    local pid
    pid="$(cat "$PIDFILE")"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      for _ in $(seq 1 20); do
        kill -0 "$pid" 2>/dev/null || break
        sleep 0.25
      done
      kill -KILL "$pid" 2>/dev/null || true
    fi
    rm -f "$PIDFILE"
  fi
  # Belt and braces: anything still holding the port is a portal we started.
  local holder
  holder="$(pgrep -f "node .*packages/server/dist/main.js" || true)"
  for pid in $holder; do
    kill -TERM "$pid" 2>/dev/null || true
  done
  for _ in $(seq 1 20); do
    curl -sf -o /dev/null "http://localhost:${MIBLOX_PORT}/api/games" || return 0
    sleep 0.25
  done
  for pid in $holder; do
    kill -KILL "$pid" 2>/dev/null || true
  done
}

start_portal() {
  mkdir -p "${ROOT}/data"
  setsid nohup node "${ROOT}/packages/server/dist/main.js" >"$LOGFILE" 2>&1 </dev/null &
  local pid=$!
  echo "$pid" >"$PIDFILE"
  for _ in $(seq 1 40); do
    # Check the process we just started is the one answering: a portal left
    # over from a previous run answers just as happily, and a restart that
    # accepts that answer serves a stale build for the rest of the session.
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "portal exited on startup; last log lines:" >&2
      tail -20 "$LOGFILE" >&2
      return 1
    fi
    if curl -sf -o /dev/null "http://localhost:${MIBLOX_PORT}/api/games"; then
      echo "portal up on http://localhost:${MIBLOX_PORT}"
      return 0
    fi
    sleep 0.25
  done
  echo "portal failed to start; last log lines:" >&2
  tail -20 "$LOGFILE" >&2
  return 1
}

case "${1:-restart}" in
  start) start_portal ;;
  stop) stop_portal; echo "portal stopped" ;;
  restart) stop_portal; start_portal ;;
  status) curl -sf "http://localhost:${MIBLOX_PORT}/api/games" >/dev/null && echo up || echo down ;;
  *) echo "usage: $0 {start|stop|restart|status}" >&2; exit 2 ;;
esac
