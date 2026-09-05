"""The catalog manifest: what the ten pre-rendered programs are, and whether
each one may be published.

Stdlib only, on purpose — same reason as qa.py, job_files.py and timeline.py.
The caller does the audio I/O and the rendering and hands the results in; this
module only decides shape and eligibility, so the rules that gate a $39
deliverable are testable without numpy, soundfile, a pad, or a real render.

Two separate gates decide publication, and both have to hold (issue #58):

  * The **automated** gate — qa.check_master over all four tracks. This is the
    check the catalog path would otherwise lose by not rendering per job, and
    running it once here is strictly better than running it per customer.
  * The **human** gate — the owner listened. One program end to end, the rest
    spot-checked at phase boundaries. Recorded in a committed approvals file
    rather than remembered, because "did I listen to the female Open Gate?" is
    not a question anyone answers correctly three weeks later.

A program that passes QA but has no approval is *renderable*, not *publishable*.
Serving (#59) reads `publishable`, so an unlistened master cannot be sold by
accident.
"""
import collections
import json
import os

SCHEMA_VERSION = 1

# The three places a defect would actually show, per the revised acceptance
# criterion on #58. A spot-check record has to name all of them, so "I skipped
# around a bit" cannot be recorded as a check.
PHASE_BOUNDARIES = ("induction-start", "first-suggestion", "resurface-start")

# What an approvals entry may claim. A full listen covers the whole program; a
# spot-check covers PHASE_BOUNDARIES and nothing else.
LISTEN_FULL = "full"
LISTEN_SPOT = "spot"


def program_key(goal: str, voice_set: str) -> str:
    """Stable id for one (goal, voice set) combination.

    Double underscore because goal keys already contain single ones
    (`golden_thread`), and a key that cannot be split back apart is a key that
    invites someone to parse it wrong.
    """
    return f"{goal}__{voice_set}"


def empty_catalog(generated_at: str) -> dict:
    """A catalog with no programs in it.

    Committed as the starting state rather than leaving the file absent. The web
    build imports this file, so "no masters rendered yet" has to be a value the
    UI can read and fall back from — not a missing module that fails the build.
    """
    return {
        "schemaVersion": SCHEMA_VERSION,
        "generatedAt": generated_at,
        "programs": [],
    }


def empty_approvals() -> dict:
    return {"schemaVersion": SCHEMA_VERSION, "listens": []}


def load_json(path: str, default: dict) -> dict:
    """Read a JSON file, or return `default` if it is not there.

    Deliberately not tolerant of a *corrupt* file: an approvals file that fails
    to parse must stop the run, not silently degrade to "nothing is approved"
    (which reads identically to an honest empty file and would send someone
    re-listening to ten programs they had already signed off).
    """
    if not os.path.exists(path):
        return default
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def approvals_by_program(approvals: dict) -> dict:
    """Index the approvals file by program key, newest entry winning.

    Newest wins so a re-render can be re-approved by appending rather than by
    editing history — the earlier listen was of a file that no longer exists.
    """
    index = {}
    for entry in approvals.get("listens", []):
        key = entry.get("program")
        if key:
            index[key] = entry
    return index


def approval_problems(key: str, entry) -> list:
    """Why this program's approval record does not count. Empty means it does."""
    if not entry:
        return [f"{key}: no listen recorded — the owner has not signed this off"]

    problems = []
    kind = entry.get("listen")
    if kind not in (LISTEN_FULL, LISTEN_SPOT):
        problems.append(
            f"{key}: listen is {kind!r}, expected {LISTEN_FULL!r} or {LISTEN_SPOT!r}")
    elif kind == LISTEN_SPOT:
        # Named boundaries rather than a count, so a record cannot claim three
        # checks by listing the same one three times.
        checked = set(entry.get("boundaries") or ())
        missing = [b for b in PHASE_BOUNDARIES if b not in checked]
        if missing:
            problems.append(
                f"{key}: spot-check is missing {', '.join(missing)} — "
                f"a spot-check has to cover all of {', '.join(PHASE_BOUNDARIES)}")

    if not entry.get("at"):
        problems.append(f"{key}: listen has no timestamp")
    if not entry.get("by"):
        problems.append(f"{key}: listen does not say who listened")
    return problems


