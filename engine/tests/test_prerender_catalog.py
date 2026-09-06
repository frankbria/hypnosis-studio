"""Tests for prerender_catalog's measurement pass, against real audio files.

Real WAVs and real MP3s written to disk, decoded by the same soundfile the
production gate uses — no mocking. The whole point of `measure_program` is that
it reads what actually landed on disk rather than what the renderer believed it
wrote, and a fake would test the belief instead of the file.

Tracks here run seconds rather than the real 780, so the suite stays fast, but
at the production sample rate. Dropping the rate to shrink the fixtures further
is not available: `qa.MIN_MP3_BYTES_PER_SEC` is calibrated against 44.1 kHz VBR
output, and an 8 kHz master encodes to ~2066 B/s — under the floor, flagged as
truncated, for a file that is nothing of the kind. Production cannot hit that
(`check_pad_headroom` refuses any pad that is not `timeline.SR`), so the fixture
should not either.

`render_program.TRACKS` is scaled to match the fixture lengths where the clean
path is under test — it is a table of planned lengths, not a service — and left
at production values where the truncation guard is under test, because that
guard *is* the disagreement between planned and measured.
"""
import json
import os
import sys

import numpy as np
import pytest
import soundfile as sf

ENGINE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ENGINE)

import prerender_catalog  # noqa: E402
import render_program  # noqa: E402

RATE = 44100  # timeline.SR; see the module docstring
SECONDS = [20, 20, 20, 12]
PHASES = ["Foundation", "Deepening", "Mastery", "Integration"]


def tone(seconds, rate=RATE, level_db=-20.0):
    """Audio at a plausible master level: noise normalised to `level_db` RMS.

    Noise rather than a sine because `qa` measures RMS per one-second window,
    and a signal with a period that divides the window can produce windows that
    read as silent while the whole file measures fine.
    """
    rng = np.random.default_rng(7)  # seeded: a flaky QA threshold is worthless
    y = rng.standard_normal(int(seconds * rate))
    return (y / np.sqrt(np.mean(y * y)) * (10.0 ** (level_db / 20.0))).astype("float32")


def write_program(program_dir, goal="polymath", seconds=None, silent_track=None,
                  drop=None):
    """A rendered program on disk: four WAV/MP3 masters plus its manifest."""
    os.makedirs(program_dir, exist_ok=True)
    seconds = seconds or SECONDS
    tracks = []
    for i, secs in enumerate(seconds, start=1):
        entry = {
            "n": i, "id": f"{goal}_track{i}", "title": f"{goal} {i}",
            "phase": PHASES[i - 1], "durationSec": float(secs),
            "mp3": f"{goal}_track{i}.mp3", "wav": f"{goal}_track{i}.wav",
        }
        tracks.append(entry)
        if drop == i:
            continue
        y = np.zeros(int(secs * RATE), dtype="float32") if silent_track == i \
            else tone(secs)
        sf.write(os.path.join(program_dir, entry["wav"]), y, RATE, subtype="PCM_16")
        sf.write(os.path.join(program_dir, entry["mp3"]), y, RATE)

    manifest = {"jobId": "test", "goal": goal, "goalTitle": "T",
                "voiceSet": "male", "tracks": tracks}
    with open(os.path.join(program_dir, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f)
    return manifest


@pytest.fixture
def scaled_tracks(monkeypatch):
    """Planned lengths matching the fixture audio, so the clean path is clean."""
    monkeypatch.setattr(render_program, "TRACKS", [
        {"n": i + 1, "script_suffix": "", "total_s": s, "phase": PHASES[i]}
        for i, s in enumerate(SECONDS)])


# ---------------------------------------------------------------- the clean path

def test_a_healthy_program_passes_and_reports_measured_durations(
        tmp_path, scaled_tracks):
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir)
    tracks, problems, measurements = prerender_catalog.measure_program(
        program_dir, manifest)

    assert problems == []
    assert len(tracks) == 4
    assert len(measurements) == 4
    for track, secs in zip(tracks, SECONDS):
        assert track["durationSec"] == pytest.approx(secs, abs=0.2)


