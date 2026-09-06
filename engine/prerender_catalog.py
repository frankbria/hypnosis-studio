"""Pre-render every catalog program once, check it, and write the manifest.

Usage (on the box, where the pads and the key live):

    python prerender_catalog.py --outdir /srv/hypnosis-studio/renders/catalog
    python prerender_catalog.py --outdir ... --dry-run          # no spend
    python prerender_catalog.py --outdir ... --only polymath:male
    python prerender_catalog.py --outdir ... --force polymath:male

Every render is a pure function of `(goal, voiceSet)` — `server.js` accepts only
those two fields — so five goals x two voice sets is **ten possible outputs,
total**. Rendering one of them on demand per customer costs ~$2 of TTS and 15-20
minutes of wall clock, every time, for output that never differs. Rendering all
ten once costs roughly $20 and makes delivery instant (#58).

This driver does not reimplement the pipeline. It calls `render_program.run()`
once per combination, so the pad headroom gate, the spend guards, the segment
cache, the assembler and the QA thresholds are all exactly the ones a paid job
gets. The catalog path cannot drift from the per-job path because there is only
one path.

**Resumable, and cheap to resume.** A combination whose `manifest.json` already
exists is skipped. `run()` writes that manifest only after all four tracks pass
QA, so a combination that failed has no manifest and is retried on the next run
— and the shared segment cache means the retry re-buys only the segments it
never reached. An interrupted three-hour run costs minutes to finish, not $20.

A failing combination does not stop the others. Dying at combination 3 of 10
would strand the remaining seven behind a fault that has nothing to do with
them; failures are collected, reported at the end, and the process exits 1.

The manifest is written every run, including a run where things failed, because
it is also the record of *what is not publishable and why*.
"""
import argparse
import os
import shutil
import sys
import tempfile
import traceback

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ENGINE_DIR)

import catalog as catalog_lib
import qa
import render_program

CATALOG_PATH = os.path.join(ENGINE_DIR, "catalog.json")
APPROVALS_PATH = os.path.join(ENGINE_DIR, "catalog-approvals.json")
QA_REPORT_PATH = os.path.join(ENGINE_DIR, "catalog-qa-report.json")


def combinations() -> list:
    """The ten (goal, voice set) pairs, in a stable order.

    Read off the engine's own registries rather than restated here, so adding a
    sixth title to `render_program.GOALS` puts it in the catalog automatically
    instead of leaving it silently unrendered.
    """
    return [(goal, voice_set)
            for goal in render_program.GOALS
            for voice_set in sorted(render_program.VOICE_SETS)]


def parse_selection(values) -> set:
    """`--only polymath:male` -> {("polymath", "male")}. Validated eagerly."""
    selected = set()
    valid = set(combinations())
    for value in values or ():
        goal, _, voice_set = value.partition(":")
        if not voice_set:
            raise ValueError(
                f"expected goal:voice-set, got {value!r} "
                f"(e.g. polymath:male)")
        if (goal, voice_set) not in valid:
            raise ValueError(f"unknown combination {value!r}")
        selected.add((goal, voice_set))
    return selected


