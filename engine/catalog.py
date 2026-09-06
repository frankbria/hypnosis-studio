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
import datetime
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


def parse_time(value):
    """An ISO timestamp, or None if it is not one.

    Timestamps arrive from two places that format differently: the engine writes
    `datetime.now(timezone.utc).isoformat()` (`+00:00`), and the approvals file
    is hand-edited, where `Z` is what people type. Comparing those as strings
    silently mis-orders them — `"Z" > "+"` — so they are parsed, not compared raw.

    An offset-less value is rejected rather than assumed to be UTC. `2026-09-05T10:00:00`
    parses perfectly happily into a *naive* datetime, and comparing one of those
    to the engine's aware `createdAt` raises TypeError — from a call site outside
    the per-combination guard, so a single hand-typed `at` missing its `Z` took
    down the whole run after the rendering and before the manifest write.
    Guessing UTC instead would be worse: it silently backdates or postdates a
    sign-off by up to a day, and the sign-off is what gates selling the audio.
    """
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else None


def approval_problems(key: str, entry, rendered_at=None) -> list:
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

    listened_at = parse_time(entry.get("at"))
    if not entry.get("at"):
        problems.append(f"{key}: listen has no timestamp")
    elif listened_at is None:
        problems.append(
            f"{key}: listen timestamp {entry['at']!r} is not an ISO 8601 time "
            f"with a timezone (e.g. 2026-09-05T10:00:00Z)")
    if not entry.get("by"):
        problems.append(f"{key}: listen does not say who listened")

    # A listen of a file that no longer exists is not a listen. `--force`
    # re-renders in place, so the masters can change under a sign-off without
    # anything else moving; the README says to re-approve by appending, and this
    # is what makes that a rule rather than a convention.
    rendered = parse_time(rendered_at)
    if rendered and listened_at and listened_at < rendered:
        problems.append(
            f"{key}: the listen at {entry['at']} predates the masters rendered "
            f"at {rendered_at} — this program was re-rendered since it was "
            f"signed off, so it needs listening to again")
    return problems


def full_listen_problems(approvals: dict, program_keys, rendered_at=None) -> list:
    """The catalog-wide rule: at least one program listened to end to end.

    Per-program approval alone would let all ten be signed off with spot-checks,
    and the point of the full listen is to confirm the *chain* — that the
    narration, whisper layer, bed and master fit together over 13 minutes, which
    three seeks cannot show.
    """
    rendered_at = rendered_at or {}
    index = approvals_by_program(approvals)
    # Validated, not merely present. A record missing its `at` or `by` does not
    # count for the program it names, and a record that does not count for one
    # program cannot be what satisfies the catalog-wide rule for all ten.
    full = [k for k in program_keys
            if index.get(k, {}).get("listen") == LISTEN_FULL
            and not approval_problems(k, index[k], rendered_at.get(k))]
    if not full:
        return [("no program has been listened to end to end — the revised "
                 "criterion on #58 requires exactly that for one of them")]
    return []


def merge_untouched(fresh: list, prior: list, key_field: str, keep=None) -> list:
    """`fresh` plus whatever in `prior` this run did not touch.

    A `--only` run renders a subset. Writing just that subset would delete the
    other nine programs from the committed manifest — and from the QA report,
    which is the evidence behind the manifest's verdicts. Losing the evidence
    while keeping the verdict is the worse half: the catalog would assert
    results that nothing records.

    `keep` is the set of keys that still exist — the combinations the engine can
    currently produce. Without it, carrying forward is unbounded: a goal or voice
    set removed from the registries stops appearing in any run's todo list, so
    nothing ever writes a fresh entry over it, and its last verdict is carried
    forward forever. Serving reads `publishable`, so that is a program the engine
    can no longer render still being sold.
    """
    rendered = {entry[key_field] for entry in fresh}
    return fresh + [entry for entry in prior
                    if entry[key_field] not in rendered
                    and (keep is None or entry[key_field] in keep)]


def build_program(goal: str, goal_title: str, voice_set: str, tracks: list,
                  qa_problems: list, checked_at: str, approval,
                  rendered_at=None) -> dict:
    """One catalog entry, with its own verdict already resolved.

    `publishable` is stored rather than recomputed by every reader. The
    alternative is each consumer — the server, the web build, an operator
    reading the file — re-deriving eligibility from the QA and approval fields,
    and the one that gets it wrong sells an unapproved master.
    """
    key = program_key(goal, voice_set)
    blockers = ([f"{key}: {p}" for p in qa_problems]
                + approval_problems(key, approval, rendered_at))
    return {
        "key": key,
        "goal": goal,
        "goalTitle": goal_title,
        "voiceSet": voice_set,
        # When the masters themselves were made, from the program's own
        # manifest — not when they were last measured. Re-running the driver
        # re-measures without re-rendering, so anchoring a sign-off to the
        # check time would invalidate every listen on every run.
        "renderedAt": rendered_at,
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
        approvals, [p["key"] for p in catalog["programs"]],
        {p["key"]: p.get("renderedAt") for p in catalog["programs"]})
    # The catalog-wide rule demotes everything: without one end-to-end listen,
    # no individual sign-off is trusted, because what is unverified is the chain
    # they all share.
    # An entry written before `renderedAt` existed cannot have its listen checked
    # against the audio, and those are exactly the catalogs that may hold the
    # damage the check was added for — a sign-off from before a `--force`
    # re-render done under the old code. Unverifiable is treated as unapproved:
    # re-measuring costs one skip-only run and no TTS, so the safe answer is
    # cheap. Fresh entries always carry the key, so this only bites once.
    for p in catalog["programs"]:
        if "renderedAt" not in p:
            p["publishable"] = False
            p["blockers"] = p["blockers"] + [
                (f"{p['key']}: predates the renderedAt field, so its listen "
                 f"cannot be checked against the audio — re-run the driver for "
                 f"this combination to re-measure it (no TTS, it is already "
                 f"rendered)")]
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
