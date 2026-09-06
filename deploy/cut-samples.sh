#!/usr/bin/env bash
# Cut any missing storefront sample, and never fail the deploy over it (#60).
#
# Usage: cut-samples.sh [ENGINE_DIR] [CATALOG_DIR]
#
# The samples are ~2-minute mixed excerpts of the pre-rendered masters, cut with
# ffmpeg over files that already exist: no TTS, no API key, no spend, and a
# no-op once every publishable program has one. That is what makes it safe to
# run on every deploy rather than leaving it as a step an operator has to
# remember after a pre-render.
#
# **This must never fail the deploy.** A program without a sample falls back to
# the solo voice clips on the storefront, which is the designed degradation;
# losing a deploy — and with it whatever else was in the push — over a marketing
# asset is the worse trade by a wide margin. So every failure path here exits 0
# and says what happened in the log.
#
# It lives in a script rather than inline in deploy.yml for the same reason
# wait-for-idle.sh does: inline workflow shell is the least testable place in
# the repo, and "cannot fail the deploy" is exactly the property that would
# regress silently and only be discovered during an incident.
#
# Ordering in deploy.yml matters twice over:
#   * AFTER the idle gate, so ffmpeg never competes with a live paid render.
#   * BEFORE the restart, because server.js indexes the samples at boot.
set -u

ENGINE_DIR=${1:-/srv/hypnosis-studio/engine}
CATALOG_DIR=${2:-/srv/hypnosis-studio/renders/catalog}
# Overridable so the tests can substitute a stub cutter. The venv is the
# interpreter the rest of the engine runs under; cut_samples.py itself is
# stdlib-only, so a system python would also do.
PYTHON=${HYPNO_PYTHON:-$ENGINE_DIR/venv/bin/python}

CUTTER="$ENGINE_DIR/cut_samples.py"

# Not an error. Every box is in this state until the first pre-render, and a
# deploy that shouted about it would be shouting on every push for weeks.
if [ ! -d "$CATALOG_DIR" ]; then
  echo "samples: no catalog at $CATALOG_DIR yet — nothing to cut"
  exit 0
fi

if [ ! -f "$CUTTER" ]; then
  echo "samples: $CUTTER is missing — skipping"
  exit 0
fi

if [ ! -x "$PYTHON" ]; then
  echo "samples: no interpreter at $PYTHON — skipping"
  exit 0
fi

# No `cd` needed: cut_samples.py resolves its own directory for the manifest, so
# it reads the catalog.json this deploy just copied in beside it.
if "$PYTHON" "$CUTTER" --catalog-dir "$CATALOG_DIR"; then
  exit 0
fi

# The cutter already printed which programs failed and why — a missing ffmpeg,
# a master that is not on this box, a cut that measured wrong. This line is the
# summary an operator scanning a deploy log will actually see.
echo "samples: cut incomplete — the storefront falls back to the solo voice" \
     "clips for any program without one. See the lines above; 'ffmpeg is not" \
     "installed' means this box needs ffmpeg and ffprobe on PATH."
exit 0