def measure_program(program_dir: str, manifest: dict) -> tuple:
    """Re-measure a rendered program's four masters and run the QA gate.

    `render_program.run()` already gates on QA and refuses to write a manifest
    when it fails — but it *raises* rather than handing back the numbers, and
    the acceptance criterion asks for results to be recorded, not merely
    honoured. Measuring again costs about 0.4 s per track (~16 s for the whole
    catalog) against a ~3 h render, calls the same `qa.check_master` so no
    threshold is restated here, and independently confirms what actually landed
    on disk rather than what the renderer believed it wrote.

    Returns (tracks, problems, measurements).
    """
    planned_by_n = {t["n"]: float(t["total_s"]) for t in render_program.TRACKS}
    tracks, problems, measurements = [], [], []

    for entry in manifest["tracks"]:
        wav_path = os.path.join(program_dir, entry["wav"])
        mp3_path = os.path.join(program_dir, entry["mp3"])
        missing = [os.path.basename(p) for p in (wav_path, mp3_path)
                   if not os.path.exists(p)]
        if missing:
            problems.append(
                f"{entry['id']}: {', '.join(missing)} listed in the manifest but "
                f"missing from disk")
            continue

        wav = render_program.measure_audio(wav_path)
        mp3 = render_program.measure_audio(mp3_path)
        mp3_bytes = os.path.getsize(mp3_path)
        problems += qa.check_master(
            label=entry["id"],
            rms_db=wav.rms_db,
            mp3_bytes=mp3_bytes,
            duration_s=wav.seconds,
            planned_s=planned_by_n.get(entry["n"]),
            mp3_decoded_s=mp3.seconds,
            silent_fraction=wav.silent_fraction,
        )
        measurements.append({
            "id": entry["id"],
            "rmsDb": wav.rms_db,
            "wavSeconds": round(wav.seconds, 1),
            "mp3Seconds": round(mp3.seconds, 1),
            "mp3Bytes": mp3_bytes,
            "silentFraction": round(wav.silent_fraction, 4),
        })
        # The measured length, not the planned one. `total_s` is a floor: the
        # assembler renders max(total_s, voice_end + outro) bounded by the pad,
        # so a real master runs two to three minutes longer, and the whole point
        # of this manifest is to stop quoting the floor as if it were the length.
        tracks.append({
            "n": entry["n"],
            "id": entry["id"],
            "title": entry["title"],
            "phase": entry["phase"],
            "durationSec": round(wav.seconds, 1),
            # Relative to the catalog root, so the manifest survives the masters
            # moving from the box to object storage (#57) without a rewrite.
            "wav": os.path.join(os.path.basename(program_dir), entry["wav"]),
            "mp3": os.path.join(os.path.basename(program_dir), entry["mp3"]),
        })

    return tracks, problems, measurements


