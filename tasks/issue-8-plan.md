# Issue #8 — [P0.8] Reject truncated TTS responses

## Root cause

`tts()` writes whatever bytes arrive and returns `True`:

```python
with urllib.request.urlopen(req, timeout=120) as r:
    payload = r.read()
with open(out_path, "wb") as f:
    f.write(payload)
return True
```

No length check, no content-type check. A truncated or empty 200 — a proxy
hiccup, a Cloudflare mid-stream abort, an HTML error page served with the wrong
status — is recorded as success. Two outcomes:

- **Empty body**: `mp3_to_float` runs `np.concatenate([])` and raises
  `ValueError: need at least one array to concatenate`, *outside* any TTS error
  handling. The job dies blaming NumPy rather than ElevenLabs.
- **Decodable but truncated**: half a sentence is written to the segment WAV and
  **ships**. Per #6 nothing downstream notices — the QA gate checks the finished
  master's level and length, and one short segment inside an otherwise normal
  program does not move either.

## Design

### Sizing the floor

The request asks for `output_format=mp3_44100_128`, so a healthy response is
128 kbps CBR = **16000 bytes per second of speech**. That is a far friendlier
constant than #6's VBR encoder, but it is an assumption about the API and is
written down as one, not buried.

A fixed byte floor would only catch empty-and-tiny, not the "half a sentence"
case the issue calls out as worse. Instead the floor is derived from the text
being sent, reusing the estimator already built for #5:

```
expected_s     = len(tagged_text) / timeline.chars_per_sec()
expected_bytes = expected_s * BYTES_PER_SEC
floor          = expected_bytes * MIN_RESPONSE_FRACTION
```

`MIN_RESPONSE_FRACTION = 0.5`. The rate estimate is already deliberately
conservative (12.0 against a measured ~12.75), so a healthy response coming in
under half its predicted size would mean the voice spoke twice as fast as the
slow estimate — implausible. Truncation to half a sentence is caught.

### Retry, not fail

Criterion 1 says a short body is "treated as a failure and retried", which is
exactly what #7's machinery already does for a transient classification. A short
response becomes `Outcome("transient", True, ...)` and rides the existing
5/15/30 s backoff. This is why #8 follows #7 rather than preceding it.

### Content type

An HTML error page delivered with a 200 is a real failure mode behind
Cloudflare. `r.headers.get_content_type()` is free at that point; anything that
is not audio is transient.

## Changes

1. **`engine/tts_policy.py`** — `response_problem(payload, text, content_type)`
   returning a reason string or None, plus `BYTES_PER_SEC`,
   `MIN_RESPONSE_FRACTION`, `ABSOLUTE_MIN_BYTES`. Stdlib only, as before.
2. **`engine/render_track.py`** — validate before writing; a bad response takes
   the transient path. `mp3_to_float` guards the empty-chunk case with a clear
   error instead of letting `np.concatenate([])` raise.
3. **Tests** — `test_tts_policy.py` for the sizing, `test_tts_retry.py` for the
   retry-on-short-body behaviour and for byte-identical output on success.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| Body below a plausible minimum is a failure and is retried | `response_problem` + transient path |
| Empty response gives a clear TTS-layer error, not a NumPy traceback | `response_problem` + `mp3_to_float` guard |
| A successful segment is byte-identical to today | validation is read-only; write path untouched, pinned by a test |

## Decisions

1. **The floor is derived from the text, not a constant.** A constant catches
   empty; only a text-derived expectation catches the half-a-sentence case the
   issue calls the worse outcome.
2. **128 kbps CBR is an assumption, recorded as one.** It follows from the
   `output_format` in the request URL. If ElevenLabs ever serve VBR for that
   format the floor becomes loose rather than wrong — it would under-reject, not
   over-reject.
3. **`ABSOLUTE_MIN_BYTES` as a second, text-independent floor**, so a response
   that is obviously not audio is caught even if the text was very short.
