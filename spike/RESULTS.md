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
| Recordings | 5 correct readings of Al-Fatiha by the maintainer, no isti'adha; `4.aac` has one deliberate repeat inside ayah 5 (confirmed by the maintainer, 2026-10-10), the others none: `1.aac` 37.7 s, `2.aac` 48.0 s, `3.aac` 39.1 s, `4.aac` 42.4 s (AAC stereo), `5.ogg` 31.0 s (phone voice message, Opus mono, slight clipping) |
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

## Follow-up 2: phone and WASM threads (2026-10-10)

> المتابعة 2: على جوال متوسط (Redmi Note 8) كان B2 بخيط واحد أبطأ من الوقت الحقيقي (RTF 1.22). بأربعة خيوط صار 0.68: أسرع من الوقت الحقيقي، لكنه لم يبلغ هدف 0.3. لم يتغيّر أي إعداد افتراضي.

Setup: B2 @ 80 ms, the same 5 recordings, `@tilawa/core` 0.4.0, onnxruntime-web 1.24.2. `?threads=1|2|4` (default 1) sets `ort.env.wasm.numThreads`; the dev and preview servers now send COOP/COEP so every page is cross-origin isolated (needed for SharedArrayBuffer). Every run below reports requested = effective threads and `crossOriginIsolated: true`. Phone: Xiaomi Redmi Note 8 (Snapdragon 665, 8 cores, Android 9), Chrome 138.0.7204.179, through `adb reverse` to the loopback dev server. Desktop: headless Chromium 153.0.8010.12, Windows, 8 cores. Model step = chunks where the model ran (compute > 5 ms, ~650 per run; compute p50 is < 1 ms everywhere because most 80 ms chunks only buffer). Raw data: `spike/results/20261010-1[5-8]*` (git-ignored).

Single-thread phone runs before the headers (`20261010-150805_B2_80ms`, `20261010-163757_A2_80ms`): B2 RTF 1.22, load 17.2 s (cold); A2 RTF 0.98, load 8.7 s. Both NO-GO (> 0.8). Per word (cursor / confirm times, verdict states) identical to desktop; only speed differs.

| Device | Threads | Run | RTF | Model step p50 / p95 (ms) | Load (ms) | Battery °C before → after | Tracked | Confirm p50 / p95 (ms) |
|---|---|---|---|---|---|---|---|---|
| Phone | 1 | `175959` | 1.21 | 368 / 384 | 10 448 (warm) | 36.0 → 36.0 | 143 / 145 | 379 / 1717 |
| Phone | 4 | `180617_t4` | **0.68** | 200 / 226 | 12 370 (warm) | 36.0 → 39.3 | 143 / 145 | 387 / 1717 |
| Phone | 2 | `182310_t2` | 0.85 | 258 / 277 | 11 878 (warm) | 37.3 → 37.3 | 143 / 145 | 387 / 1717 |
| Phone | 1 | `183117` | 1.21 | 368 / 382 | 12 322 (warm) | 37.3 → 37.3 | 143 / 145 | 379 / 1717 |
| Desktop | 1 | `174658` | 0.187 | 55 / 71 | 4 301 (cold) | | 143 / 145 | 379 / 1717 |
| Desktop | 4 | `174735_t4` | 0.145 | 42 / 61 | 3 132 (cold) | | 143 / 145 | 379 / 1717 |
| Desktop | 2 | `174813_t2` | 0.147 | 43 / 60 | 2 856 (cold) | | 143 / 145 | 379 / 1717 |
| Desktop | 4 | `174855_t4` | 0.160 | 44 / 76 | 4 472 (cold) | | 143 / 145 | 379 / 1717 |

