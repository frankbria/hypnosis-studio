"""Cut a two-minute mixed sample of every publishable catalog program (#60).

Usage (on the box, where the masters live):

    python cut_samples.py --catalog-dir /srv/hypnosis-studio/renders/catalog
    python cut_samples.py --catalog-dir ... --dry-run       # plan only, no ffmpeg
    python cut_samples.py --catalog-dir ... --only polymath:male
    python cut_samples.py --catalog-dir ... --force polymath:male

Until this existed there was no way to hear a program before buying one. The
only audio on the site was four short **solo** voice clips — and the whisper
layer was previewed solo, unmixed, with no narrator over it and no bed
underneath, which is the most uncanny configuration synthetic audio can be in.
It was the only way to hear the product's differentiator before paying for it.

Once #58 pre-rendered the catalog the fix is nearly free: the masters already
exist, so this is ffmpeg over files on disk. No TTS, no spend, no engine work.

**Track I and Track III, not Track I alone.** Track I carries the induction,
which is bespoke to each program's metaphor — polymath and river share zero
identical segments in any phase. Track III is where the whisper layer lives,
because the whisper voice is used for, and only for, the suggestion phase
(render_program.py). Sampling Track I alone would advertise the product without
its differentiator; sampling Track III alone would open on the middle of a
trance. So the sample is ~60 s of one crossfaded into ~45 s of the other.

**Where the windows come from.** Not a fraction of the file — a fraction of the
file is a guess that goes stale the moment a script is rewritten. The scripts
are projected onto a timeline (timeline.project_positions), the phase is located
on it, and the result is scaled onto the master's *measured* length from
catalog.json. The projection's chars/sec rate is deliberately conservative and
therefore wrong in absolute terms; scaling cancels most of that out, because
what is used is the phase's relative position.

**Publishable programs only.** A sample is an advertisement, and catalog.json's
`publishable` is the flag that says the studio has confirmed it can deliver this
audio (QA passed and the owner listened). Advertising anything else is the
promise #58 and #59 exist to keep.

Stdlib only, like timeline.py, qa.py and catalog.py: the arithmetic that decides
what a prospective customer hears is testable without ffmpeg or the audio stack.
"""
import argparse
import collections
import json
import os
import subprocess
import sys

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ENGINE_DIR)

import timeline

CATALOG_MANIFEST = os.path.join(ENGINE_DIR, "catalog.json")

# The two tracks a sample is cut from, and how much of each.
TRACK_ONE = 1
TRACK_THREE = 3
TRACK_ONE_SECONDS = 60.0
TRACK_THREE_SECONDS = 45.0

# Where in its phase each window sits. Track I opens on the induction because
# the first words of the induction are the bespoke part; Track III is centred in
# the suggestion phase, the widest and safest place to land inside the whisper.
TRACK_ONE_PHASE = ("induction", "start")
TRACK_THREE_PHASE = ("suggestion", "center")

# The two excerpts overlap rather than butt-joining. A hard cut between two
# unrelated points of a hypnosis program is an audible click, on the one file
# whose entire job is to sound like something worth paying for.
CROSSFADE_S = 2.0
FADE_IN_S = 1.5
FADE_OUT_S = 3.0

SAMPLE_NAME = "sample.mp3"

# 64 kbps mono. The masters themselves are mono and encode at roughly 32 kbps
# VBR, so this is comfortably above the source; the constraint that matters is
# the other one — the file has to start playing promptly on a phone, and ~830 kB
# does. `-ac 1` is stated rather than inherited so a future stereo master cannot
# silently double the size of every sample.
BITRATE = "64k"
CHANNELS = "1"

# The shortest thing worth calling a sample. Both windows clamp to the phase
# they name, so a master far shorter than its manifest claims — or a script whose
# phases collapsed — plans a few seconds rather than failing. The duration check
# below cannot catch that on its own: it compares the cut against the *plan*, and
# a four-second cut of a four-second plan agrees perfectly.
MIN_SAMPLE_S = 60.0

# How far a cut sample may be from its planned length before it is rejected.
# ffmpeg exits 0 on plenty of things that are not the file that was asked for —
# a seek past the end of a master yields a valid, near-empty mp3 — so the
# measured length of the result is the evidence, not the exit code.
DURATION_TOLERANCE_S = 2.0

