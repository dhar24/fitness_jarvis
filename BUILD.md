# Build plan of record

One source of truth for what this is, what was decided, and what is out of
scope. If a decision changes, change it here rather than remembering it.

## What it is

A voice-first fitness and food logger for one household, built as the first
skill of a general household assistant. Speak, it logs, it confirms in under
a second. Ask, it answers from precomputed rollups.

## Latency budgets

Two paths, two budgets. Do not let them merge.

| Path | Budget | Rule |
|---|---|---|
| Logging | 700ms perceived | Never calls a model on the happy path |
| Summary | 1500ms | Model classifies, Postgres computes |

Breakdown for logging: 300ms batch STT measured, 5ms grammar
parse, 20ms local write and confirm. The Haiku fallback adds 500 to 800ms
and should fire on under 10% of utterances.

## Stack decisions

| Layer | Choice | Why |
|---|---|---|
| Client | PWA, React plus Vite | One codebase, no store review, installs from a link |
| STT | Groq whisper large v3 turbo, batch | whisper reads the full clip before commit, so indian food survive, measure d300ms |
|input | push to talk, hold to speak | elease is the endpoint. no endpointing wait, no runaway mic, no hanging transcript|
| TTS | None for logging, only for summaries | Speech back costs 400 to 800ms and irritates on rapid logging |
| Parser | Deterministic grammar first | Keeps the model out of the hot path |
| Fallback | Claude Haiku, strict JSON | Fast, cheap, good at constrained output |
| Backend | FastAPI, single service | Python, one language |
| Database | Supabase Postgres, ap-south-1 | Auth and RLS are the reason, not the database |
| Hosting | Fly.io Mumbai | Keeps the round trip in country |
| Wake word | Picovoice Porcupine, tablet only | Phones get push to talk, background mic is a tar pit |

## Sequence

| Phase | Ships | Done when |
|---|---|---|
| 1 | Mic, STT, transcript, latency readout | Median latency measured and accepted |
| 2 | Router with one skill, activity logging, optimistic write | You log a real workout by voice |
| 3 | Food logging, IFCT seed, recipe table, targets | You log a real meal and see goal progress |
| 4 | Query registry, summaries, second user | Partner uses it without being taught |
| 5+ | Wake word on the kitchen tablet | Optional, do not let it block 1 to 4 |

The router lands in phase 2 with exactly one skill in it. Retrofitting a
router after wake word and session state exist is genuinely painful.

## Design rules that are not negotiable

- The hot path never calls a model.
- The model never computes a number. It selects a query and fills parameters.
- Every log write is local first, synced second, idempotent via `client_id`.
- Macros are resolved and frozen at write time. Fixing a recipe later must
  not silently change what you ate last Tuesday.
- Targets are time versioned. Never update a target in place.
- Summaries read `daily_rollup` only. Never aggregate raw rows at read time.
- Unmatched utterances are logged, not swallowed. `parse_failure` and
  `query_miss` are the roadmap.

## Explicitly out of scope for v1

Wearable sync, barcode scanning, photo meal recognition, social features,
coaching, workout plans, native app wrappers, voice speaker identification,
text to SQL.

## Known risks

**Groq free tier is rate limited.** 
**Indian food coverage.** IFCT covers ingredients, not dishes. The dish to
ingredient table is seeded once by batch job and corrected by hand. Budget
one evening for the correction pass, and expect it to be the least fun part
of the build.

**Multi speaker on an always-on device.** Solved by an active speaker held
for 90 seconds, not by voice ID. Revisit only if that proves annoying.

## Open questions

- Does the partner want targets at all, or only logging? Ask before building
  target UI for two users.
- Timezone handling when travelling. `local_day` is client computed, so the
  behaviour is whatever the client decides. Decide it explicitly in phase 2.