@pytest.mark.parametrize("claimed", [1.0, 9999.0])
def test_a_lying_manifest_duration_is_ignored(tmp_path, scaled_tracks, claimed):
    # The manifest's durationSec is the *planned* length until mastering
    # overwrites it. Trusting it here would reintroduce #14 — quoting a number
    # nothing measured — inside the very file meant to retire that.
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir)
    for entry in manifest["tracks"]:
        entry["durationSec"] = claimed

    tracks, problems, _ = prerender_catalog.measure_program(program_dir, manifest)
    assert problems == []
    assert [t["durationSec"] for t in tracks] != [claimed] * 4
    for track, secs in zip(tracks, SECONDS):
        assert track["durationSec"] == pytest.approx(secs, abs=0.2)


def test_paths_are_relative_to_the_catalog_root(tmp_path, scaled_tracks):
    # The masters move to object storage under #57. A manifest holding absolute
    # box paths would have to be rewritten; one holding <program>/<file> does not.
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir)
    tracks, _, _ = prerender_catalog.measure_program(program_dir, manifest)

    for track in tracks:
        assert track["wav"].startswith("polymath__male/")
        assert not os.path.isabs(track["wav"])
        assert track["mp3"].endswith(".mp3")


def test_the_measurements_behind_the_verdict_are_recorded(tmp_path, scaled_tracks):
    # "with results recorded" is its own acceptance criterion: a passing run has
    # to leave evidence, not just an absence of complaints.
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir)
    _, _, measurements = prerender_catalog.measure_program(program_dir, manifest)

    for m in measurements:
        assert m["rmsDb"] == pytest.approx(-20.0, abs=1.5)
        assert m["mp3Bytes"] > 0
        assert m["wavSeconds"] > 0
        assert m["mp3Seconds"] > 0
        assert 0.0 <= m["silentFraction"] <= 1.0


# ---------------------------------------------------------------- what it catches

def test_a_silent_master_is_caught(tmp_path, scaled_tracks):
    # The failure the gate exists for (#6): silence is produced silently,
    # because the master normalisation divides by (rms + 1e-12).
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir, silent_track=3)
    _, problems, _ = prerender_catalog.measure_program(program_dir, manifest)

    assert any("polymath_track3" in p for p in problems)
    assert not any("polymath_track1" in p for p in problems)


def test_a_master_missing_from_disk_is_reported_not_crashed(tmp_path, scaled_tracks):
    # The manifest can outlive the files it lists. Raising here would lose the
    # other three tracks' verdicts along with it.
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir, drop=2)
    tracks, problems, _ = prerender_catalog.measure_program(program_dir, manifest)

    assert any("missing from disk" in p for p in problems)
    assert len(tracks) == 3  # the other three are still measured


def test_a_master_far_under_its_planned_length_is_caught(tmp_path):
    # Deliberately *not* scaled: production plans 780 s, the fixture writes 20,
    # which is exactly the planned-vs-measured disagreement this guard is for.
    program_dir = str(tmp_path / "polymath__male")
    manifest = write_program(program_dir)
    _, problems, _ = prerender_catalog.measure_program(program_dir, manifest)

    assert any("truncated" in p for p in problems)


# ---------------------------------------------------------------- the ten combos

def test_the_catalog_is_every_goal_against_every_voice_set():
    combos = prerender_catalog.combinations()
    assert len(combos) == len(render_program.GOALS) * len(render_program.VOICE_SETS)
    assert len(combos) == 10
    assert len(set(combos)) == 10


def test_combinations_are_read_off_the_engine_registries():
    # So a sixth title added to GOALS joins the catalog automatically rather
    # than being silently left unrendered.
    goals = {goal for goal, _ in prerender_catalog.combinations()}
    assert goals == set(render_program.GOALS)


def test_an_unknown_combination_is_refused_before_anything_renders():
    for bad in ["polymath", "nope:male", "polymath:other", ""]:
        with pytest.raises(ValueError):
            prerender_catalog.parse_selection([bad])


# ---------------------------------------------------------------- resume safety

# These drive main() end to end. They are safe to run anywhere, including on the
# box where the pads and the key live: every combination they touch is passed via
# --only and already has a manifest.json, so render_one skips it and no TTS call
# is ever reachable. Never widen one of these to a full run — without --only,
# main() walks all ten combinations and the eight without a manifest would render
# for real.

