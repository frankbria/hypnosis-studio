"""Job worker: render one 4-track program end-to-end for a single job id.

Usage:
    python render_program.py --goal polymath --voice-set male --job-id <id> --outdir <abs path>
    python render_program.py --goal polymath --voice-set male --job-id dry --outdir <abs path> --dry-run

Stages (reported via status.json in outdir):
    scripting -> voicing -> whisper-layer -> entrainment-bed -> mastering-qa

Every job renders ALL four tracks of the goal (I Foundation, II Deepening,
III Mastery, IV Integration). Tracks 1-3 run 780 s, track 4 runs 420 s; all
goal pads are 960 s, so one pad serves every track.

status.json is written atomically (tmp file + os.replace) at every transition.
On any exception the state becomes "failed" with an error message and the
process exits 1. The manifest is written only after all four tracks are
mastered, so partial renders are never manifest-listed. The ElevenLabs key is
resolved once via render_track.load_key() and is never printed.

--dry-run verifies scripts + pad and prints the planned 4-track manifest
without calling ElevenLabs or the assembler. It also projects each track's voice
length from its character count and checks that against the real pad duration,
so a program too long for its pad is caught before any credits are spent rather
than at assembly, after the whole track has been bought (issue #5). A real
render logs the same projection but does not refuse on it.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from datetime import datetime, timezone

ENGINE_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, ENGINE_DIR)

import soundfile as sf

import job_files
import render_track
import timeline

# ---------- registries ----------
GOALS = ("polymath", "golden_thread", "inner_studio", "open_gate", "river")

PADS = {
    "polymath": "pad_15.wav",
    "golden_thread": "pad_golden_15.wav",
    "inner_studio": "pad_studio.wav",
    "open_gate": "pad_gate.wav",
    "river": "pad_15.wav",  # healing door reuses the polymath pad
}

VOICE_SETS = {
    "male": {"narrator": "nPczCjzI2devNBz1zQrb", "whisper": "RsoSo7Gg7GyAtGoPBiqb"},
    "female": {"narrator": "EXAVITQu4vr4xnSDxMaL", "whisper": "pFZP5JQG7iQjIQuC4Bku"},
}

KEYWORDS = {
    "polymath": "polymath,library,index,learn",
    "golden_thread": "golden,thread,labyrinth,door,notice",
    "inner_studio": "studio,canvas,create,inner",
    "open_gate": "gate,open,opportunity,notice",
    "river": "river,healing,rest,renewal,breath",
}

TITLES = {
    "polymath": "The Polymath Mind",
    "golden_thread": "The Golden Thread",
    "inner_studio": "The Inner Studio",
    "open_gate": "The Open Gate",
    "river": "The River of Renewal",
}

# 4-track program registry. script_suffix selects engine/scripts/<goal><suffix>_tts_segments.json;
# tracks 2-4 reuse the goal's pad (pads are 960 s >= every TOTAL_S).
# Tracks 1-3 run 780 s (densified scripts: ~80-88% voiced content, ~2 min music tail).
TRACKS = [
    {"n": 1, "script_suffix": "",        "total_s": 780, "phase": "Foundation"},
    {"n": 2, "script_suffix": "_track2", "total_s": 780, "phase": "Deepening"},
    {"n": 3, "script_suffix": "_track3", "total_s": 780, "phase": "Mastery"},
    {"n": 4, "script_suffix": "_track4", "total_s": 420, "phase": "Integration"},
]

# progress budget per stage
P_SCRIPTING = 0.05
P_VOICE_END = 0.75
P_BED_END = 0.90


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json_atomic(path: str, obj: dict) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2)
    os.replace(tmp, path)


class Job:
    def __init__(self, job_id: str, outdir: str):
        self.job_id = job_id
        self.outdir = outdir
        self.status = {
            "jobId": job_id,
            "state": "rendering",
            "stage": "scripting",
            "progress": 0.0,
            "detail": "Queued",
            "updatedAt": now_iso(),
        }
        self.write()

    def write(self) -> None:
        self.status["updatedAt"] = now_iso()
        write_json_atomic(os.path.join(self.outdir, "status.json"), self.status)

    def update(self, stage: str, progress: float, detail: str) -> None:
        self.status.update(
            state="rendering",
            stage=stage,
            progress=round(min(max(progress, 0.0), 1.0), 4),
            detail=detail,
        )
        self.write()
        print(f"[{stage}] {detail} ({progress * 100:.0f}%)", flush=True)

    def fail(self, error: str) -> None:
        self.status.update(state="failed", error=error, detail=error)
        self.write()

    def ready(self) -> None:
        self.status.update(state="ready", stage="mastering-qa", progress=1.0,
                           detail="Render complete")
        self.write()


def plan_tracks(goal: str) -> list:
    """Resolve the 4-track plan for a goal: scripts, titles, output names."""
    plan = []
    for t in TRACKS:
        n = t["n"]
        track_key = f"{goal}{t['script_suffix']}"  # assemble_track.py TRACK arg
        script_src = os.path.join(
            ENGINE_DIR, "scripts", f"{track_key}_tts_segments.json")
        if not os.path.exists(script_src):
            raise FileNotFoundError(f"script not found: {script_src}")
        with open(script_src, encoding="utf-8") as f:
            script = json.load(f)
        plan.append({
            "n": n,
            "id": f"{goal}_track{n}",
            "track_key": track_key,
            "title": script.get("track") or f"{TITLES[goal]} - Track {n}",
            "phase": t["phase"],
            "total_s": t["total_s"],
            "script_src": script_src,
            "segments": script["segments"],
            "mp3": f"{goal}_track{n}.mp3",
            "wav": f"{goal}_track{n}.wav",
        })
    return plan


def check_pad_headroom(plan: list, pad_path: str, strict: bool) -> list:
    """Project every track against the real pad before any credits are spent.

    The old failure mode was invisible until assembly: `voice_end` is the sum of
    real TTS durations, so a program that overran the pad only announced itself
    after the whole track had been bought (issue #5). Estimating from character
    counts makes it visible up front, for the price of reading one WAV header.

    `strict` raises instead of warning. It is on for --dry-run, whose entire job
    is to surface this, and off for a real render: the estimate is deliberately
    conservative, and assemble_track now shortens the outro rather than failing,
    so refusing to render on a projection would cost a sale to avoid a shorter
    music tail. Returns the list of problems found.
    """
    info = sf.info(pad_path)
    # Unconditional, even when strict is off: `strict` gates a *projection*,
    # which may be wrong in the safe direction. A wrong sample rate is not a
    # projection — the assembler will refuse this pad outright, so letting it
    # through buys a whole track of TTS for a render that cannot succeed.
    # sf.info reports duration as frames/samplerate, so the duration alone looks
    # perfectly normal for a 48 kHz pad; only the rate itself gives it away.
    if info.samplerate != timeline.SR:
        raise ValueError(f"pad sample rate is {info.samplerate}, expected "
                         f"{timeline.SR}: {pad_path}")
    pad_s = float(info.duration)
    rate = timeline.chars_per_sec()
    print(f"pad check: {os.path.basename(pad_path)} is {pad_s:.0f}s "
          f"(projecting at {rate:.1f} chars/s)", flush=True)

    problems = []
    for t in plan:
        est = timeline.estimate_voice_end(t["segments"], rate)
        label = f"  track {t['n']}/4 {t['track_key']}: voice ~{est:.0f}s"
        # Ask the assembler's own bound rather than restating it here, so this
        # gate cannot drift away from what the render will actually do.
        try:
            outro = timeline.resolve_actual_s(t["total_s"], est, pad_s) - est
        except ValueError as e:
            problems.append(f"track {t['n']} ({t['track_key']}): {e}")
            print(f"{label}  ** WILL NOT FIT ** — {e}", flush=True)
            continue
        line = (f"{label}, outro ~{outro:.0f}s, "
                f"headroom {pad_s - est - timeline.FADE_S:.0f}s")
        if outro < timeline.MIN_OUTRO_S:
            line += f"  (outro under the {timeline.MIN_OUTRO_S:.0f}s target)"
        print(line, flush=True)

    if problems and strict:
        raise ValueError("pad too short for the planned program: "
                         + "; ".join(problems))
    return problems


def planned_manifest(job_id: str, goal: str, voice_set: str, plan: list) -> dict:
    return {
        "jobId": job_id,
        "goal": goal,
        "goalTitle": TITLES[goal],
        "voiceSet": voice_set,
        "tracks": [
            {
                "n": t["n"],
                "id": t["id"],
                "title": t["title"],
                "phase": t["phase"],
                "durationSec": float(t["total_s"]),  # planned; real duration measured after mastering
                "mp3": t["mp3"],
                "wav": t["wav"],
            }
            for t in plan
        ],
        "createdAt": now_iso(),
    }


def run(job_id: str, goal: str, voice_set: str, outdir: str,
        dry_run: bool = False) -> None:
    if goal not in GOALS:
        raise ValueError(f"unknown goal: {goal}")
    if voice_set not in VOICE_SETS:
        raise ValueError(f"unknown voice set: {voice_set}")
    os.makedirs(outdir, exist_ok=True)
    job = Job(job_id, outdir)

    # ---- 1. scripting ----
    plan = plan_tracks(goal)
    pad_path = os.path.join(ENGINE_DIR, "pads", PADS[goal])
    if not os.path.exists(pad_path):
        raise FileNotFoundError(f"pad not found: {pad_path}")
    check_pad_headroom(plan, pad_path, strict=dry_run)
    for t in plan:
        shutil.copyfile(
            t["script_src"],
            os.path.join(outdir, f"{t['track_key']}_tts_segments.json"))
    total_segs = sum(len(t["segments"]) for t in plan)
    job.update("scripting", P_SCRIPTING,
               f"4-track script staged ({total_segs} segments), pad verified")

    if dry_run:
        print(json.dumps(planned_manifest(job_id, goal, voice_set, plan),
                         indent=2), flush=True)
        return

    # ---- 2. voicing + whisper-layer (all 4 tracks, global progress) ----
    render_track.load_key()  # resolve once; tts() reads the module global
    voices = VOICE_SETS[voice_set]
    done = 0
    for t in plan:
        raw_dir = os.path.join(outdir, f"{t['track_key']}_segments_raw")
        out_dir = os.path.join(outdir, f"{t['track_key']}_segments")
        os.makedirs(raw_dir, exist_ok=True)
        os.makedirs(out_dir, exist_ok=True)
        segs = t["segments"]
        n = len(segs)
        first_suggestion = next(
            (i for i, s in enumerate(segs) if s.get("phase") == "suggestion"), n
        )
        for i, seg in enumerate(segs):
            stage = "voicing" if i < first_suggestion else "whisper-layer"
            vid = voices["narrator"] if seg.get("phase") != "suggestion" else voices["whisper"]
            tag = "[soft] " if seg.get("phase") != "suggestion" else "[whispering] "
            out_path = os.path.join(out_dir, f"{seg['id']}.wav")
            done += 1
            progress = P_SCRIPTING + (done / total_segs) * (P_VOICE_END - P_SCRIPTING)
            detail = f"track {t['n']}/4 · segment {seg['id']}"
            if os.path.exists(out_path):
                job.update(stage, progress, f"{detail} already rendered")
                continue
            job.update(stage, progress, detail)
            raw_path = os.path.join(raw_dir, f"{seg['id']}.mp3")
            if not render_track.tts(vid, tag + seg["text"], raw_path):
                raise RuntimeError(
                    f"TTS failed for segment {seg['id']} (track {t['n']})")
            y, sr = render_track.mp3_to_float(raw_path)
            sf.write(out_path, render_track.treat(y, sr), sr, subtype="PCM_16")
            time.sleep(0.5)

    # ---- 3. entrainment-bed (assembly subprocess, per track) ----
    env = dict(os.environ)
    env.setdefault("HYPNO_DTYPE", "float32")
    env.setdefault("HYPNO_SKIP_QA", "1")
    for k, t in enumerate(plan):
        frac = k / len(plan)
        progress = P_VOICE_END + frac * (P_BED_END - P_VOICE_END)
        job.update("entrainment-bed", progress,
                   f"track {t['n']}/4 · mixing the entrainment bed")
        cmd = [
            sys.executable,
            os.path.join(ENGINE_DIR, "assemble_track.py"),
            t["track_key"],
            t["id"],  # assembler names its masters <TITLE>.wav/.mp3 -> <goal>_trackN.*
            pad_path,
            KEYWORDS[goal],
            str(t["total_s"]),
        ]
        proc = subprocess.Popen(
            cmd,
            cwd=outdir,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        assert proc.stdout is not None
        for line in proc.stdout:
            print(line, end="", flush=True)
        rc = proc.wait()
        if rc != 0:
            raise RuntimeError(
                f"assemble_track exited with code {rc} (track {t['n']})")
    job.update("entrainment-bed", P_BED_END, "All 4 entrainment beds mixed")

    # ---- 4. mastering-qa ----
    job.update("mastering-qa", P_BED_END, "Locating masters")
    manifest = planned_manifest(job_id, goal, voice_set, plan)
    for entry in manifest["tracks"]:
        mp3_path = os.path.join(outdir, entry["mp3"])
        wav_path = os.path.join(outdir, entry["wav"])
        if not os.path.exists(mp3_path) or not os.path.exists(wav_path):
            raise FileNotFoundError(
                f"mastered output not found for track {entry['n']}")
        entry["durationSec"] = round(float(sf.info(wav_path).duration), 1)
    manifest["createdAt"] = now_iso()
    write_json_atomic(os.path.join(outdir, "manifest.json"), manifest)

    # Only now that the masters exist and the manifest lists them are the
    # per-segment intermediates safe to drop — ~230 MB per job that nothing
    # reads again. A failed job keeps its segments for debugging, because this
    # line is never reached.
    removed, freed = job_files.prune_intermediates(outdir)
    if removed:
        print(f"cleanup: removed {removed} intermediate dirs "
              f"({freed / 1e6:.0f} MB)", flush=True)

    job.ready()
    total_min = sum(e["durationSec"] for e in manifest["tracks"]) / 60
    print(f"ready: {manifest['goalTitle']} — 4 tracks, {total_min:.1f} min total",
          flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goal", required=True)
    ap.add_argument("--voice-set", required=True)
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--dry-run", action="store_true",
                    help="plan only: verify scripts+pad, print planned manifest, no TTS")
    args = ap.parse_args()

    outdir = os.path.abspath(args.outdir)
    try:
        run(args.job_id, args.goal, args.voice_set, outdir, dry_run=args.dry_run)
        return 0
    except Exception as e:  # status.json must reflect ANY failure
        print(f"FAILED: {e}", flush=True)
        try:
            os.makedirs(outdir, exist_ok=True)
            write_json_atomic(os.path.join(outdir, "status.json"), {
                "jobId": args.job_id,
                "state": "failed",
                "stage": None,
                "progress": 0.0,
                "detail": "Render failed",
                "error": str(e),
                "updatedAt": now_iso(),
            })
        except Exception as e2:
            print(f"could not write failed status: {e2}", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
