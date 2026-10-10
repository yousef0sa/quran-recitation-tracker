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
| Chunk size(s) | 150 ms (all variants), 80 ms (B1, B2; bench feed only at measurement time; the live page has used 80 ms by default since 2026-10-10) |
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
| B2 @ 80 ms | The maintainer recited live on 2026-10-10 (desktop, Chrome 155, WASM single-thread): «يلحق: ممتاز». One session, 52 s, four deliberate pauses of 5–6 s (one between ayahs 2 and 3, three mid-ayah: after 1:4 word 1, 1:5 word 2 and 1:7 word 6). First lock 2.4 s; after every pause the next word turned green within 0.3–0.6 s of speech resuming, with no snapshot drop, no re-lock and no backward cursor move. 28 of 29 words green; 1:6 word 1 (the same word as in follow-up 3) was never confirmed: the cursor jumped from 1:5 word 3 to 1:6 word 2. Compute p50 / p95 / max 0.2 / 65 / 450 ms per 80 ms chunk. |
| A2 / B1 | Not yet tried live. |

## Failures and surprises

- **Cursor is not the earliest signal.** The original success criterion measured cursor advance (`word_index` → w+1), expecting it to come first with `matched_indices` lagging. Measured: confirm p50 ≈ 0.4 s, cursor p50 ≈ 0.85–1.1 s, for every variant. The cursor moves only after the *next* word is well under way; the word turns green earlier.
- **Late first lock in tracking mode (A1, B1):** 5–7 s, so the basmala and the start of ayah 2 are shown ~3.3 s late. Correction mode + expected Fatiha (A2, B2) locks in 1.4–3.2 s.
- **Word 17 (1:6, word 1)** is never confirmed in 2 of 5 files with B1/B2 (3 of 5 with A1/A2), though the cursor passes it.
- **File 2 (the maintainer confirms it was read correctly):** A1/A2 never confirm words 9–12 (1:3 word 2 and 1:4 words 1–3); B1/B2 confirm all 29. Model a0w is weaker here.
- **Backward cursor moves without a real restart:** 2 in file `4.aac` (B variants). The highlight jitters back briefly; no false advances anywhere.
- **Correction issues:** A2 logged 1 (file 2), B2 logged 0 — auto-dismissed by the bench.
- **p95 is high (~1.4 s in the best case)**, driven mostly by ayah-end words; single outliers reach 5.8 s.
- B1/B2 loaded and ran without errors (the T=45/hop=32 io override works).
- **The verdict snapshot is wiped about 3 s after the last word, in every variant.** tilawa returns to search on idle/completed and `verdicts()` is then empty (it is documented as diagnostic only). The live page had shown only the last ayah green after Stop (29 -> 9); fixed by keeping words green until a new Start (2026-10-10). These were not wrong-word verdicts. A mid-recitation pause does not trigger it: in the live B2 test (2026-10-10) four pauses of 5–6 s caused no drop and no re-lock, so the end-of-recitation wipe is most likely `completed`, not silence.

## Follow-up 3: verdicts and settleFrames (2026-10-10)

Setup: B2 @ 80 ms, the same 5 recordings, headless Chromium 153.0.8010.12 (Playwright), Windows desktop, 8 cores, WASM single-thread, `@tilawa/core` 0.4.0. The bench now keeps every tilawa verdict (state, distance `d`, heard ratio `h`, margin `m`) in the EventLog, and `?settle=<n>` overrides `settleFrames`. All five recordings are correct readings, so any `wrong` / `skipped` verdict or correction issue below is a false alarm. Positions are `1:<ayah> w<n>`. Raw data: `spike/results/20261010-*` (git-ignored).

**Determinism.** A baseline run before any code change (`20261010-092349_B2_80ms_*`) is identical to the 2026-10-08 run (Chromium 152.0.7977.130) on every per-word cursor / confirm time, missed words, false advances, restarts, correction issues, and every EventLog entry's `confirmed` and `events`: no browser drift. The instrumented run (`20261010-093136_B2_80ms_*`) is identical to that baseline, and `settle=25` (`20261010-093440_B2_80ms_settle25_*`) is identical to the no-override run, including all 2609 entries' verdict fields. Logging and the override path change nothing.

**Tilawa's rule for a verdict** (`verdicts.js`): `pending` while the word is the cursor word and the stream is not settled, or within `commitDwell` (6 frames) of the end of what was heard while the stream is unsettled; then `ok` if `d` <= 0.15, `unsure` if `d` <= 0.40 or `m` < 0.35, else `wrong`; `skipped` only for interior words heard < 34 %. The engine decodes 8 frames (25 Hz) per 320 ms step, so `settleFrames` acts in whole steps: 25 -> 4 steps (1.28 s), 18 -> 3 (0.96 s), 12 -> 2 (0.64 s).

### 1:6 w1 in 3.aac and 4.aac