def seed_catalog_root(tmp_path, keys=("polymath__male",)):
    root = tmp_path / "catalog"
    for key in keys:
        goal = key.split("__")[0]
        manifest = write_program(str(root / key), goal=goal)
        manifest["createdAt"] = "2026-09-05T09:00:00Z"
        with open(root / key / "manifest.json", "w", encoding="utf-8") as f:
            json.dump(manifest, f)
    return root


def approvals_file(tmp_path, program="polymath__male", at="2026-09-05T10:00:00Z"):
    path = tmp_path / "approvals.json"
    with open(path, "w", encoding="utf-8") as f:
        json.dump({"schemaVersion": 1, "listens": [
            {"program": program, "listen": "full", "at": at, "by": "frankbria"}]}, f)
    return path


def run_main(monkeypatch, tmp_path, root, only, approvals):
    catalog_path = tmp_path / "catalog.json"
    report_path = tmp_path / "qa-report.json"
    argv = ["prerender_catalog.py", "--outdir", str(root),
            "--catalog", str(catalog_path), "--approvals", str(approvals),
            "--qa-report", str(report_path)]
    for combo in only or ():
        argv += ["--only", combo]
    monkeypatch.setattr(sys, "argv", argv)
    code = prerender_catalog.main()
    with open(catalog_path, encoding="utf-8") as f:
        built = json.load(f)
    with open(report_path, encoding="utf-8") as f:
        report = json.load(f)
    return code, built, report


def test_a_seeded_program_is_measured_and_published(
        monkeypatch, tmp_path, scaled_tracks):
    root = seed_catalog_root(tmp_path)
    code, built, report = run_main(
        monkeypatch, tmp_path, root, ["polymath:male"], approvals_file(tmp_path))

    assert code == 0
    assert [p["key"] for p in built["programs"]] == ["polymath__male"]
    assert built["programs"][0]["publishable"]
    assert built["durationsByGoal"]["polymath"][0] == pytest.approx(20, abs=0.2)
    assert report["programs"][0]["program"] == "polymath__male"


def test_a_qa_failure_blocks_the_program_rather_than_publishing_it(
        monkeypatch, tmp_path, scaled_tracks):
    root = seed_catalog_root(tmp_path)
    approvals = approvals_file(tmp_path)
    code, built, _ = run_main(monkeypatch, tmp_path, root, ["polymath:male"], approvals)
    assert code == 0 and built["programs"][0]["publishable"]

    os.remove(root / "polymath__male" / "polymath_track2.wav")
    code, built, report = run_main(
        monkeypatch, tmp_path, root, ["polymath:male"], approvals)

    assert code == 1
    entry = next(p for p in built["programs"] if p["key"] == "polymath__male")
    assert not entry["publishable"]
    assert any("missing from disk" in b for b in entry["blockers"])
    assert "polymath" not in built["durationsByGoal"]
    assert report["programs"][0]["problems"]


def test_a_combination_that_raises_does_not_resurrect_its_previous_entry(
        monkeypatch, tmp_path, scaled_tracks):
    # The dangerous one. An *exception* (not a QA verdict) used to skip the
    # combination entirely, and the merge then back-filled it from the prior
    # catalog — republishing durations and a publishable flag for masters this
    # run had already touched. A corrupt manifest.json is the cheapest way to
    # raise: render_one still sees the file and skips rendering, so no TTS call
    # is reachable, and load_json refuses to parse it.
    root = seed_catalog_root(tmp_path)
    approvals = approvals_file(tmp_path)
    code, built, _ = run_main(monkeypatch, tmp_path, root, ["polymath:male"], approvals)
    assert code == 0 and built["programs"][0]["publishable"]

    (root / "polymath__male" / "manifest.json").write_text("{ truncated",
                                                           encoding="utf-8")
    code, built, report = run_main(
        monkeypatch, tmp_path, root, ["polymath:male"], approvals)

    assert code == 1
    entry = next(p for p in built["programs"] if p["key"] == "polymath__male")
    assert not entry["publishable"], "the stale publishable entry came back"
    assert entry["tracks"] == []
    assert "polymath" not in built["durationsByGoal"]


