# Issue #7 — [P0.7] Retry network errors; fail fast on auth errors

## Root cause

`render_track.tts()` has two independent defects, both from the same control
flow (`render_track.py:50-70`):

```python
for settings in (settings_full, settings_nospeed):     # :50
    for retry in range(3):
        try: ... return True
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and retry < 2:
                time.sleep(5); continue                # the only retry path
            break                                      # <- exits the RETRY loop
        except Exception as e:
            break                                      # <- network errors, no retry
```

**1. The most likely failure has no retry at all.** `socket.timeout`, `URLError`
(connection reset, DNS blip, TLS error) are not `HTTPError`, so they land in the
generic `except Exception` and `break` immediately. A render is 152 sequential
HTTPS requests with a 120 s timeout each; a dropped connection is the single
most probable way one fails, and it is the one path with zero coverage. 504 and
Cloudflare's 520-524 are unretried too, and ElevenLabs sits behind Cloudflare.

**2. Every permanent failure is retried pointlessly.** The `break` exits only the
*retry* loop, so control falls out to the outer `for settings` loop and makes a
second complete attempt. That outer loop exists to retry a 422 rejecting the
`speed` parameter — but it fires for **every** error, including 401. A dead API
key therefore costs two requests per segment, and a bad key and a transient blip
are indistinguishable in `status.json` and `worker.log`: both say
`TTS failed for segment S01`.

## What the demo turned up that the issue did not

Driving old and new `tts()` through identical fault injection showed the old
code *appearing* to survive a network blip in 2 calls. It was not retrying. It
was falling through to the second settings pass — which exists to drop
`speed: 0.85`:

| fault | OLD recovers with | NEW recovers with |
|---|---|---|
| connection reset | `speed=None` (API default) | `speed=0.85` |
| Cloudflare 522 | `speed=None` | `speed=0.85` |
| HTTP 503 (already retryable) | `speed=0.85` | `speed=0.85` |

So a transient network error silently rendered that one segment at the API's
default speaking rate instead of 0.85, returned `True`, and logged nothing. In a
hypnosis program pacing *is* the product, and a segment at the wrong rate is
also a different duration — which feeds `voice_end`, and therefore #5's pad
clamp. The bug was not only "no retries"; it was silent audio degradation.

## Changes

### 1. New `engine/tts_policy.py` (stdlib only)

Same testability rationale as `job_files.py`, `timeline.py` and `qa.py`:
`render_track.py` imports numpy/scipy/av at module scope, so nothing in it is
reachable from a test without the whole audio stack. The *decision* — is this
error worth retrying, is it fatal, is it a credential problem — is pure logic
and belongs where it can be tested.

- `RETRYABLE_STATUSES` = 408, 429, 500, 502, 503, 504, 520-524
- `AUTH_STATUSES` = 401, 403
- `UNSUPPORTED_SETTINGS_STATUSES` = 422 — the one case the settings fallback is for
- `BACKOFF_S = (5, 15, 30)` — deterministic, no jitter. The concurrency lock
  means one render at a time, so there is no thundering herd to spread out, and
  a deterministic schedule is testable.
- `classify(status=None, exception=None, body="")` → `Outcome(kind, retryable, detail)`
  where `kind` is one of `ok | transient | auth | quota | unsupported_settings |
  fatal`.

**Quota is classified from the body, not the status code.** ElevenLabs signals
exhaustion inside the JSON detail, and reports it under more than one status, so
keying on the status alone would mislabel it. A body mentioning quota wins over
the status-code mapping.

### 2. `engine/render_track.py`

`tts()` keeps its `bool` return for `main()`, but raises a typed
`TtsError(kind, detail)` on a fatal classification so `render_program` can put a
meaningful cause in `status.json`. Control flow becomes:

- retry `transient` on `BACKOFF_S`, including `URLError`/`TimeoutError`/`OSError`
- `auth` and `quota` return immediately — **no second settings pass**
- only `unsupported_settings` (422) advances to `settings_nospeed`

### 3. `engine/render_program.py`

Surface the classification in the failure so `status.json` distinguishes "your
key is dead" from "the network blipped 3 times".

### 4. Tests — `engine/tests/test_tts_policy.py`, plus `tts()` driven against a
fake `urlopen` so the retry/backoff behaviour is exercised without network.

## Acceptance criteria → coverage

| Criterion | Covered by |
|---|---|
| `URLError`, `TimeoutError`, `OSError` retried on the same backoff as 5xx | `classify` + `tts` retry loop |
| 504 and 520-524 retryable | `RETRYABLE_STATUSES` |
| 401/403 return immediately without the second settings pass, distinct error | `tts` control flow + `TtsError(kind="auth")` |
| Quota exhaustion distinguishable in `status.json` | body-based classification surfaced through `render_program` |

## Explicitly out of scope

- **Truncated/short responses** — that is #8 (`Reject truncated TTS responses
  instead of recording them as success`). `tts()` writing whatever bytes arrive
  is left exactly as it is here so the two changes do not collide.
- **Not re-buying segments on retry** — that is #9.