def full_listen_problems(approvals: dict, program_keys) -> list:
    """The catalog-wide rule: at least one program listened to end to end.

    Per-program approval alone would let all ten be signed off with spot-checks,
    and the point of the full listen is to confirm the *chain* — that the
    narration, whisper layer, bed and master fit together over 13 minutes, which
    three seeks cannot show.
    """
    index = approvals_by_program(approvals)
    full = [k for k in program_keys
            if index.get(k, {}).get("listen") == LISTEN_FULL]
    if not full:
        return [("no program has been listened to end to end — the revised "
                 "criterion on #58 requires exactly that for one of them")]
    return []


def merge_untouched(fresh: list, prior: list, key_field: str) -> list:
    """`fresh` plus whatever in `prior` this run did not touch.

    A `--only` run renders a subset. Writing just that subset would delete the
    other nine programs from the committed manifest — and from the QA report,
    which is the evidence behind the manifest's verdicts. Losing the evidence
    while keeping the verdict is the worse half: the catalog would assert
    results that nothing records.
    """
    rendered = {entry[key_field] for entry in fresh}
    return fresh + [entry for entry in prior
                    if entry[key_field] not in rendered]


def build_program(goal: str, goal_title: str, voice_set: str, tracks: list,
                  qa_problems: list, checked_at: str, approval) -> dict:
    """One catalog entry, with its own verdict already resolved.

    `publishable` is stored rather than recomputed by every reader. The
    alternative is each consumer — the server, the web build, an operator
    reading the file — re-deriving eligibility from the QA and approval fields,
    and the one that gets it wrong sells an unapproved master.
    """
    key = program_key(goal, voice_set)
    blockers = [f"{key}: {p}" for p in qa_problems] + approval_problems(key, approval)
    return {
        "key": key,
        "goal": goal,
        "goalTitle": goal_title,
        "voiceSet": voice_set,
        "tracks": tracks,
        "totalDurationSec": round(sum(t["durationSec"] for t in tracks), 1),
        "qa": {
            "passed": not qa_problems,
            "checkedAt": checked_at,
            "problems": list(qa_problems),
        },
        "approval": approval or None,
        "publishable": not blockers,
        "blockers": blockers,
    }


def build_catalog(programs: list, approvals: dict, generated_at: str) -> dict:
    """Merge per-program entries into the committed catalog manifest."""
    catalog = empty_catalog(generated_at)
    catalog["programs"] = sorted(programs, key=lambda p: p["key"])
    catalog["fullListenProblems"] = full_listen_problems(
        approvals, [p["key"] for p in catalog["programs"]])
    # The catalog-wide rule demotes everything: without one end-to-end listen,
    # no individual sign-off is trusted, because what is unverified is the chain
    # they all share.
    if catalog["fullListenProblems"]:
        for p in catalog["programs"]:
            p["publishable"] = False
            p["blockers"] = p["blockers"] + catalog["fullListenProblems"]
    # Derived here rather than in the frontend so there is one implementation of
    # "which length do we quote" and it lives next to the rule it enforces. The
    # web build reads this key straight out of the committed file; a second
    # implementation in TypeScript would be free to drift, and the direction it
    # drifts in is the one that over-promises at the moment of purchase.
    catalog["durationsByGoal"] = durations_by_goal(catalog)
    return catalog


def durations_by_goal(catalog: dict) -> dict:
    """Per-goal track durations for the storefront: `{goal: [s, s, s, s]}`.

    Only **publishable** programs count — a duration shown at the moment of
    purchase must come from a master that can actually be delivered.

    The two voice sets of a goal render to slightly different lengths (different
    voices, same script), and the storefront quotes one number per track. It
    quotes the **shorter** of the two, keeping the site's existing rule from
    #14: advertise the floor, so the quote can only ever under-promise.
    """
    per_goal = collections.defaultdict(list)
    for program in catalog.get("programs", []):
        if program.get("publishable"):
            per_goal[program["goal"]].append(
                [t["durationSec"] for t in program["tracks"]])

    out = {}
    for goal, runs in per_goal.items():
        # Two voice sets of one goal with different track counts means one of
        # them is not the program it claims to be. The goal is omitted rather
        # than zipped: `zip` truncates to the shorter run, which would quietly
        # drop a track from a quote — a worse lie than the length it fixes.
        # Omitted means the storefront falls back to the engine floors for this
        # goal, which under-promises, which is the safe direction (#14).
        if len({len(r) for r in runs}) == 1:
            out[goal] = [min(lengths) for lengths in zip(*runs)]
    return out
