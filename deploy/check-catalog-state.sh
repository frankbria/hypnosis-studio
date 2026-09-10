#!/usr/bin/env bash
# Refuse to deploy over state the box generated and the repo does not carry (#146).
#
# Usage: check-catalog-state.sh BOX_FILE REPO_FILE {catalog|approvals}
#   exit 0 — nothing on the box would be lost; deploy may proceed
#   exit 1 — the copy would destroy state, or cannot be shown not to; deploy stops
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
"$PYTHON" - "$BOX_FILE" "$REPO_FILE" "$KIND" <<'PYEOF'
import datetime
import json
import sys

box_path, repo_path, kind = sys.argv[1], sys.argv[2], sys.argv[3]

SCHEMA_VERSION = 1  # keep in step with engine/catalog.py


def normalize_time(value):
    """A timestamp as a comparable instant, or the raw text if it will not parse.

    engine/catalog.py:100-103 documents that these arrive spelled two legal ways:
    `Z` when a human typed it, `+00:00` from the engine's isoformat(). They are
    the same instant, and comparing the raw strings blocks a deploy that loses
    nothing.
    """
    if not isinstance(value, str) or not value:
        return "an unrecorded time"
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return value
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(datetime.timezone.utc)
    return parsed.isoformat()


def entries(path):
    """`(status, value)` for one file.

    Four outcomes rather than one None, because they call for opposite answers
    and collapsing them is how a guard silently stops guarding:

      ok           — the set of things this file holds
      unparseable  — not JSON at all. server.js already treats a manifest it
                     cannot parse as no manifest, so nothing on the box is
                     serving from it and there is no state left to protect.
      unreadable   — it may be full of programs; we simply cannot see it. A
                     permissions error is not evidence of emptiness.
      unrecognised — parsed, but not a shape this guard understands, including a
                     schemaVersion it was not written against. The file may hold
                     everything, and we cannot prove otherwise.
    """
    try:
        with open(path, encoding="utf-8") as f:
            raw = f.read()
    except OSError as e:
        return ("unreadable", f"{type(e).__name__}: {e}")
    try:
        data = json.loads(raw)
    except ValueError:
        return ("unparseable", None)
    if not isinstance(data, dict):
        return ("unrecognised", "the file is not a JSON object")

    version = data.get("schemaVersion")
    if version is not None and version != SCHEMA_VERSION:
        return ("unrecognised",
                f"schemaVersion is {version!r}, and this guard only understands "
                f"{SCHEMA_VERSION}")

    if kind == "catalog":
        programs = data.get("programs")
        if not isinstance(programs, list):
            return ("unrecognised", "`programs` is not a list")
        out = set()
        for p in programs:
            if not isinstance(p, dict):
                return ("unrecognised",
                        "`programs` holds something that is not an object")
            key = p.get("key")
            if key:
                # `is True`, not truthiness: a string "false" would otherwise
                # read as publishable on one side only and mis-identify.
                out.add(f"{key} (publishable)" if p.get("publishable") is True
                        else str(key))
        return ("ok", out)

    listens = data.get("listens")
    if not isinstance(listens, list):
        return ("unrecognised", "`listens` is not a list")
    out = set()
    for entry in listens:
        if not isinstance(entry, dict):
            return ("unrecognised", "`listens` holds something that is not an object")
        program = entry.get("program")
        if program:
            # The kind of listen is part of the identity. catalog.py treats a
            # full listen and a spot check as different claims, and #58's
            # criterion needs one full listen across the catalog — so a full one
            # quietly replaced by a spot one can take every publishable program
            # with it.
            listen = entry.get("listen") or "an unrecorded kind"
            out.add(f"{program} — {listen} listen @ "
                    f"{normalize_time(entry.get('at'))}")
    return ("ok", out)


def refuse(message):
    print(f"catalog-state: {message}", file=sys.stderr)
    sys.exit(1)


box_status, box = entries(box_path)

if box_status == "unreadable":
    refuse(f"the {kind} file on the box could not be opened ({box_path}): {box}\n"
           f"It may hold everything this deploy is about to overwrite. Refusing "
           f"rather than assuming it is empty.")

if box_status == "unrecognised":
    refuse(f"the {kind} file on the box is not a shape this guard understands "
           f"({box_path}): {box}\n"
           f"Refusing, because a file this guard cannot read is a file it cannot "
           f"prove is safe to overwrite. If the schema changed, update "
           f"deploy/check-catalog-state.sh alongside engine/catalog.py.")

# The one pass, and narrow on purpose.
if box_status == "unparseable":
    print(f"catalog-state: the {kind} file on the box is not valid JSON "
          f"({box_path}) — nothing is serving from it, so there is nothing to "
          f"lose. Proceeding. Note that a pre-render interrupted mid-write would "
          f"look exactly like this.")
    sys.exit(0)

if not box:
    print(f"catalog-state: the {kind} file on the box is empty — nothing to lose")
    sys.exit(0)

repo_status, repo = entries(repo_path)

count = f"{len(box)} {kind} entr{'y' if len(box) == 1 else 'ies'}"
if repo_status != "ok":
    detail = f": {repo}" if repo else ""
    refuse(f"the box holds {count}, and the {kind} file in this commit is "
           f"{repo_status} ({repo_path}){detail}.\n"
           f"Refusing to deploy: this copy cannot be shown to preserve what the "
           f"box has.")

lost = sorted(box - repo)
if not lost:
    print(f"catalog-state: this commit carries everything the box has "
          f"({count}) — safe to deploy")
    sys.exit(0)

listed = "\n  ".join(lost)
one = len(lost) == 1
noun = "program" if kind == "catalog" else "recorded listen"
filename = "catalog.json" if kind == "catalog" else "catalog-approvals.json"

# What it actually costs, per file. The manifest is rebuildable from masters that
# are still on disk; a listen is not rebuildable by anything, and saying so is the
# difference between an operator retrying and an operator bypassing the check.
if kind == "catalog":
    stakes = ("Re-running the pre-render would rebuild this — it skips "
              "combinations whose masters exist — but the storefront quotes "
              "track lengths from this file (#14, #15), so the repo needs it "
              "either way.")
else:
    stakes = ("Nothing can regenerate this. `engine/catalog.py` requires a "
              "recorded human listen before a program is publishable, so losing "
              "it means listening to those programs again.")

refuse(
    f"this deploy would destroy {len(lost)} {noun}"
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
    f"See the pre-render loop in DEPLOYMENT.md.")
PYEOF
