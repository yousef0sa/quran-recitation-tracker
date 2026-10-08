# Spike results / نتائج التجربة

> **الحالة:** القياس مكتمل على تسجيلات مشرف المشروع الخمسة (2026-10-08). **القرار: GO** — وافق مشرف المشروع على تعريف التأخّر «ظهور الكلمة مؤكَّدة (خضراء)».
> **Status:** measured on the maintainer's 5 recordings. **Decision: GO** — the maintainer approved "word shown as confirmed (green)" as the latency metric (2026-10-08).

## Setup

| Field | Value |
|---|---|
| Date | 2026-10-08 |
| Machine | Desktop PC, 8-core CPU, Windows |
| Browser and version | Chromium 152.0.7977.130 (desktop) |
| Backend | WASM single-thread (onnxruntime-web 1.24.2, `@tilawa/core` 0.4.0) |
| `navigator.hardwareConcurrency` | 8 |
| Recordings | 5 correct readings of Al-Fatiha by the maintainer, no isti'adha, no restarts: `1.aac` 37.7 s, `2.aac` 48.0 s, `3.aac` 39.1 s, `4.aac` 42.4 s (AAC stereo), `5.ogg` 31.0 s (phone voice message, Opus mono, slight clipping) |
| Labelling | tap labels at 0.5× by the maintainer. Taps land late, so true latency is ~50–125 ms **higher** than measured (same for all variants) |
| Chunk size(s) | 150 ms (all variants), 80 ms (B1, B2; bench feed only, the live page's worklet is fixed at 150 ms) |
| Asset hashes | `scripts/assets.json` as of 2026-10-08 |
| Raw data | `spike/results/*_results.json` + `*_eventlogs.json` (git-ignored) |

Notes on how the numbers are produced:

- Latency is audio-time based (chunk audio time minus the labelled word end), so it does not depend on CPU speed. RTF does.
- Each file is followed by 2.0 s of zero padding fed as ordinary chunks, then `stop()`. Padding counts toward duration and RTF.
- **Confirm** = first appearance in `word_progress.matched_indices` or in the `verdicts()` snapshot (ok/unsure). In the live page this is the moment a word turns green.
- **First signal** = min(cursor, confirm) per word — the earliest moment the screen shows the word as done.
- Determinism verified: B2 @ 150 ms run twice → identical per-word latencies.

## Per-variant summary (pooled over 5 files, 145 words; latencies in ms)

| Variant | Chunk | Tracked | Cursor p50 / p95 / max | **Confirm p50 / p95 / max** | **First signal p50 / p95** | False adv. | Back moves | Lock p50 (s) | Compute p50 / p95 / max | RTF | Load (ms) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| A1 | 150 | 138 (95.2 %) | 1129 / 4719 / 8438 | 522 / 4416 / 6108 | 545 / 4694 | 0 | 1 | 5.55 | 0.3 / 70 / 149 | 0.133 | 2300 |
| A2 | 150 | 137 (94.5 %) | 962 / 2754 / 9488 | 447 / 1824 / 6108 | 466 / 2176 | 0 | 2 | 1.65 | 0.5 / 70 / 152 | 0.141 | 2671 |
| B1 | 150 | 143 (98.6 %) | 1010 / 4278 / 5067 | 480 / 4543 / 5958 | 480 / 4252 | 0 | 2 | 5.70 | 0.6 / 71 / 663 | 0.190 | 3647 |
| B2 | 150 | 143 (98.6 %) | 888 / 1869 / 2305 | 404 / 1794 / 5958 | 407 / 1499 | 0 | 2 | 1.80 | 0.5 / 55 / 105 | 0.164 | 3255 |
| B1 | 80 | 143 (98.6 %) | 965 / 4254 / 4987 | 419 / 4451 / 5838 | 427 / 4214 | 0 | 2 | 5.60 | 0.3 / 52 / 107 | 0.167 | 3756 |
| **B2** | **80** | **143 (98.6 %)** | 835 / 1852 / 2195 | **379 / 1717 / 5838** | **387 / 1395** | **0** | 2 | **1.76** | 0.3 / 53 / 134 | **0.169** | 3723 |

Variants: A = tilawa default model a0w (T=61, hop 480 ms); B = raw Quran-Lab v3 c16 mirror (T=45, hop 320 ms).
1 = tracking mode (whole-Quran search to lock); 2 = correction mode + `setExpected(Fatiha 1–7)` (locks straight onto Al-Fatiha).

### After lock vs before lock (first signal, ms)

| Variant | Words after lock: p50 / p95 | mid-ayah p50 | ayah-end p50 | Words spoken before lock: n, p50 |
|---|---|---|---|---|
| A1 150 | 438 / 2154 | 376 | 962 | 33, 3257 |
| B1 150 | 379 / 1543 | 376 | 595 | 32, 3408 |
| B2 150 | 398 / 1507 | 394 | 408 | 11, 608 |
| **B2 80** | **374 / 1412** | **341** | **427** | **11, 568** |

## Live feel

| Variant | Notes |
|---|---|
| A1 | The maintainer recited live on 2026-10-08: highlight follows the recitation («نعم يتتبع»). Live lag not recorded. |
| A2 / B1 / B2 | Not yet tried live. |

## Failures and surprises

- **Cursor is not the earliest signal.** The original success criterion measured cursor advance (`word_index` → w+1), expecting it to come first with `matched_indices` lagging. Measured: confirm p50 ≈ 0.4 s, cursor p50 ≈ 0.85–1.1 s, for every variant. The cursor moves only after the *next* word is well under way; the word turns green earlier.
- **Late first lock in tracking mode (A1, B1):** 5–7 s, so the basmala and the start of ayah 2 are shown ~3.3 s late. Correction mode + expected Fatiha (A2, B2) locks in 1.4–3.2 s.
- **Word 17 (1:6, word 1)** is never confirmed in 2 of 5 files with B1/B2 (3 of 5 with A1/A2), though the cursor passes it.
- **File 2 (the maintainer confirms it was read correctly):** A1/A2 never confirm words 9–12 (1:3 word 2 and 1:4 words 1–3); B1/B2 confirm all 29. Model a0w is weaker here.
- **Backward cursor moves without a real restart:** 2 in file `4.aac` (B variants). The highlight jitters back briefly; no false advances anywhere.
- **Correction issues:** A2 logged 1 (file 2), B2 logged 0 — auto-dismissed by the bench.
- **p95 is high (~1.4 s in the best case)**, driven mostly by ayah-end words; single outliers reach 5.8 s.
- B1/B2 loaded and ran without errors (the T=45/hop=32 io override works).

## Decision criteria

- **GO**: cursor latency p50 <= 500 ms, >= 95 % of words tracked, RTF <= 0.3.
- **ADJUST**: p50 between 500 and 1000 ms, or 90–95 % tracked.
- **NO-GO**: p50 > 1000 ms, < 90 % tracked, or RTF > 0.8.

## Decision — GO (approved by the maintainer, 2026-10-08)

**Best variant: B2 @ 80 ms** (raw Quran-Lab v3 c16 + correction mode + expected Al-Fatiha). The 80 ms is the chunk size of the bench feed only; the live page's worklet is fixed at 150 ms today.

| Criterion | B2 @ 80 ms | Verdict |
|---|---|---|
| Latency p50 — as originally defined (cursor advance) | 835 ms | ADJUST |
| Latency p50 — what the user sees (word turns green) | 379 ms (≈ 430–500 ms with tap bias) | GO |
| Words tracked | 98.6 % | GO |
| RTF | 0.17 | GO |

**Decision: GO, with B2 @ 80 ms, measuring latency as "word turns green" (confirm).** The latency metric was updated accordingly.
Reason: the cursor was chosen as the metric only because research expected it to be the earliest signal; the data shows the green highlight is ~2× earlier and is what the reciter actually sees. If the original cursor-advance metric is kept, the result is **ADJUST**.

Conditions / follow-ups:
1. Define latency in the project documentation as "end of word → word shown as confirmed (green)".
2. Check on a mid-range phone (the success criterion covers laptop **and** phone; this run is a fast desktop — latency is CPU-independent, RTF is not).
3. Investigate word 17 (1:6, word 1) never confirming (2/5) and the ayah-end p95.
4. Live-test B2 once to confirm the feel.
5. Use 80 ms chunks in the live page (the worklet and `CHUNK_SAMPLES` are fixed at 150 ms today; the 80 ms results come from the bench feed only).