Window = collections.namedtuple("Window", "start duration")
Plan = collections.namedtuple("Plan", "key windows duration")


def script_path(engine_dir: str, goal: str, n: int) -> str:
    """The TTS script for one track of one goal.

    Restates render_program.TRACKS' `script_suffix` rule (track 1 has none, the
    rest are `_trackN`) rather than importing it, because render_program pulls in
    numpy and soundfile at module level and this module is deliberately reachable
    without them. test_cut_samples.py pins the two together.
    """
    suffix = "" if n == 1 else f"_track{n}"
    return os.path.join(engine_dir, "scripts", f"{goal}{suffix}_tts_segments.json")


def load_segments(path: str) -> list:
    with open(path, encoding="utf-8") as f:
        return json.load(f)["segments"]


def plan_window(segments: list, measured_duration_s: float, phase: str,
                seconds: float, align: str) -> Window:
    """Where to cut `seconds` of `phase` out of a master `measured_duration_s` long.

    The projection built from the script is in *projected* time. A master runs
    shorter, because DEFAULT_CHARS_PER_SEC deliberately under-predicts speed, so
    projected offsets are stretched onto the real voice span before being used —
    otherwise a window drifts progressively later through the file and by the
    suggestion phase is out by tens of seconds.

    The real voice span is taken as `measured - MIN_OUTRO_S`: `resolve_actual_s`
    renders the longest whole second that leaves that much music after the last
    word, so it is the outro a master normally gets. Where the pad forced a
    shorter one the estimate lands slightly early, which is the harmless
    direction — earlier is further inside the phase, not outside it.

    Returns a window clamped inside both the phase and the file. A phase shorter
    than the request yields the phase; refusing instead would drop a title from
    the storefront over a sample twenty seconds short, which is the worse trade
    for a page whose job is to let someone hear the product at all.
    """
    if align not in ("start", "center"):
        raise ValueError(f"align must be 'start' or 'center', got {align!r}")

    positions = timeline.project_positions(segments)
    span = timeline.phase_span(positions, phase)
    if span is None:
        raise ValueError(f"the script has no {phase} phase to sample")

    projected_voice = positions[-1].end - timeline.LEAD_IN_S
    real_voice = max(0.0, measured_duration_s - timeline.MIN_OUTRO_S
                     - timeline.LEAD_IN_S)
    scale = real_voice / projected_voice if projected_voice > 0 else 0.0

    def to_real(t):
        return timeline.LEAD_IN_S + (t - timeline.LEAD_IN_S) * scale

    lo, hi = to_real(span[0]), to_real(span[1])
    # Never past the end of the file even when the master is far shorter than the
    # manifest claims: ffmpeg would emit a valid, near-silent mp3 rather than fail.
    lo = max(0.0, min(lo, measured_duration_s))
    hi = max(lo, min(hi, measured_duration_s))

    duration = min(seconds, hi - lo)
    start = lo if align == "start" else lo + (hi - lo - duration) / 2
    return Window(start, duration)


def plan_sample(engine_dir: str, program: dict) -> Plan:
    """Both windows for one catalog program, and the length they add up to."""
    by_n = {t["n"]: t for t in program.get("tracks", [])}
    windows = {}
    for n, (phase, align), seconds in (
            (TRACK_ONE, TRACK_ONE_PHASE, TRACK_ONE_SECONDS),
            (TRACK_THREE, TRACK_THREE_PHASE, TRACK_THREE_SECONDS)):
        track = by_n.get(n)
        if not track:
            raise ValueError(
                f"{program['key']}: no track {n} in the manifest — a sample "
                f"needs both track {TRACK_ONE} and track {TRACK_THREE}")
        segments = load_segments(script_path(engine_dir, program["goal"], n))
        windows[n] = plan_window(segments, float(track["durationSec"]),
                                 phase, seconds, align)

    # The crossfade overlaps the two excerpts, so the sample is shorter than
    # their sum. Quoting the sum would make the duration check below reject
    # every good file.
    duration = sum(w.duration for w in windows.values()) - CROSSFADE_S
    if duration < MIN_SAMPLE_S:
        raise ValueError(
            f"{program['key']}: the windows add up to {duration:.0f}s, under the "
            f"{MIN_SAMPLE_S:.0f}s floor — the masters are shorter than the "
            f"manifest says, or the scripts have no phase left to sample")
    return Plan(program["key"], windows, duration)