def render_one(goal: str, voice_set: str, outdir: str, force: bool,
               dry_run: bool) -> str:
    """Render one combination unless it is already done. Returns its directory."""
    key = catalog_lib.program_key(goal, voice_set)
    program_dir = os.path.join(outdir, key)
    manifest_path = os.path.join(program_dir, "manifest.json")

    if dry_run:
        # A dry run costs nothing and produces nothing, so it neither skips a
        # finished combination — its whole job is to verify every script and pad
        # — nor disturbs one. In particular `--dry-run --force` must not delete
        # a manifest: that would make a run advertised as "verify, no TTS" throw
        # away the resumability of a program already paid for.
        #
        # Into a scratch directory, because `run()` writes as well as reads: it
        # constructs a Job (status.json) and copies the scripts in before it
        # returns. Pointed at the real directory it left every finished
        # program's status.json reading `rendering / scripting / 5%`,
        # permanently — a dry run reporting a render in progress that is not.
        # Nothing it verifies lives in the outdir: the scripts and the pad are
        # both read from ENGINE_DIR, so a scratch target checks the same things.
        print(f"== {key}: checking scripts and pad", flush=True)
        scratch = tempfile.mkdtemp(prefix=f"dryrun-{key}-")
        try:
            render_program.run(key, goal, voice_set, scratch, dry_run=True)
        finally:
            shutil.rmtree(scratch, ignore_errors=True)
        return program_dir

    if os.path.exists(manifest_path) and not force:
        print(f"== {key}: already rendered, skipping "
              f"(--force {goal}:{voice_set} to redo)", flush=True)
        return program_dir

    if force and os.path.exists(manifest_path):
        # Dropped before the render, not after: a forced re-render that dies
        # halfway must not leave the old manifest standing as if it described
        # the files now in the directory.
        os.remove(manifest_path)

    print(f"== {key}: rendering", flush=True)
    render_program.run(key, goal, voice_set, program_dir, dry_run=False)
    return program_dir


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--outdir", required=True,
                    help="catalog root; each combination gets a subdirectory")
    ap.add_argument("--only", action="append", metavar="GOAL:VOICE_SET",
                    help="render only these combinations (repeatable)")
    ap.add_argument("--force", action="append", metavar="GOAL:VOICE_SET",
                    default=[], help="re-render these even if already done")
    ap.add_argument("--dry-run", action="store_true",
                    help="verify scripts and pads for every combination, no TTS")
    ap.add_argument("--catalog", default=CATALOG_PATH)
    ap.add_argument("--approvals", default=APPROVALS_PATH)
    ap.add_argument("--qa-report", default=QA_REPORT_PATH)
    args = ap.parse_args()

    outdir = os.path.abspath(args.outdir)
    os.makedirs(outdir, exist_ok=True)

    try:
        only = parse_selection(args.only)
        forced = parse_selection(args.force)
    except ValueError as e:
        print(f"FAILED: {e}", flush=True)
        return 2

    # Every file this run will read or rewrite is read *before* rendering.
    # `load_json` refuses a corrupt file by design, and discovering that after
    # three hours of TTS — between the last render and the manifest write — is
    # the expensive way to find out.
    approvals = catalog_lib.load_json(args.approvals,
                                      catalog_lib.empty_approvals())
    approval_index = catalog_lib.approvals_by_program(approvals)
    existing = catalog_lib.load_json(args.catalog, catalog_lib.empty_catalog(""))
    prior_report = catalog_lib.load_json(args.qa_report, {})

    todo = [c for c in combinations() if not only or c in only]
    print(f"catalog: {len(todo)} combination(s) into {outdir}", flush=True)

    programs, reports, failures = [], [], []
    for goal, voice_set in todo:
        key = catalog_lib.program_key(goal, voice_set)
        manifest = {}
        try:
            program_dir = render_one(goal, voice_set, outdir,
                                     (goal, voice_set) in forced, args.dry_run)
            if args.dry_run:
                continue
            manifest = catalog_lib.load_json(
                os.path.join(program_dir, "manifest.json"), {})
            if not manifest:
                raise RuntimeError("render produced no manifest.json")
            tracks, problems, measurements = measure_program(program_dir, manifest)
        except Exception as e:  # noqa: BLE001 — one bad combination, not ten
            print(f"FAILED {key}: {e}", flush=True)
            traceback.print_exc()
            failures.append(f"{key}: {e}")
            # A fresh entry recording the failure, NOT a `continue`. Skipping
            # would leave this combination to be back-filled from the previous
            # catalog below — and `--force` re-renders in place, so that entry
            # describes masters this run has already overwritten. It would say
            # publishable, with durations, for audio that no longer exists.
            tracks, problems, measurements = [], [str(e)], []
        else:
            if problems:
                print(f"   QA rejected {key}: {'; '.join(problems)}", flush=True)
                failures.append(f"{key}: QA gate rejected the masters")

        programs.append(catalog_lib.build_program(
            goal=goal,
            goal_title=render_program.TITLES[goal],
            voice_set=voice_set,
            tracks=tracks,
            qa_problems=problems,
            checked_at=render_program.now_iso(),
            approval=approval_index.get(key),
            # When the masters were made, off the program's own manifest. A
            # sign-off older than this is a sign-off on a file that has since
            # been re-rendered, and catalog.py refuses it.
            rendered_at=manifest.get("createdAt"),
        ))
        reports.append({"program": key, "problems": problems,
                        "tracks": measurements})

    if args.dry_run:
        print("dry run: scripts and pads verified, nothing rendered", flush=True)
        return 1 if failures else 0

    # Written even when combinations failed: the manifest is the record of what
    # is not publishable and why, which is exactly what an operator needs next.
    #
    # Merged unconditionally, not just under `--only`. Every combination this
    # run touched already has a fresh entry above — including the ones that
    # failed — so the merge can only carry forward combinations the run did not
    # touch. Gating it on `--only` meant a full run with one bad pad silently
    # deleted that program's entry and its QA evidence; and if the deleted one
    # happened to hold the catalog-wide full listen, every remaining program was
    # demoted to unpublishable along with it.
    # `keep` bounds the carry-forward to combinations the engine can still
    # produce, so retiring a goal or a voice set retires its catalog entry too.
    live = {catalog_lib.program_key(g, v) for g, v in combinations()}
    programs = catalog_lib.merge_untouched(
        programs, existing.get("programs", []), "key", keep=live)
    reports = catalog_lib.merge_untouched(
        reports, prior_report.get("programs", []), "program", keep=live)

    catalog = catalog_lib.build_catalog(programs, approvals,
                                        render_program.now_iso())
    render_program.write_json_atomic(args.catalog, catalog)
    render_program.write_json_atomic(args.qa_report, {
        "schemaVersion": catalog_lib.SCHEMA_VERSION,
        "checkedAt": render_program.now_iso(),
        "programs": reports,
    })

    publishable = [p for p in catalog["programs"] if p["publishable"]]
    print(f"\ncatalog: {len(publishable)}/{len(catalog['programs'])} "
          f"program(s) publishable", flush=True)
    for program in catalog["programs"]:
        if not program["publishable"]:
            print(f"  not publishable — {program['key']}: "
                  f"{'; '.join(program['blockers'])}", flush=True)
    if failures:
        print(f"\n{len(failures)} combination(s) failed:", flush=True)
        for f in failures:
            print(f"  {f}", flush=True)
        print("re-run to retry them — the segment cache means a retry re-buys "
              "only what it never reached", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
