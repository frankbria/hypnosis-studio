"""Tests for catalog — what may be published, and what the storefront may quote.

Stdlib only, deliberately, like test_qa.py: this is the gate on a $39
deliverable, so it has to be reachable without numpy, soundfile, a pad or a
real render. Nothing here touches audio.

The failure this exists to prevent (#58): a master that renders fine and passes
the automated gate but that nobody has actually listened to being sold anyway.
The automated gate catches silence, a dead mix and a truncated file. It cannot
hear that the whisper layer is sitting on top of the narration instead of under
it, and that is the whole reason a human listen is still in the criteria.
"""
import json
import os
import sys

import pytest

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import catalog  # noqa: E402

TRACKS = [
    {"n": 1, "id": "polymath_track1", "title": "I", "phase": "Foundation",
     "durationSec": 812.4, "wav": "p/1.wav", "mp3": "p/1.mp3"},
    {"n": 2, "id": "polymath_track2", "title": "II", "phase": "Deepening",
     "durationSec": 830.0, "wav": "p/2.wav", "mp3": "p/2.mp3"},
    {"n": 3, "id": "polymath_track3", "title": "III", "phase": "Mastery",
     "durationSec": 805.5, "wav": "p/3.wav", "mp3": "p/3.mp3"},
    {"n": 4, "id": "polymath_track4", "title": "IV", "phase": "Integration",
     "durationSec": 441.1, "wav": "p/4.wav", "mp3": "p/4.mp3"},
]

FULL = {"listen": "full", "at": "2026-09-05T10:00:00Z", "by": "frankbria"}
SPOT = {"listen": "spot", "at": "2026-09-05T10:30:00Z", "by": "frankbria",
        "boundaries": list(catalog.PHASE_BOUNDARIES)}


def program(goal="polymath", voice_set="male", qa_problems=(), approval=FULL,
            tracks=None):
    return catalog.build_program(
        goal=goal, goal_title="The Polymath Mind", voice_set=voice_set,
        tracks=list(tracks if tracks is not None else TRACKS),
        qa_problems=list(qa_problems), checked_at="2026-09-05T09:00:00Z",
        approval=approval)


# ---------------------------------------------------------------- keys

def test_program_key_survives_a_goal_that_already_has_an_underscore():
    # Single underscore would make golden_thread__male ambiguous with a goal
    # named "golden" and a voice set named "thread_male".
    key = catalog.program_key("golden_thread", "male")
    assert key == "golden_thread__male"
    assert key.split("__") == ["golden_thread", "male"]


# ---------------------------------------------------------------- the two gates

def test_a_clean_approved_program_is_publishable():
    p = program()
    assert p["publishable"]
    assert p["blockers"] == []
    assert p["qa"]["passed"]


def test_a_qa_failure_blocks_publication_and_says_which_track():
    p = program(qa_problems=["polymath_track3: 41% of the track is dead air"])
    assert not p["publishable"]
    assert any("dead air" in b for b in p["blockers"])
    assert not p["qa"]["passed"]


def test_a_program_nobody_listened_to_is_not_publishable():
    # The case this module exists for: renders clean, gate passes, unheard.
    p = program(approval=None)
    assert not p["publishable"]
    assert any("no listen recorded" in b for b in p["blockers"])


def test_the_qa_record_is_kept_even_when_the_gate_passed():
    # "with results recorded" is an acceptance criterion in its own right —
    # a passing run has to leave evidence, not just an absence of complaints.
    p = program()
    assert p["qa"]["checkedAt"] == "2026-09-05T09:00:00Z"
    assert p["qa"]["problems"] == []


def test_total_duration_is_the_sum_of_the_measured_tracks():
    assert program()["totalDurationSec"] == pytest.approx(2889.0)


# ---------------------------------------------------------------- spot-checks

def test_a_spot_check_covering_every_boundary_counts():
    assert program(approval=SPOT)["publishable"]


def test_a_spot_check_missing_a_boundary_does_not_count():
    partial = dict(SPOT, boundaries=["induction-start", "first-suggestion"])
    p = program(approval=partial)
    assert not p["publishable"]
    assert any("resurface-start" in b for b in p["blockers"])


def test_the_same_boundary_three_times_is_not_three_boundaries():
    # A count would accept this. The record names boundaries for that reason.
    repeated = dict(SPOT, boundaries=["induction-start"] * 3)
    p = program(approval=repeated)
    assert not p["publishable"]


def test_a_listen_with_no_timestamp_or_listener_is_not_a_record():
    for missing in ("at", "by"):
        entry = {k: v for k, v in FULL.items() if k != missing}
        assert not program(approval=entry)["publishable"]


def test_an_unknown_listen_kind_is_rejected_rather_than_assumed_full():
    assert not program(approval=dict(FULL, listen="skimmed"))["publishable"]


# ---------------------------------------------------------------- catalog-wide

def test_without_one_end_to_end_listen_nothing_is_publishable():
    # Ten spot-checks are not a substitute for one full listen: three seeks
    # cannot show that the chain holds together over thirteen minutes.
    approvals = {"listens": [
        dict(SPOT, program="polymath__male"),
        dict(SPOT, program="polymath__female"),
    ]}
    built = catalog.build_catalog(
        [program(voice_set="male", approval=SPOT),
         program(voice_set="female", approval=SPOT)],
        approvals, "2026-09-05T11:00:00Z")
    assert built["fullListenProblems"]
    assert not any(p["publishable"] for p in built["programs"])