def ffmpeg_command(sources: dict, plan: Plan, out_path: str) -> list:
    """The one ffmpeg call that cuts, joins and encodes a sample.

    `-ss`/`-t` before each `-i` so ffmpeg seeks the input rather than decoding
    the whole 13-minute master and discarding most of it.
    """
    one = plan.windows[TRACK_ONE]
    three = plan.windows[TRACK_THREE]
    fade_out_at = max(0.0, three.duration - FADE_OUT_S)
    graph = (
        f"[0:a]afade=t=in:st=0:d={FADE_IN_S:g}[a0];"
        f"[1:a]afade=t=out:st={fade_out_at:g}:d={FADE_OUT_S:g}[a1];"
        f"[a0][a1]acrossfade=d={CROSSFADE_S:g}:c1=tri:c2=tri[out]"
    )
    argv = ["ffmpeg", "-nostdin", "-y", "-loglevel", "error"]
    for n, window in ((TRACK_ONE, one), (TRACK_THREE, three)):
        argv += ["-ss", f"{window.start:.3f}", "-t", f"{window.duration:.3f}",
                 "-i", sources[n]]
    argv += ["-filter_complex", graph, "-map", "[out]",
             "-c:a", "libmp3lame", "-b:a", BITRATE, "-ar", str(timeline.SR),
             # Named, not inferred from the extension. The cut goes to a scratch
             # path so a killed ffmpeg cannot publish a half-written sample, and
             # ffmpeg refuses a filename whose suffix it does not recognise:
             # "Unable to choose an output format".
             "-ac", CHANNELS, "-f", "mp3", out_path]
    return argv


def probe_duration(path: str) -> float:
    """The decoded length of a file, per ffprobe."""
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=nw=1:nk=1", path],
        check=True, capture_output=True, text=True).stdout.strip()
    return float(out)


def check_duration(key: str, measured_s: float, planned_s: float) -> list:
    """Why this cut sample is not the file that was asked for. Empty means it is."""
    if abs(measured_s - planned_s) > DURATION_TOLERANCE_S:
        return [(f"{key}: sample is {measured_s:.1f}s, planned {planned_s:.1f}s "
                 f"(tolerance {DURATION_TOLERANCE_S:.0f}s) — the windows did not "
                 f"land where they were meant to")]
    return []


def sample_path(catalog_dir: str, key: str) -> str:
    """Beside the masters it was cut from, so #57's move to object storage
    carries the sample with the audio rather than stranding it."""
    return os.path.join(catalog_dir, key, SAMPLE_NAME)


def master_paths(catalog_dir: str, program: dict) -> dict:
    """`{track number: absolute mp3 path}` for the tracks a sample is cut from."""
    return {t["n"]: os.path.abspath(os.path.join(catalog_dir, t["mp3"]))
            for t in program.get("tracks", [])
            if t["n"] in (TRACK_ONE, TRACK_THREE)}


def parse_selection(values) -> set:
    """`--only polymath:male` -> {"polymath__male"}."""
    selected = set()
    for value in values or ():
        goal, _, voice_set = value.partition(":")
        if not goal or not voice_set:
            raise ValueError(
                f"expected goal:voice-set, got {value!r} (e.g. polymath:male)")
        selected.add(f"{goal}__{voice_set}")
    return selected


def selected(manifest: dict, only: set) -> list:
    """The programs to sample: publishable, and in `only` when one was given."""
    return [p for p in manifest.get("programs", [])
            if p.get("publishable") and (not only or p.get("key") in only)]


