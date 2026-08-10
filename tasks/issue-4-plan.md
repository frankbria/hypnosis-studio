# Issue #4 — [P0.4] Stop deploys destroying in-flight paid renders

**Branch:** `feature/issue-4-drain-before-restart` · **Base:** `main` · **Plan source:** self-authored

## Problem

Every push to `main` runs `systemctl restart hypnosis-studio` unconditionally. systemd's default
`KillMode=control-group` takes the spawned Python worker with it (`spawn(..., detached: false)` puts it
in the service cgroup). The restarted server then sees a job stuck at `rendering` with a stale
`updatedAt` and marks it `failed`.

A render takes 15–20 minutes. Any deploy landing in that window destroys a customer's render and its
ElevenLabs spend. Four merges tonight, four restarts — it is only harmless because nobody is buying yet.

## Approach

The server already knows the answer: `anyJobRendering()` is the same predicate the API uses to return
409 `busy`. Expose it on `/api/health` and have the deploy wait on it, so there is **one** source of
truth rather than a second implementation in shell.

1. `/api/health` gains `rendering: <bool>`, from the existing predicate.
2. `deploy/wait-for-idle.sh` polls it and decides whether restarting is safe.
3. `deploy.yml` runs that script before `systemctl restart`.

## The decision that matters: fail-open, not fail-closed

The obvious implementation — *wait until `rendering` is `false`* — **breaks its own first deploy.**
The server running in production when this merges predates the field, so `rendering` is absent, the
condition never becomes true, and the deploy hangs for the whole timeout and then fails. The change
that fixes deploys would brick the next one.

So the script waits **only when it can positively see `"rendering":true`**. Absent field, malformed
body, or an unreachable endpoint all mean "go ahead":

| Health response | Decision | Why |
|---|---|---|
| `"rendering":true` | wait | a render is in flight — the case this exists for |
| `"rendering":false` | proceed | positively idle |
| field missing | proceed | old server (bootstrap), or a future shape change |
| unreachable / non-200 | proceed | the service is already down; restarting cannot make it worse |
| still `true` at timeout | **fail the deploy** | refuse to restart; report clearly |

Fail-open is also the right default on the merits: the failure mode of waiting wrongly is a deploy
that hangs 25 minutes and fails, on every push, forever. The failure mode of proceeding wrongly is one
lost render — bad, but self-correcting and far less likely, since it needs both a real in-flight render
*and* a health endpoint that cannot be read.

## Decisions taken autonomously

- **Timeout 25 minutes.** A render is 15–20; 25 leaves margin without a deploy hanging indefinitely.
  Configurable via env.
- **Poll on the box, not from the runner.** The app binds loopback, so `curl 127.0.0.1:4100` inside the
  existing `ssh-action` step needs no new network exposure.
- **A script in `deploy/`, not inline YAML.** The logic has five branches; inline shell in a workflow is
  the least testable place in the repo. A file can be unit-tested against stub servers, and it survives
  the move to containers (#87) where only the restart command changes.
- **Guard `anyJobRendering()`.** It does an unguarded `readdirSync`; on `/api/health` a throw would
  become a 500 and break the smoke test. Returns `false` on error, which also lands on fail-open.

## Out of scope

Graceful SIGTERM draining of in-flight *downloads* is #39. This issue is only about not starting the
restart while a render is running.

## Acceptance criteria (from the issue)

- [ ] The deploy waits (bounded) while a render is in flight, or refuses to restart and reports clearly
- [ ] A deploy triggered during a render leaves that render running and completing normally
- [ ] The timeout behaviour is documented in `DEPLOYMENT.md`