It is heard and judged `wrong`, not skipped and not missing from the list. Both files end with the identical verdict `wrong`, `d` 0.429, `h` 0.571, `m` 0.995 (consistent with 3 edits in 4 aligned characters of a 7-phoneme word; the expected length is inferred from the ratios). `wrong` needs `d` > 0.40 and `m` >= 0.35, and 0.995 is far above the margin escape. In the three files where it is confirmed: 1.aac `unsure` (`d` 0.286, `h` 0.714, `m` 0.921), 5.ogg `unsure` (0.286 / 0.714 / 0.854), 2.aac `ok` (0 / 1.000 / 0.867). So the difference is about one phoneme: 2 edits (0.286) stay under the 0.40 line, 3 edits (0.429) go over it. The cursor is not the cause: in 3.aac it jumped from 1:5 w4 to 1:6 w2 at 22.88 s without stopping on 1:6 w1 (the word is listed `pending` in that very step and `wrong` one step later, 23.20 s), but in 5.ogg it also jumped over the word (18.40 s) and the word still ended `unsure`. In 4.aac the cursor went in and out of 1:6 w1 (19.68, 20.32 s), back to 1:5 w2-w4 (20.96-22.24 s) and left to 1:6 w2 at 24.48 s; the word became `wrong` at 24.80 s. The live test (2026-10-10) showed the same cursor jump. `settleFrames` does not touch it (still MISS at 25, 18 and 12).

### 1:5 w4 in 4.aac (5838 ms)

Not a settle effect. The word's labelled end is 18.64 s. Like in the other files it had `d` 0.167, `h` 0.833 and was still `pending` at 19.68 s, when the cursor left to 1:6 w1 (+1.04 s, normal). Then the transcript kept growing (1-5 new characters in most steps until 24.8 s) and the alignment moved: at 20.00 s the cursor came back to 1:5 w4 and the distance jumped to 0.688 (`h` 0.667), the word was `wrong` for one step (20.64 s), the cursor went back to 1:5 w2-w3 (20.96-21.60 s) and re-advanced to 1:5 w4 at 22.24 s. It left for 1:6 w2 only at 24.48 s, with the word `unsure` (`d` 0.167, `h` 0.833, `m` 0.883): 24.48 - 18.64 = 5.84 s. The two backward cursor moves of 4.aac are this episode. The labels also put the end of 1:6 w1 at 23.77 s, 5.1 s after 1:5 w4 (about 1.0 s in 1.aac and 3.aac), so there is about 4 s of sound between the two words in this recording: whether the reciter repeated or hesitated there is for the maintainer to check by listening around 19-24 s. With `settle=12` the word is still 5198 ms.

### Ayah-end words in general

In 22 of the 35 ayah-end cases the verdict reaches `d` <= 0.15 and `h` >= 0.9 between 0.95 s before and 0.65 s after the labelled end; in the 17 of these that leave `pending` in the log, it stays `pending` another 0.96-2.88 s (the other 5 are 1:7 w9, see below), until the cursor moves on or the stream settles. Confirmation of 1:2 w4 (5/5 files, 1577-1719 ms), 1:5 w4 (3/5, 1747-1886 ms; 2.aac 239 ms, 4.aac the outlier above), 1:6 w3 (2.aac 1756 ms, 5.ogg 1467 ms) and 1:7 w9 (3.aac / 4.aac / 5.ogg: 1586 / 1816 / 1874 ms) follows this. For 1:7 w9, which has no next word, the confirm comes exactly 1.28 s (4 steps) after the last new character in all three files. Ayah ends the reciter joins to the next ayah are fast (for example 1:4 w3, 123-567 ms).

### settleFrames sweep (B2 @ 80 ms, 5 files, 145 words, same browser)

| settleFrames (effective wait) | Ayah-end confirm p50 / p95 (n = 35) | Interior p50 / p95 (n = 108) | Overall p50 / p95 (n = 143) | Tracked | False adv. | Restarts | Correction issues | Words ever `wrong` | Words ever `skipped` | 1:6 w1 |
|---|---|---|---|---|---|---|---|---|---|---|
| 25 (1.28 s, tilawa default) | 427 / 1878 | 375 / 1035 | 379 / 1717 | 143 (98.6 %) | 0 | 2 | 0 | 3 | 0 | 1.aac 852, 2.aac 636, **3.aac MISS, 4.aac MISS**, 5.ogg 751 |
| 18 (0.96 s) | 414 / 1837 | 375 / 1035 | 376 / 1574 | 143 (98.6 %) | 0 | 2 | 0 | 3 | 0 | same |
| 12 (0.64 s) | 247 / 1215 | 375 / 1035 | 341 / 1058 | 143 (98.6 %) | 0 | 2 | 0 | 3 | 0 | same |

The "ever wrong" words are the same three at every value: 1:6 w1 in 3.aac and 4.aac (above) and one transient step of 1:5 w4 in 4.aac (above). Nothing is ever `skipped` and no correction issue was raised. What changes:

- 25 -> 18 moves 5 words (1:7 w9 in three files and 2.aac 1:2 w4 about 320 ms earlier; 2.aac 1:6 w3 from 1756 to 156 ms). 25 -> 12 moves 15 words, by about 640 ms for the pausal ayah ends (1:2 w4 1577-1719 -> 937-1079 ms, 1:5 w4 1747-1886 -> 856-1107 ms).
- **Side effect at 12:** 1:7 w9 is marked matched before its labelled end in 5 of 5 files (-1729 to -46 ms; 2 of 5 at 25 and 18). In 3.aac the engine listed it as matched at 35.68 s, while the verdict list had it 70.6 % heard (`h` 0.706) and the label puts the word's end at 36.65 s. A final word shown green about a second before it is finished is the kind of early signal Phase 5 must not produce. 2.aac 1:6 w3 also crosses zero (-164 ms).
- 4.aac 1:5 w4 stays 5838 / 5838 / 5198 ms: unrelated to the setting.
- Limit: 5 recordings of one reciter, all correct, no deliberate mistakes and no long mid-ayah pause. They cannot show whether lower values add false alarms in other readings.

### Recommendation (pending the maintainer's decision; no default was changed)

1. Keep `settleFrames` at 25 for now. 18 gives little (p95 1717 -> 1574 ms); 12 gives the real gain (ayah-end p95 1878 -> 1215 ms, overall p95 1717 -> 1058 ms) with no new `wrong`, `skipped` or correction issue on these recordings, but it confirms the last word early. Before adopting 12 (or something between), re-run on more recordings (PRD Phase 3), including a reading with a deliberate mistake and a long pause inside an ayah, and decide how the final word is handled.
2. 1:6 w1 needs a different lever than `settleFrames`: its distance is 0.429 against `unsureDistance` 0.40. Raising that threshold would also make real errors at distance 0.40-0.43 read `unsure`, which matters for Phase 5. Candidates only, not tried: `unsureDistance`, `minMargin`, `commitDwell`, `anchorAyahEnd`.
3. The 1:5 w4 outlier in 4.aac comes from the cursor moving back and forth while the recording has extra sound; listen to it first.

## Decision criteria

As planned before the run. Latency was later redefined as confirm latency (see the decision below).

- **GO**: cursor latency p50 <= 500 ms, >= 95 % of words tracked, RTF <= 0.3.
- **ADJUST**: p50 between 500 and 1000 ms, or 90–95 % tracked.
- **NO-GO**: p50 > 1000 ms, < 90 % tracked, or RTF > 0.8.

## Decision — GO (approved by the maintainer, 2026-10-08)

**Best variant: B2 @ 80 ms** (raw Quran-Lab v3 c16 + correction mode + expected Al-Fatiha). The 80 ms was measured with the bench feed; the live page now runs 80 ms by default (follow-up 5).

| Criterion | B2 @ 80 ms | Verdict |
|---|---|---|
| Latency p50 — as originally defined (cursor advance) | 835 ms | ADJUST |
| Latency p50 — what the user sees (word turns green) | 379 ms (≈ 430–500 ms with tap bias) | GO |
| Words tracked | 98.6 % | GO |
| RTF | 0.17 | GO |

**Decision: GO, with B2 @ 80 ms, measuring latency as "word turns green" (confirm).** The latency metric was updated accordingly.
Reason: the cursor was chosen as the metric only because research expected it to be the earliest signal; the data shows the green highlight is ~2× earlier and is what the reciter actually sees. If the original cursor-advance metric is kept, the result is **ADJUST**.

Conditions / follow-ups:
1. ✅ Define latency in the project documentation as "end of word → word shown as confirmed (green)". Done: PRD success metrics and decision log, `README.md` column definitions (2026-10-10).
2. Check on a mid-range phone (the success criterion covers laptop **and** phone; this run is a fast desktop — latency is CPU-independent, RTF is not).
3. ✅ (diagnosed, not fixed) Investigate word 17 (1:6, word 1) never confirming (2/5) and the ayah-end p95. Done: see "Follow-up 3" (2026-10-10). 1:6 w1 is judged `wrong` at distance 0.429 against a 0.40 limit; the ayah-end delay is the `pending` wait, and `settleFrames` 12 cuts ayah-end p95 from 1878 to 1215 ms but confirms the last word early. Defaults unchanged; the choice is the maintainer's.
4. ✅ Live-test B2 once to confirm the feel. Include a deliberate 4-5 s pause once mid-ayah and once between ayahs. Done: see Live feel (2026-10-10).
5. ✅ Use 80 ms chunks in the live page. Done: the live page defaults to 80 ms and B2, selectable with `?chunk=80|150|300`; the chunk size is defined only in `src/audio.ts` and reaches the worklet via `processorOptions` (2026-10-10).
