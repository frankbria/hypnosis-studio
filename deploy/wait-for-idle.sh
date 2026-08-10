#!/usr/bin/env bash
# Block until no render is in flight, so a deploy cannot restart the service
# mid-render and destroy work a customer paid for (issue #4).
#
#   wait-for-idle.sh <health-url> [timeout-seconds] [poll-seconds]
#
# Exit 0 — safe to restart.
# Exit 1 — a render was STILL in flight at the timeout; do not restart.
#
# FAIL-OPEN BY DESIGN. This waits only when it can positively see that a render
# is running. An absent field, a malformed body, or an unreachable endpoint all
# mean "go ahead":
#
#   * absent field — the server running in production when this first ships
#     predates it. Waiting for it to appear would hang this change's own first
#     deploy for the full timeout and then fail it.
#   * unreachable — the service is already down; refusing to restart strands it.
#
# The cost of waiting wrongly is a deploy that hangs and fails on every push,
# forever. The cost of proceeding wrongly is one lost render — worse per event,
# but far rarer and self-correcting.
set -uo pipefail

URL="${1:?usage: wait-for-idle.sh <health-url> [timeout-seconds] [poll-seconds]}"
TIMEOUT="${2:-1500}"   # 25 min; a render is 15-20
POLL="${3:-15}"

deadline=$(( SECONDS + TIMEOUT ))

while :; do
  # -f so a non-200 is an error; failures fall through to the fail-open branch.
  body="$(curl -sf --max-time 10 "$URL" 2>/dev/null || true)"

  # Tolerate whitespace between the key and the value; the server emits compact
  # JSON, but this must not become brittle if that ever changes.
  if ! printf '%s' "$body" | grep -Eq '"rendering"[[:space:]]*:[[:space:]]*true'; then
    echo "wait-for-idle: no render in flight — safe to restart"
    exit 0
  fi

  remaining=$(( deadline - SECONDS ))
  if [ "$remaining" -le 0 ]; then
    echo "wait-for-idle: a render is STILL in flight after ${TIMEOUT}s — refusing to restart." >&2
    echo "wait-for-idle: restarting now would kill the worker and destroy a paid render." >&2
    echo "wait-for-idle: re-run this deploy once it finishes." >&2
    exit 1
  fi

  echo "wait-for-idle: render in flight — waiting (${remaining}s left)"
  sleep "$POLL"
done