- **The threads run.** Desktop: `page.workers()` shows 0 / 1 / 3 ORT pthread workers for 1 / 2 / 4 threads (N-1, as expected). Phone, during t4 (`top -H`): four renderer `DedicatedWorker` threads busy at 83-85 % each (the tracker worker + 3 pthreads), 339 % CPU in total. The model step drops with N on both devices.
- **Phone: 4 threads is the only setting under 0.8**, with 32 % headroom; 2 threads (0.85) is still NO-GO. Neither reaches the 0.3 GO target. The two t1 runs agree (1.2065 vs 1.2074) and match the earlier run (1.2158): no heat drift or browser drift. t4 warmed the battery by 3.3 °C in one ~4 min run.
- **Desktop: about 20-25 % faster**, and 4 threads is no better than 2 (t4 vs t4 varies by 10 %).
- **Control:** with the headers, t1 is per-word identical to the run before them, on both devices (desktop: `173449` vs `174658`; phone: `150805` vs `175959`).
- **Per-word effect.** Threads change float summation order, so the match score `m` moves slightly in about 50 words (desktop ≤ 0.03, phone ≤ 0.15). Desktop t2 and t4: cursor / confirm times and final verdict states identical to t1; t4 vs t4 identical. Phone t2 and t4 (identical to each other): one word differs from t1, 1:4 w3 in `1.aac`, confirmed at 648 instead of 328 ms and ending `unsure` (`d` 0.25) instead of `ok`. Not a false alarm (`unsure` is not shown as one), but a real, device-specific numeric effect.
- **Production build: threads hang.** Under `vite preview` the pages are isolated, but `index.html?threads=2` never becomes ready within 60 s (no ORT pthread worker starts; 1 thread works). ORT is bundled into the tracker-worker chunk, so its pthread script is that chunk. Not fixed here; Phase 6 needs a fix (e.g. serving ORT's own `.mjs` via `env.wasm.wasmPaths`) plus the same COOP/COEP headers on the host.

**Verdict against the criteria:** phone B2 @ 80 ms with 4 threads is between NO-GO (> 0.8) and GO (≤ 0.3); tracking and confirm latency are unchanged.

**Maintainer's decision (2026-10-10):** tried live on the phone with 4 threads: «يلحق، بسرعة لا بأس بها». 4 threads is the default on phones (by user agent: Android, iPhone, `Mobile`), provisional and to be revisited; desktop stays at 1. `?threads=` still overrides it. Before any hosted build, the production-build hang below must be fixed, or phones would not load. If 0.68 is not enough headroom (UI and mic also need the CPU, and heat builds up), the next levers are: 8 threads, an onnxruntime-web upgrade, A2 with threads (0.98 single-thread), a smaller model.

## Follow-up 3: verdicts and settleFrames (2026-10-10)

Setup: B2 @ 80 ms, the same 5 recordings, headless Chromium 153.0.8010.12 (Playwright), Windows desktop, 8 cores, WASM single-thread, `@tilawa/core` 0.4.0. The bench now keeps every tilawa verdict (state, distance `d`, heard ratio `h`, margin `m`) in the EventLog, and `?settle=<n>` overrides `settleFrames`. All five recordings are correct readings, so any `wrong` / `skipped` verdict or correction issue below is a false alarm. Positions are `1:<ayah> w<n>`. Raw data: `spike/results/20261010-*` (git-ignored).

**Determinism.** A baseline run before any code change (`20261010-092349_B2_80ms_*`) is identical to the 2026-10-08 run (Chromium 152.0.7977.130) on every per-word cursor / confirm time, missed words, false advances, restarts, correction issues, and every EventLog entry's `confirmed` and `events`: no browser drift. The instrumented run (`20261010-093136_B2_80ms_*`) is identical to that baseline, and `settle=25` (`20261010-093440_B2_80ms_settle25_*`) is identical to the no-override run, including all 2609 entries' verdict fields. Logging and the override path change nothing.

**Tilawa's rule for a verdict** (`verdicts.js`): `pending` while the word is the cursor word and the stream is not settled, or within `commitDwell` (6 frames) of the end of what was heard while the stream is unsettled; then `ok` if `d` <= 0.15, `unsure` if `d` <= 0.40 or `m` < 0.35, else `wrong`; `skipped` only for interior words heard < 34 %. The engine decodes 8 frames (25 Hz) per 320 ms step, so `settleFrames` acts in whole steps: 25 -> 4 steps (1.28 s), 18 -> 3 (0.96 s), 12 -> 2 (0.64 s).

### 1:6 w1 in 3.aac and 4.aac

It is heard and judged `wrong`, not skipped and not missing from the list. Both files end with the identical verdict `wrong`, `d` 0.429, `h` 0.571, `m` 0.995 (consistent with 3 edits in 4 aligned characters of a 7-phoneme word; the expected length is inferred from the ratios). `wrong` needs `d` > 0.40 and `m` >= 0.35, and 0.995 is far above the margin escape. In the three files where it is confirmed: 1.aac `unsure` (`d` 0.286, `h` 0.714, `m` 0.921), 5.ogg `unsure` (0.286 / 0.714 / 0.854), 2.aac `ok` (0 / 1.000 / 0.867). So the difference is about one phoneme: 2 edits (0.286) stay under the 0.40 line, 3 edits (0.429) go over it. The cursor is not the cause: in 3.aac it jumped from 1:5 w4 to 1:6 w2 at 22.88 s without stopping on 1:6 w1 (the word is listed `pending` in that very step and `wrong` one step later, 23.20 s), but in 5.ogg it also jumped over the word (18.40 s) and the word still ended `unsure`. In 4.aac the cursor went in and out of 1:6 w1 (19.68, 20.32 s), back to 1:5 w2-w4 (20.96-22.24 s) and left to 1:6 w2 at 24.48 s; the word became `wrong` at 24.80 s. The live test (2026-10-10) showed the same cursor jump. `settleFrames` does not touch it (still MISS at 25, 18 and 12).

### 1:5 w4 in 4.aac (5838 ms)

Not a settle effect. The word's labelled end is 18.64 s. Like in the other files it had `d` 0.167, `h` 0.833 and was still `pending` at 19.68 s, when the cursor left to 1:6 w1 (+1.04 s, normal). Then the transcript kept growing (1-5 new characters in most steps until 24.8 s) and the alignment moved: at 20.00 s the cursor came back to 1:5 w4 and the distance jumped to 0.688 (`h` 0.667), the word was `wrong` for one step (20.64 s), the cursor went back to 1:5 w2-w3 (20.96-21.60 s) and re-advanced to 1:5 w4 at 22.24 s. It left for 1:6 w2 only at 24.48 s, with the word `unsure` (`d` 0.167, `h` 0.833, `m` 0.883): 24.48 - 18.64 = 5.84 s. The two backward cursor moves of 4.aac are this episode. The labels also put the end of 1:6 w1 at 23.77 s, 5.1 s after 1:5 w4 (about 1.0 s in 1.aac and 3.aac), so there is about 4 s of sound between the two words in this recording: the maintainer confirmed a deliberate repeat there (2026-10-10). So the 5838 ms is the repeat, not latency, and the two backward cursor moves are a correctly tracked restart. With `settle=12` the word is still 5198 ms.

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
3. The 1:5 w4 outlier in 4.aac is a deliberate repeat (confirmed by the maintainer): a correctly tracked restart, not a latency problem.

**Maintainer's decisions (2026-10-10):** `settleFrames` stays 25 until the tracker can tell a held long vowel (madd) from silence, so ayah ends can be confirmed early without the last word turning green while it is still being held. 1:6 w1 on files 3 and 4 is kept as a "may be wrong" case for now, until this is settled.

## Trust set: false alarms on correct readings (2026-10-10)

> مجموعة الثقة: ثمانية تسجيلات منشورة للفاتحة بأصوات قرّاء معروفين، تُستخدم فقط لعدّ التنبيهات الكاذبة على قراءة صحيحة. أرقامها لا تُدمج مع تسجيلات صاحب المشروع.

Setup: B2 @ 80 ms, headless Chromium 153.0.8010.12, WASM single-thread, `@tilawa/core` 0.4.0. 8 studio recordings (mp3) in `spike/recordings/trust/` (git-ignored, third-party audio, never committed), by Saad Al-Ghamdi, Ali Al-Hudhaifi, Ammar Luay Al-Mulla Ali, Fares Abbad, Maher Al-Muaiqly, Mohamed Siddiq Al-Minshawi (murattal), Mishary Rashid Alafasy and Yasser Al-Dosari. Labelled by the maintainer. Each recording is a correct reading, so any `wrong` / `skipped` verdict or correction issue counts as a false alarm. Raw data: `spike/results/trust-20261010T083518_*` (default) and `trust-20261010T083629_*` (`settle=12`).

| settleFrames | Tracked | Words ever `wrong` | Words ever `skipped` | Correction issues | False adv. | Restarts | Interior confirm p50 / p95 (n = 176) | Overall p50 / p95 (n = 232) | First lock |
|---|---|---|---|---|---|---|---|---|---|
| 25 (default) | **232 / 232 (100 %)** | **0** | **0** | **0** | 0 | 0 | 335 / 1064 | 295 / 1473 | 1.44-2.08 s |
| 12 | 232 / 232 (100 %) | 0 | 0 | 0 | 0 | 0 | 335 / 1064 | 262 / 1097 | same |

- **No false alarm** in 8 readings by 8 reciters at either setting.
- **1:6 w1 is confirmed in all 8** (199-649 ms). The `wrong` verdict on the maintainer's files 3 and 4 is therefore not a model blind spot for this word: the model hears those two readings about one phoneme away from the expected form. In the app this is the case to show as "may be wrong", never as a ruling.
- `unsure` (not shown as an alarm) in the final verdict list: 1:1 w4 for 4 reciters (`d` 0.2, likely the pausal form at the ayah end), and 1:2 w1 and 1:3 w1 for one reciter. Everything else ends `ok`.
- **Ayah-end latency is not reported for this set**: many ayah-end words are confirmed before their labelled end (down to -2.2 s), so the ayah-end labels here sit after the long vowel or the breath. The interior numbers match the maintainer's set (335 / 1064 vs 375 / 1035 ms).
- Limits: clean studio audio by professional reciters is easier than a phone mic in a room. This set shows that correct readings are not flagged; it says nothing about catching real mistakes.

## Follow-up 6: speed and accuracy experiments (2026-10-11)

> المتابعة 6: اختبرنا أفكار البحث قبل اعتماد أي شيء.
> - 4 خيوط تسرّع الكمبيوتر 1.6× بنفس النتائج تمامًا، وصارت تعمل في نسخة الإنتاج خلف مفتاح تجريبي.
> - fp32 أبطأ من int8، فرفضناه.
> - نموذج a0w أسرع بنحو 25% لكنه أقل دقة على تسجيلاتك، فرفضناه.
> - بوابة «صمت أم مد» لنهاية الآية آمنة على تسجيلاتك، لكن فائدتها شبه معدومة، وفيها حالات مبكرة على مجموعة الثقة. وبوابة احتمال الفراغ (CTC) تؤكد أثناء المد، فرفضناها.
> - المرحلة B (ملفات Quran-Lab):
>   - نموذج v3 الرسمي (مقطع 24) أسرع بنحو 22% بأربعة خيوط، ويتتبع كل الكلمات، ويؤكد 1:6 w1 في كل الملفات، ونظيف على مجموعة الثقة.
>   - لكنه يرسب في شرط صارم واحد (كلمة جديدة ظهرت خطأ مؤقتًا)، ونهاية الآية عنده أبطأ قليلًا.
>   - fp32 الرسمي أبطأ بلا فائدة. v3.1 أسوأ من v3 هنا. وتقصير الذاكرة (left 128/64) لا يسرّع، ويزيد الأخطاء الكاذبة.
> - قياسات الجوال لم تُشغَّل بعد.
>
> لم يتغيّر أي إعداد افتراضي.

Plan: `.claude/PRPs/plans/speed-accuracy-experiments.plan.md`. Research: `.claude/PRPs/research/research-speed-accuracy.md`. Setup: headless Chromium 153.0.8010.12, Windows desktop with 8 cores, ORT WASM (onnxruntime-web 1.24.2), `@tilawa/core` 0.4.0, chunk 80 ms, dev server on loopback. Raw data: `spike/results/20261011-*` (git-ignored).

Accuracy guards, per set: tracked; words ever `wrong`/`skipped`; issues; false advances; restarts; interior confirm; first lock. Each set is compared at the same thread count with `scripts/compare-runs.ts`. Speed rule: 3 interleaved maintainer runs per side. "Faster" means every candidate run beats every baseline run by more than the baseline's own spread, with RTF moving the same way.

**Controls.**
- New baselines (`20261011-133745` t1, `-133945` t4, and their trust runs) are per-word identical to the 2026-10-10 runs, so there is no browser drift.
- Two t4 runs are identical, so t4 is deterministic on this desktop.
- The timed-session wrapper (the model runs through `{session, Tensor}` instead of tilawa's own `create`) is per-word identical on both sets at t1 and t4.
- `?model=` with the shipped file is identical.

**What the model is.** Checked with `scripts/model/inspect_model.py`:
- ir 7, opset 13;
- 290 `MatMulInteger` and 264 `DynamicQuantizeLinear`, all per-tensor QInt8;
- 80 float `MatMul`, 70 `Conv`; T 45, left context 256.

ORT's CPU optimizer already fuses the quantized MatMuls (242 `DynamicQuantizeMatMul` + 48 `MatMulIntegerToFloat`), so there is no unfused graph to fix. The model is already per-tensor, so the per-tensor re-quantization (M5) was skipped.

### Desktop results (maintainer set: 3 runs each; trust set: 1 run each)

| Lever | Config | Model step p50 (ms) | Model ms per audio s | RTF | Accuracy (both sets) | Verdict |
|---|---|---|---|---|---|---|
| — | B2 int8, t1 (M1) | 46.6-47.1 | 155-160 | 0.162-0.166 | baseline: 143/145, the same 3 ever-wrong, 0 issues; trust 232/232, 0 | — |
| S1 | B2 int8, t4 (M2) | 28.3-30.4 | 104-108 | 0.111-0.115 | identical to t1 on both sets | **faster (≈1.6×), accuracy identical** |
| S2 | B2 dequantized fp32, t1 (M3) | 60.7-62.8 | 204-220 | 0.211-0.226 | identical to M1 | **slower** (and 263 MB instead of 73 MB) |
| S2 | B2 dequantized fp32, t4 (M4) | 35.1-42.5 | 124-148 | 0.130-0.154 | identical to M2 | **slower** |
| A1 | A2 (a0w, 480 ms step), t1 (M6) | 50.6-53.8 | 116-120 | 0.120-0.125 | maintainer **137/145, 11 ever wrong/skipped, 1 issue**; trust 232/232, 0, interior p95 935 vs 1064 | **faster by ms/audio s, fails accuracy** |
| A1 | A2, t4 (M7) | 29.1-32.2 | 69-74 | 0.074-0.079 | maintainer **142/145, 6 ever wrong/skipped**; trust 232/232, 0, interior p95 927 | **faster, fails accuracy** |

- **Prod threads (S1).** The flagged build runs 4 threads with 3 pthread workers and `crossOriginIsolated`: `VITE_EXPERIMENT_PROD_THREADS=1 npm run build`, preview on loopback, ORT's own `.mjs`/`.wasm` via `wasmPaths`.
  - Ready in about 4 s, with a recording per-word identical to the dev t4 baseline.
  - A plain build is unchanged (1 thread, identical to t1).
- **A2 depends on the thread count.**
  - Unlike B2, A2's per-word results differ between t1 and t4: 2.aac on the maintainer set, and one trust file in 3 places.
  - Each thread count is stable over 3 runs.
  - The earlier phone run `20261010-163757_A2_80ms` matches t4 here, not t1. Not investigated.

### Ayah-end gate (`scripts/ayah-end-gate.ts`, offline, on M1 logs; M2 gives byte-identical output)

The rules:
- R1 = voicing: stopped is either quiet below a running noise floor + D dB, or low clarity.
- R2 = CTC blank probability.
- R3 = both.

Gate-caused early means the gate fires before tilawa's own confirm (R0) **and** before the labelled end. R0 alone is already before the labelled end in 7 maintainer cases (baseline early), which are not charged to the gate. Default parameters: H 0.7, N 480 ms, U 240 ms, D 8 dB, C 0.5, R2 window 320 ms, B 0.95, P 0.2.

| Set | Rule | Ayah-end p50 / p95 / max (ms) | Gate-caused early (worst) | Verdict mismatches | Closest call |
|---|---|---|---|---|---|
| maintainer | R0 (tilawa) | 427 / 1878 / 5838 | — | — | — |
| maintainer | R1 | 373 / 1837 / 5838 | 0 | 1 (5.ogg 1:7 w9 shown `unsure`, last verdict `ok`) | +114 |
| maintainer | R2 | 328 / 927 / 987 | **4 (−494)** | 5 | −494 |
| maintainer | R3 | 414 / 1837 / 5838 | 0 | 1 | +114 |
| trust | R1 | −12 / 1473 / 1762 | 3 (−1375) | 2 | −1375 |
| trust | R2 | −75 / 886 / 1095 | 11 (−1375) | 7 | −1375 |

- **R2 fails everywhere.** No parameter row of 128 passes on either set. On 1:7 w9 it fires during the held vowel in 3 of 5 maintainer files. This matches the research: CTC is "peaky", so blank dominates during a held madd.
- **R1/R3: rows exist with 0 early and 0 mismatches on the maintainer set** (216 of 432 R1 rows), but the best of them leave ayah-end p95 at 1878 ms (p50 414). The same rows give 1-4 gate-caused early cases on the trust set.
- **Verdict:** none of these gates as designed delivers a safe gain. Why R1 helps so little (the eligibility condition, the "no new characters for N ms" condition, or the voicing test) is not diagnosed yet.
- **Limits:** 5 maintainer files with no deliberately long madd. The trust ayah-end labels sit after the breath, which inflates the trust early counts. The sweep overfits.

### Phase B: official Quran-Lab exports (desktop)

Files: the maintainer downloaded them from the gated Quran-Lab repo (NPL-1.2). They are kept in `public/models/` only: git-ignored and not in `assets.json`.

SHA-256:
- `zipformer_p_arabic_v3.int8.onnx` `6a5ddafa9c5e5c01260d30264031b341785bdc152e9ef1d569b41c8c278508eb`
- `zipformer_p_arabic_v3.onnx` (fp32) `65e5077932160ba9b5e4f418cf315d31dddf42210db4fea3113bf64359462cf2`
- `zipformer_p_arabic_v3.1.int8.onnx` `31755836528da336a6192121cd7bc82cb41752dddb65566fd000b89c8686da6b`
- `zipformer_p_arabic_v3.1_left128.int8.onnx` `9a27380054e814931216c2380d31b69a4ca6ea363e3ad65398dac3464f7111d4`
- `zipformer_p_arabic_v3.1_left64.int8.onnx` `d9422b243050bfce3ccb56f603e925be6926e66376aecdf4273ea3e1ce6788e7`

`inspect_model.py` results:
- All five have T 61 (chunk 24, 480 ms step) and no encoder-frames output.
- The int8 files are per-tensor QInt8, the same scheme as B2.
- Left context: 256, except the two probe builds (128, 64).
- Left context is baked into the cache shapes, so each file gets its own io manifest: `scripts/model/make_io.py`, loaded with `?io=`.

Checks:
- `make_io.py` reproduces the published a0w manifest exactly.
- B2 settings with the a0w model and io = an A2 run, per word.
- B2 with the c16 model and its generated io = the B2 baseline.

Runs:
- All `variant=B2` (correction mode + expected Fatiha), chunk 80 ms.
- 3 interleaved maintainer runs and 1 trust run per config at t1 and t4: 48 runs, `results/20261011-1516*` to `-1543*`.
- Every config's 3 maintainer runs are per-word identical.

| Lever | Config vs reference | Speed t4 (maintainer, 3 runs) | Speed t1 | Maintainer set | Trust set | Verdict |
|---|---|---|---|---|---|---|
| S3 | **V3** = official v3 int8, chunk 24 vs B2 (c16) | **faster**: 70-73 vs 89-93 model ms per audio s; RTF 0.075-0.078 vs 0.095-0.099 | no measurable difference: 125-170 vs 153-187, noisy | 145/145 tracked (B2 143); 1:6 w1 confirmed in 5/5 files (B2 3/5); ever wrong: 4.aac 1:6 w3 is **new** (B2's 3 words gone at t1, 1 left at t4); ayah-end p50/p95 574/2040 vs 427/1878; first lock p50 +320 ms | **all guards pass**: 232/232, 0 wrong, interior 317/958 vs 335/1064 | **faster, fails one strict guard** (ever-wrong not a subset: 1 transient word, never final `wrong`) |
| S2 | V3F = official v3 fp32 vs V3 | **slower**: model p50 38.7-39.0 vs 30.8-31.4 ms (+25 %) | no measurable difference | ≈ V3 (1-3 per-word differences) | identical to V3 | **slower, no accuracy gain** |
| S4 | V31 left 128 / left 64 vs V31 (left 256) | no measurable difference | no measurable difference | 139/145 and 142/145 tracked, 9-10 and 6 ever wrong | 228 and 221/232 tracked, **4 and 10 words flagged wrong in correct readings** | **no speed gain, fails accuracy** |
| model | V31 = v3.1 int8 vs V3 | no measurable difference | no measurable difference | 141/145; 1:6 w1 missed in 3.aac and 5.ogg; new ever-wrong 1:3 w1 in 1.aac/4.aac; ayah-end 648/2387 | 230/232, 2 words flagged wrong in correct readings (T5 1:3 w1, T7 1:6 w1) | **worse than v3 here** |

Notes:
- **(a) is two different exports** (halawanyAi c16 vs the official chunk-24 file). Both use the same quantization scheme, but the weights were not checked to be identical, so V3's tracking gain may come from the export rather than the chunk size.
- **V3's costs:**
  - The ayah-end confirm is later: p50 +147 ms, p95 +162 ms.
  - First lock is later by one step.
  - Both are within the one-step (480 ms) guard.
- **Threads:**
  - Like A2, V3, V31 and left128 give slightly different per-word results at t1 and t4 (2, 2 and 9 differences on the maintainer set).
  - V3F, left64 and B2 do not.
  - Every config gives the same results at t1 and t4 on the trust set.
- **Left-context probe:**
  - Correct readings get more `wrong` flags as the memory shrinks: 2, 4 and 10 words for left 256, 128 and 64.
  - On the maintainer recordings these data cannot say which flags are real mistakes.
- **Gate on V31 (t1):**
  - Default rows: gate-caused early cases on the trust set, and mismatches on both sets.
  - No sweep row passes on V31 trust.
  - Extra, on V3: R3 rows pass on each set separately, but the best rows differ between the sets. The best maintainer row gives p95 2040 → 1733; the best trust row has a margin of only +6 ms. This is no evidence of a safe single setting.
  - The R2 window and the sweep grid were picked for a 320 ms step.

### Not run yet
- **Phone (Redmi Note 8):** every speed verdict above is desktop only. The phone kit (exact URLs and baselines `20261010-175959` / `-180617`) is in the plan's Task 10.
- **Phase B on the phone:** V3 at the phone's thread count, on both sets (`?model=zipformer_p_arabic_v3.int8.onnx&io=zipformer_p_arabic_v3.int8.io.json`). This checks whether the desktop gain holds without SDOT.

### Recommendation (pending the maintainer's decision; no default was changed)
1. **S1:**
   - Fix the production thread hang with ORT's own `.mjs`/`.wasm` (already behind the flag).
   - Lift the production 1-thread rule only after the phone runs (P2 on both sets) pass the guards.
2. **Drop S2 (fp32).** The dequantized B2 and the official v3 fp32 are both slower on the desktop, with no accuracy gain. If anything, check it once on the phone, since the phone lacks the dot-product instructions.
3. **Do not switch to a0w (A1).** It is faster per second of audio, but it loses tracking on the maintainer set and depends on the thread count.
4. **V3 (official v3 int8, chunk 24) is the one open candidate.** It is about 22 % less model time per audio second at t4, tracks better, has a clean trust set and confirms 1:6 w1 everywhere.
   - It fails the strict "ever-wrong is a subset" guard by one transient word, and its ayah-end confirm is about 150 ms later.
   - Adopting it is the maintainer's call, after a phone run.
   - It would also need a license and hosting decision: the file is gated, and `assets.json` has no auth.
5. **Drop v3.1 and the shorter left contexts** on this evidence: no speed gain, and more false `wrong` flags on correct readings.
6. **Ayah-end:**
   - Keep `settleFrames` 25 and do not wire any gate.
   - Next step: find which condition holds R1 back, using the same logs. Also record a few readings with deliberately long madd before any further tuning.

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
2. ✅ Check on a mid-range phone (the success criterion covers laptop **and** phone; this run is a fast desktop — latency is CPU-independent, RTF is not). Done: see "Follow-up 2" (2026-10-10). Redmi Note 8: B2 RTF 1.21 single-thread (NO-GO), 0.85 with 2 WASM threads, 0.68 with 4; tracking and latency unchanged. Threads hang in the production build (Phase 6). Maintainer's decision: 4 threads by default on phones, provisional; desktop 1.
3. ✅ (diagnosed, not fixed) Investigate word 17 (1:6, word 1) never confirming (2/5) and the ayah-end p95. Done: see "Follow-up 3" (2026-10-10). 1:6 w1 is judged `wrong` at distance 0.429 against a 0.40 limit; the ayah-end delay is the `pending` wait, and `settleFrames` 12 cuts ayah-end p95 from 1878 to 1215 ms but confirms the last word early. Defaults unchanged; the choice is the maintainer's.
4. ✅ Live-test B2 once to confirm the feel. Include a deliberate 4-5 s pause once mid-ayah and once between ayahs. Done: see Live feel (2026-10-10).
5. ✅ Use 80 ms chunks in the live page. Done: the live page defaults to 80 ms and B2, selectable with `?chunk=80|150|300`; the chunk size is defined only in `src/audio.ts` and reaches the worklet via `processorOptions` (2026-10-10).