def test_a_partial_run_keeps_the_program_it_did_not_touch(
        monkeypatch, tmp_path, scaled_tracks):
    root = seed_catalog_root(tmp_path, ("polymath__male", "river__male"))
    approvals = approvals_file(tmp_path)
    _, built, _ = run_main(
        monkeypatch, tmp_path, root, ["polymath:male", "river:male"], approvals)
    assert {p["key"] for p in built["programs"]} == {"polymath__male", "river__male"}

    _, built, report = run_main(
        monkeypatch, tmp_path, root, ["polymath:male"], approvals)

    assert {p["key"] for p in built["programs"]} == {"polymath__male", "river__male"}
    assert {r["program"] for r in report["programs"]} == {"polymath__male", "river__male"}


def test_a_full_run_does_not_delete_the_entry_of_a_combination_that_failed(
        monkeypatch, tmp_path, scaled_tracks):
    # Without --only the merge used to be skipped entirely, so a full run with
    # one bad combination silently dropped that program's entry and its QA
    # evidence — and if the dropped one held the catalog-wide full listen, every
    # remaining program was demoted to unpublishable along with it.
    #
    # GOALS and VOICE_SETS are narrowed to exactly what is seeded so that a run
    # with no --only still touches only combinations that skip rendering. Do not
    # widen this: an unseeded combination in a full run renders for real.
    monkeypatch.setattr(render_program, "GOALS", ("polymath", "river"))
    monkeypatch.setattr(render_program, "VOICE_SETS",
                        {"male": render_program.VOICE_SETS["male"]})
    root = seed_catalog_root(tmp_path, ("polymath__male", "river__male"))
    approvals = approvals_file(tmp_path, program="polymath__male")

    code, built, _ = run_main(monkeypatch, tmp_path, root, None, approvals)
    assert code == 0
    assert {p["key"] for p in built["programs"]} == {"polymath__male", "river__male"}

    # Break the one holding the full listen: the worst case for the knock-on.
    (root / "polymath__male" / "manifest.json").write_text("{ truncated",
                                                           encoding="utf-8")
    code, built, report = run_main(monkeypatch, tmp_path, root, None, approvals)

    assert code == 1
    keys = {p["key"] for p in built["programs"]}
    assert keys == {"polymath__male", "river__male"}, \
        "a failed combination was deleted from the manifest instead of recorded"
    assert {r["program"] for r in report["programs"]} == keys
    blocked = next(p for p in built["programs"] if p["key"] == "polymath__male")
    assert not blocked["publishable"]


def test_a_listen_older_than_the_masters_does_not_publish_them(
        monkeypatch, tmp_path, scaled_tracks):
    # --force re-renders in place, so masters can change under a sign-off
    # without anything else moving. The seeded manifest says the masters were
    # made at 09:00; a listen at 08:00 was of a file that no longer exists.
    root = seed_catalog_root(tmp_path)
    approvals = approvals_file(tmp_path, at="2026-09-05T08:00:00Z")
    _, built, _ = run_main(monkeypatch, tmp_path, root, ["polymath:male"], approvals)

    entry = built["programs"][0]
    assert not entry["publishable"]
    assert any("predates the masters" in b for b in entry["blockers"])


def test_a_dry_run_does_not_delete_a_forced_combinations_manifest(tmp_path):
    # `--dry-run --force X` is advertised as "verify, no TTS". Deleting the
    # manifest would throw away the resumability of a program already paid for:
    # the next real run re-renders it from scratch.
    root = seed_catalog_root(tmp_path)
    manifest_path = root / "polymath__male" / "manifest.json"
    try:
        prerender_catalog.render_one("polymath", "male", str(root),
                                     force=True, dry_run=True)
    except Exception:
        # No pads in a checkout, so the pad check refuses before any spend.
        # What matters is what survived, not whether the check could complete.
        pass
    assert manifest_path.exists()


def test_a_dry_run_leaves_a_finished_programs_status_alone(tmp_path):
    # run() writes as well as reads — it constructs a Job (status.json) before
    # it returns. Pointed at the real directory, a dry run left every finished
    # program reading "rendering / scripting / 5%" permanently: a dry run
    # reporting a render in progress that is not.
    root = seed_catalog_root(tmp_path)
    status = root / "polymath__male" / "status.json"
    status.write_text(json.dumps({"state": "ready", "progress": 1.0}),
                      encoding="utf-8")
    try:
        prerender_catalog.render_one("polymath", "male", str(root),
                                     force=False, dry_run=True)
    except Exception:
        pass  # no pads in a checkout; what matters is what survived
    assert json.loads(status.read_text())["state"] == "ready"
