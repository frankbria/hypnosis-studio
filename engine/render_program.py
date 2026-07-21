"""Job worker: render one program end-to-end for a single job id.

Usage:
    python render_program.py --goal polymath --voice-set male --job-id <id> --outdir <abs path>

Stages (reported via status.json in outdir):
    scripting -> voicing -> whisper-layer -> entrainment-bed -> mastering-qa

status.json is written atomically (tmp file + os.replace) at every transition.
On any exception the state becomes "failed" with an error message and the
process exits 1. The ElevenLabs key is resolved once via render_track.load_key()
and is never printed.
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

import render_track

# ---------- registries ----------
GOALS = ("polymath", "golden_thread", "inner_studio", "open_gate")

SCRIPTS = {
    goal: os.path.join(ENGINE_DIR, "scripts", f"{goal}_tts_segments.json")
    for goal in GOALS
}

PADS = {
    "polymath": "pad_15.wav",
    "golden_thread": "pad_golden_15.wav",
    "inner_studio": "pad_studio.wav",
    "open_gate": "pad_gate.wav",
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
}

TITLES = {
    "polymath": "The Polymath Mind",
    "golden_thread": "The Golden Thread",
    "inner_studio": "The Inner Studio",
    "open_gate": "The Open Gate",
}

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


def run(job_id: str, goal: str, voice_set: str, outdir: str) -> None:
    if goal not in GOALS:
        raise ValueError(f"unknown goal: {goal}")
    if voice_set not in VOICE_SETS:
        raise ValueError(f"unknown voice set: {voice_set}")
    os.makedirs(outdir, exist_ok=True)
    job = Job(job_id, outdir)

    # ---- 1. scripting ----
    script_src = SCRIPTS[goal]
    if not os.path.exists(script_src):
        raise FileNotFoundError(f"script not found: {script_src}")
    pad_path = os.path.join(ENGINE_DIR, "pads", PADS[goal])
    if not os.path.exists(pad_path):
        raise FileNotFoundError(f"pad not found: {pad_path}")
    script_dst = os.path.join(outdir, f"{goal}_tts_segments.json")
    shutil.copyfile(script_src, script_dst)
    segs = json.load(open(script_dst, encoding="utf-8"))["segments"]
    job.update("scripting", P_SCRIPTING,
               f"Script staged ({len(segs)} segments), pad verified")

    # ---- 2. voicing + whisper-layer ----
    render_track.load_key()  # resolve once; tts() reads the module global
    voices = VOICE_SETS[voice_set]
    raw_dir = os.path.join(outdir, f"{goal}_segments_raw")
    out_dir = os.path.join(outdir, f"{goal}_segments")
    os.makedirs(raw_dir, exist_ok=True)
    os.makedirs(out_dir, exist_ok=True)

    n = len(segs)
    first_suggestion = next(
        (i for i, s in enumerate(segs) if s.get("phase") == "suggestion"), n
    )
    for i, seg in enumerate(segs):
        stage = "voicing" if i < first_suggestion else "whisper-layer"
        vid = voices["narrator"] if seg.get("phase") != "suggestion" else voices["whisper"]
        tag = "[soft] " if seg.get("phase") != "suggestion" else "[whispering] "
        out_path = os.path.join(out_dir, f"{seg['id']}.wav")
        frac = (i + 1) / n
        progress = P_SCRIPTING + frac * (P_VOICE_END - P_SCRIPTING)
        if os.path.exists(out_path):
            job.update(stage, progress, f"segment {seg['id']} ({i + 1}/{n}) already rendered")
            continue
        job.update(stage, progress, f"segment {seg['id']} ({i + 1}/{n})")
        raw_path = os.path.join(raw_dir, f"{seg['id']}.mp3")
        if not render_track.tts(vid, tag + seg["text"], raw_path):
            raise RuntimeError(f"TTS failed for segment {seg['id']}")
        y, sr = render_track.mp3_to_float(raw_path)
        sf.write(out_path, render_track.treat(y, sr), sr, subtype="PCM_16")
        time.sleep(0.5)

    # ---- 3. entrainment-bed (assembly subprocess) ----
    title = f"{TITLES[goal]} - Self Hypnosis"
    job.update("entrainment-bed", P_VOICE_END, "Mixing the entrainment bed")
    cmd = [
        sys.executable,
        os.path.join(ENGINE_DIR, "assemble_track.py"),
        goal,
        title,
        pad_path,
        KEYWORDS[goal],
        "900",
    ]
    env = dict(os.environ)
    env.setdefault("HYPNO_DTYPE", "float32")
    env.setdefault("HYPNO_SKIP_QA", "1")
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
        raise RuntimeError(f"assemble_track exited with code {rc}")
    job.update("entrainment-bed", P_BED_END, "Entrainment bed mixed")

    # ---- 4. mastering-qa ----
    job.update("mastering-qa", P_BED_END, "Locating masters")
    mp3_path = os.path.join(outdir, f"{title}.mp3")
    wav_path = os.path.join(outdir, f"{title}.wav")
    if not os.path.exists(mp3_path) or not os.path.exists(wav_path):
        raise FileNotFoundError("mastered output not found in outdir")
    duration = float(sf.info(wav_path).duration)
    manifest = {
        "jobId": job_id,
        "goal": goal,
        "goalTitle": TITLES[goal],
        "voiceSet": voice_set,
        "track": {
            "title": title,
            "durationSec": round(duration, 1),
            "mp3": os.path.basename(mp3_path),
            "wav": os.path.basename(wav_path),
        },
        "createdAt": now_iso(),
    }
    write_json_atomic(os.path.join(outdir, "manifest.json"), manifest)
    job.ready()
    print(f"ready: {title} ({duration / 60:.2f} min)", flush=True)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--goal", required=True)
    ap.add_argument("--voice-set", required=True)
    ap.add_argument("--job-id", required=True)
    ap.add_argument("--outdir", required=True)
    args = ap.parse_args()

    outdir = os.path.abspath(args.outdir)
    try:
        run(args.job_id, args.goal, args.voice_set, outdir)
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