def cut_one(engine_dir: str, catalog_dir: str, program: dict, force: bool,
            dry_run: bool) -> list:
    """Cut one program's sample. Returns its problems; empty means it worked."""
    key = program["key"]
    out_path = sample_path(catalog_dir, key)

    try:
        plan = plan_sample(engine_dir, program)
    except (ValueError, OSError) as e:
        return [f"{key}: {e}"]

    if os.path.relpath(out_path, catalog_dir).startswith(os.pardir):
        return [f"{key}: program key escapes {catalog_dir}"]

    sources = master_paths(catalog_dir, program)
    missing = [n for n in (TRACK_ONE, TRACK_THREE)
               if n not in sources or not os.path.exists(sources[n])]
    if missing:
        return [(f"{key}: master(s) for track "
                 f"{', '.join(str(n) for n in missing)} are not under "
                 f"{catalog_dir} — this program is in the manifest but its "
                 f"audio is not on this box")]

    windows = ", ".join(
        f"track {n} {w.start:.0f}-{w.start + w.duration:.0f}s"
        for n, w in sorted(plan.windows.items()))
    if dry_run:
        print(f"== {key}: would cut {plan.duration:.0f}s — {windows}", flush=True)
        return []

    if os.path.exists(out_path) and not force:
        print(f"== {key}: sample already cut, skipping "
              f"(--force {key.replace('__', ':')} to redo)", flush=True)
        return []

    print(f"== {key}: cutting {plan.duration:.0f}s — {windows}", flush=True)
    # Cut to a scratch name and move it into place only once it has been
    # measured. `server.js` indexes whatever non-empty `sample.mp3` it finds at
    # boot, so a half-written file IS a published sample: an ffmpeg killed
    # mid-write by a full disk or a SIGKILL would otherwise become the
    # storefront preview. Worse under `--force`, which would have destroyed a
    # good sample to leave a broken one. Writing beside the target keeps the
    # replace on one filesystem, so it is atomic.
    scratch = out_path + ".partial"
    try:
        try:
            subprocess.run(ffmpeg_command(sources, plan, scratch),
                           check=True, capture_output=True, text=True)
        except FileNotFoundError:
            return [f"{key}: ffmpeg is not installed"]
        except subprocess.CalledProcessError as e:
            return [f"{key}: ffmpeg failed — {(e.stderr or '').strip()[:400]}"]

        try:
            measured = probe_duration(scratch)
        except (OSError, ValueError, subprocess.CalledProcessError) as e:
            return [f"{key}: could not measure the cut sample — {e}"]

        problems = check_duration(key, measured, plan.duration)
        if problems:
            return problems

        os.replace(scratch, out_path)
        return []
    finally:
        # Every failing path above leaves the scratch file behind; the published
        # sample — old or absent — is untouched by all of them.
        if os.path.exists(scratch):
            try:
                os.remove(scratch)
            except OSError:
                pass


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--catalog-dir", required=True,
                    help="catalog root — the directory prerender_catalog.py filled")
    ap.add_argument("--manifest", default=CATALOG_MANIFEST)
    ap.add_argument("--only", action="append", metavar="GOAL:VOICE_SET",
                    help="sample only these programs (repeatable)")
    ap.add_argument("--force", action="append", metavar="GOAL:VOICE_SET",
                    default=[], help="re-cut these even if a sample exists")
    ap.add_argument("--dry-run", action="store_true",
                    help="report the windows for every program, cut nothing")
    args = ap.parse_args(argv)

    catalog_dir = os.path.abspath(args.catalog_dir)
    try:
        only = parse_selection(args.only)
        forced = parse_selection(args.force)
    except ValueError as e:
        print(f"FAILED: {e}", flush=True)
        return 2

    try:
        with open(args.manifest, encoding="utf-8") as f:
            manifest = json.load(f)
    except (OSError, ValueError) as e:
        print(f"FAILED: cannot read {args.manifest}: {e}", flush=True)
        return 2

    # Validated against the manifest, not merely parsed. `--force polymath:mail`
    # otherwise reports success having re-cut nothing, which is indistinguishable
    # from the sample already being correct.
    known = {p.get("key") for p in manifest.get("programs", [])}
    unknown = sorted((only | forced) - known)
    if unknown:
        print(f"FAILED: no such program(s) in {args.manifest}: "
              f"{', '.join(unknown)}", flush=True)
        return 2

    todo = selected(manifest, only)
    if not todo:
        print(f"no publishable programs in {args.manifest} — run "
              f"prerender_catalog.py first", flush=True)
        return 0

    print(f"samples: {len(todo)} program(s) from {catalog_dir}", flush=True)
    failures = []
    for program in todo:
        # One bad program does not strand the other nine — the same stance
        # prerender_catalog.py takes, for the same reason.
        failures += cut_one(ENGINE_DIR, catalog_dir, program,
                            program["key"] in forced, args.dry_run)

    if failures:
        print(f"\n{len(failures)} program(s) have no usable sample:", flush=True)
        for f in failures:
            print(f"  {f}", flush=True)
        return 1
    print(f"\nsamples: {len(todo)} program(s) ready", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
