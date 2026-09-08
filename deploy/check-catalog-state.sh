#!/usr/bin/env bash
# Refuse to deploy over state the box generated and the repo does not carry (#146).
#
# Usage: check-catalog-state.sh BOX_FILE REPO_FILE {catalog|approvals}
#   exit 0 — nothing on the box would be lost; deploy may proceed
#   exit 1 — the copy would destroy state; deploy must stop
#
# `deploy.yml` copies `engine/**` onto the box, and two tracked files in there
# are written on the box rather than in the repo:
#
#   engine/catalog.json           — written by prerender_catalog.py, on the box
#   engine/catalog-approvals.json — the owner's record that they listened
#
# So a deploy from a commit where those are still empty silently resets the box.
# That happened: a pre-render on prod was erased by the next push, and the deploy
# reported success. The only trace was a boot log line reading
# `catalog: 0 of 0 program(s) publishable`.
#
# **This runs before the copy and fails, rather than after and restoring.** A
# restore is a second thing that has to be right on the worst day, and by the
# time it runs the file is already gone. Failing early leaves the box untouched.
#
# It also runs in the CI runner rather than on the box — it is comparing what the
# box has against what this commit carries, and the runner is the only place that
# holds both. That is what makes it a script with tests rather than inline
# workflow shell, for the same reason wait-for-idle.sh and cut-samples.sh are.
#
# The fix when this fires is never to bypass it: copy the box's file into the
# repo and commit it. The web build imports catalog.json for the durations it
# quotes (#14, #15), so the repo has to carry it anyway — this guard is what
# makes that loop mandatory instead of remembered.
set -u

if [ "$#" -ne 3 ]; then
  echo "check-catalog-state: usage: $0 BOX_FILE REPO_FILE {catalog|approvals}" >&2
  exit 1
fi

BOX_FILE=$1
REPO_FILE=$2
KIND=$3

case "$KIND" in
  catalog|approvals) ;;
  *)
    # Never degrade to "pass" on a bad argument: a typo in deploy.yml would
    # otherwise silently switch the guard off and read as green forever.
    echo "check-catalog-state: unknown kind '$KIND' (want catalog or approvals)" >&2
    exit 1
    ;;
esac

# Nothing on the box yet. Every box is in this state until the first pre-render.
if [ ! -f "$BOX_FILE" ]; then
  echo "catalog-state: no $KIND file on the box yet — nothing to lose"
  exit 0
fi

PYTHON=${HYPNO_PYTHON:-python3}

# Fail closed. A guard that waves the deploy through because its interpreter is
# missing is worse than no guard: it reads as a passing check. The engine is
# Python, so a box without python3 is already broken in a louder way.
if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "check-catalog-state: no interpreter at '$PYTHON' — cannot verify that" \
       "this deploy preserves the box's $KIND state. Refusing rather than" \
       "guessing. Set HYPNO_PYTHON to a python3 if it lives elsewhere." >&2
  exit 1
fi

# Each side reduces to a set of strings identifying what it holds. A deploy is
# safe exactly when the box's set is a subset of the commit's: equal is a no-op,
# and a commit carrying more is someone deploying newly committed pre-render
# output, which is the loop working.
#
# For the catalog the identity includes `publishable`, not just the key. Both
# sides listing a program while only the box's copy is publishable is the
# subtle, worse case — it means the listen lives on the box alone, and comparing
# keys or counts would wave it through.
"$PYTHON" - "$BOX_FILE" "$REPO_FILE" "$KIND" <<'PY'
import json
import sys

box_path, repo_path, kind = sys.argv[1], sys.argv[2], sys.argv[3]


def entries(path):
    """The identifying set for one file, or None if it cannot be read."""
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(data, dict):
        return None
    if kind == "catalog":
        programs = data.get("programs")
        if not isinstance(programs, list):
            return None
        out = set()
        for p in programs:
            if not isinstance(p, dict):
                return None
            key = p.get("key")
            if key:
                out.add(f"{key} (publishable)" if p.get("publishable") else str(key))
        return out
    listens = data.get("listens")
    if not isinstance(listens, list):
        return None
    out = set()
    for entry in listens:
        if not isinstance(entry, dict):
            return None
        program = entry.get("program")
        if program:
            out.add(f"{program} @ {entry.get('at', 'unknown time')}")
    return out


box = entries(box_path)

# An unparseable file on the box is not state worth protecting: server.js already
# treats a manifest it cannot read as no manifest at all, so nothing is serving
# from it. Blocking every future deploy over a file that is already inert is the
# worse trade — but it is said out loud, because it is also how a half-written
# file looks.
if box is None:
    print(f"catalog-state: the {kind} file on the box could not be read "
          f"({box_path}) — treating it as empty. Nothing is serving from an "
          f"unparseable file, so the deploy may proceed, but a pre-render that "
          f"was interrupted mid-write would look exactly like this.")
    sys.exit(0)

if not box:
    print(f"catalog-state: the {kind} file on the box is empty — nothing to lose")
    sys.exit(0)

repo = entries(repo_path)

# The box demonstrably holds something and this commit cannot be shown to
# preserve it. Refusing is the only answer that cannot lose data.
if repo is None:
    print(f"catalog-state: the box holds {len(box)} {kind} entr"
          f"{'y' if len(box) == 1 else 'ies'}, and the {kind} file in this "
          f"commit could not be read ({repo_path}).\n"
          f"Refusing to deploy: this copy cannot be shown to preserve what the "
          f"box has.", file=sys.stderr)
    sys.exit(1)

lost = sorted(box - repo)
if not lost:
    print(f"catalog-state: this commit carries everything the box has "
          f"({len(box)} {kind} entr{'y' if len(box) == 1 else 'ies'}) — safe to deploy")
    sys.exit(0)

listed = "\n  ".join(lost)
one = len(lost) == 1
noun = "program" if kind == "catalog" else "recorded listen"
filename = "catalog.json" if kind == "catalog" else "catalog-approvals.json"

# What it actually costs, per file. The manifest is rebuildable from masters
# that are still on disk; a listen is not rebuildable by anything, and saying so
# is the difference between an operator retrying and an operator bypassing.
if kind == "catalog":
    stakes = ("Re-running the pre-render would rebuild this — it skips "
              "combinations whose masters exist — but the storefront quotes "
              "track lengths from this file (#14, #15), so the repo needs it "
              "either way.")
else:
    stakes = ("Nothing can regenerate this. `engine/catalog.py` requires a "
              "recorded human listen before a program is publishable, so "
              "losing it means listening to those programs again.")

print(
    f"catalog-state: this deploy would destroy {len(lost)} {noun}"
    f"{'' if one else 's'} that exist{'s' if one else ''} only on the box:\n"
    f"  {listed}\n"
    f"\n"
    f"`engine/{filename}` is tracked in git and copied onto the box by this "
    f"deploy, so a commit where it is still empty resets prod.\n"
    f"\n"
    f"Fix it by closing the loop rather than by skipping this check:\n"
    f"  1. scp prod:/srv/hypnosis-studio/engine/{filename} engine/{filename}\n"
    f"  2. git commit -- engine/{filename}\n"
    f"  3. deploy again\n"
    f"\n"
    f"{stakes}\n"
    f"See the pre-render loop in DEPLOYMENT.md.",
    file=sys.stderr)
sys.exit(1)
PY