def test_one_full_listen_lets_the_spot_checked_programs_through():
    approvals = {"listens": [
        dict(FULL, program="polymath__male"),
        dict(SPOT, program="polymath__female"),
    ]}
    built = catalog.build_catalog(
        [program(voice_set="male", approval=FULL),
         program(voice_set="female", approval=SPOT)],
        approvals, "2026-09-05T11:00:00Z")
    assert built["fullListenProblems"] == []
    assert all(p["publishable"] for p in built["programs"])


def test_programs_are_sorted_so_the_committed_file_does_not_churn():
    built = catalog.build_catalog(
        [program(voice_set="male"), program(voice_set="female")],
        {"listens": [dict(FULL, program="polymath__male")]},
        "2026-09-05T11:00:00Z")
    assert [p["key"] for p in built["programs"]] == [
        "polymath__female", "polymath__male"]


def test_the_newest_listen_for_a_program_wins():
    # A re-render invalidates the earlier listen: it was of a file that no
    # longer exists. Re-approving by appending has to actually take effect.
    index = catalog.approvals_by_program({"listens": [
        dict(SPOT, program="polymath__male"),
        dict(FULL, program="polymath__male"),
    ]})
    assert index["polymath__male"]["listen"] == "full"


# ---------------------------------------------------------------- storefront

def test_durations_quote_the_shorter_voice_set():
    # #14's rule: advertise the floor, so the quote can only under-promise.
    female_tracks = [dict(t, durationSec=t["durationSec"] - 12.0) for t in TRACKS]
    built = catalog.build_catalog(
        [program(voice_set="male"),
         program(voice_set="female", tracks=female_tracks)],
        {"listens": [dict(FULL, program="polymath__male")]},
        "2026-09-05T11:00:00Z")
    assert catalog.durations_by_goal(built)["polymath"] == [
        800.4, 818.0, 793.5, 429.1]


def test_an_unpublishable_program_is_never_quoted():
    built = catalog.build_catalog(
        [program(voice_set="male"), program(voice_set="female", approval=None)],
        {"listens": [dict(FULL, program="polymath__male")]},
        "2026-09-05T11:00:00Z")
    # Only the male program survives, so its own durations are the quote.
    assert catalog.durations_by_goal(built)["polymath"] == [
        t["durationSec"] for t in TRACKS]


def test_an_empty_catalog_quotes_nothing_rather_than_failing():
    # This is the committed starting state, and the storefront falls back to
    # the engine floors from it. It must not be an error.
    built = catalog.build_catalog([], catalog.empty_approvals(), "t")
    assert catalog.durations_by_goal(built) == {}


def test_voice_sets_that_disagree_on_track_count_quote_nothing():
    # zip() would truncate to the shorter run and quietly drop track IV from
    # the quote — a worse lie than the length it would have fixed. Omitting the
    # goal falls the storefront back to the engine floors, which under-promises.
    built = catalog.build_catalog(
        [program(voice_set="male"),
         program(voice_set="female", tracks=TRACKS[:3])],
        {"listens": [dict(FULL, program="polymath__male")]},
        "2026-09-05T11:00:00Z")
    assert "polymath" not in catalog.durations_by_goal(built)


def test_the_quote_is_derived_once_and_carried_in_the_manifest():
    # The frontend reads durationsByGoal directly; a second implementation of
    # "which length do we quote" in TypeScript would be free to drift.
    built = catalog.build_catalog(
        [program(voice_set="male"), program(voice_set="female")],
        {"listens": [dict(FULL, program="polymath__male")]},
        "2026-09-05T11:00:00Z")
    assert built["durationsByGoal"] == catalog.durations_by_goal(built)
    assert built["durationsByGoal"]["polymath"] == [
        t["durationSec"] for t in TRACKS]


# ---------------------------------------------------------------- file loading

def test_a_missing_approvals_file_reads_as_nothing_approved(tmp_path):
    default = catalog.empty_approvals()
    assert catalog.load_json(str(tmp_path / "nope.json"), default) == default


def test_a_corrupt_approvals_file_stops_the_run(tmp_path):
    # Degrading to "nothing is approved" reads identically to an honest empty
    # file, and would send someone re-listening to ten signed-off programs.
    path = tmp_path / "approvals.json"
    path.write_text("{ not json", encoding="utf-8")
    with pytest.raises(json.JSONDecodeError):
        catalog.load_json(str(path), catalog.empty_approvals())


def test_the_committed_catalog_is_the_empty_one_this_module_builds():
    # The web build imports engine/catalog.json, so its committed shape is a
    # contract. Drift here is a broken frontend build, not a stale fixture.
    with open(os.path.join(ENGINE, "catalog.json"), encoding="utf-8") as f:
        committed = json.load(f)
    built = catalog.build_catalog([], catalog.empty_approvals(),
                                  committed["generatedAt"])
    assert committed == built


# ---------------------------------------------------------------- partial runs

def test_a_partial_run_keeps_the_programs_it_did_not_touch():
    fresh = [{"key": "polymath__male", "v": "new"}]
    prior = [{"key": "polymath__male", "v": "old"},
             {"key": "river__female", "v": "kept"}]
    merged = catalog.merge_untouched(fresh, prior, "key")
    assert merged == [{"key": "polymath__male", "v": "new"},
                      {"key": "river__female", "v": "kept"}]


def test_a_partial_run_keeps_the_qa_evidence_for_those_programs():
    # Losing the evidence while keeping the verdict is the worse half: the
    # catalog would assert results that nothing records.
    merged = catalog.merge_untouched(
        [{"program": "polymath__male", "problems": []}],
        [{"program": "river__female", "problems": ["dead air"]}], "program")
    assert {m["program"] for m in merged} == {"polymath__male", "river__female"}


def test_a_full_run_with_no_prior_file_merges_to_itself():
    fresh = [{"key": "polymath__male"}]
    assert catalog.merge_untouched(fresh, [], "key") == fresh
