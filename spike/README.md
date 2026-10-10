# Browser spike: live Al-Fatiha tracking / تجربة تتبع الفاتحة

This spike measures whether the Quran-Lab zipformer model (through `@tilawa/core`, ONNX Runtime Web, WASM single thread) can follow a recitation of Al-Fatiha word by word inside the browser, fast enough. It has three pages:

| Page | Purpose |
|---|---|
| `index.html` (live) | Mic in, words highlight as you recite, on-screen stats |
| `label.html` | Mark the end of each of the 29 words in one of your recordings (ground truth) |
| `bench.html` | Feed your labelled recordings to the model and compute latency and accuracy |

الغرض: قياس هل يتتبع النموذج تلاوة الفاتحة كلمةً كلمة داخل المتصفح بسرعة كافية. ثلاث صفحات: مباشر، تعليم نهايات الكلمات، وقياس على تسجيلاتك.

Audio never leaves your device. See `NOTICE.md` for licences and the disclaimer.

## 1. Run / التشغيل

```bash
cd spike
npm install
npm run fetch-assets   # downloads the NPL-1.2 model + corpus (about 150 MB), verifies SHA-256; second run downloads nothing
npm run dev            # http://localhost:5173/
```

- Live: `http://localhost:5173/index.html` (choose the variant with `?variant=A1|A2|B1|B2`, default B2; the audio chunk size with `?chunk=80|150|300`, default 80 ms; the stats line shows both)
- Labeler: `http://localhost:5173/label.html`
- Bench: `http://localhost:5173/bench.html`

Other commands: `npm run typecheck`, `npm test`, `npm run build`.

Never run the dev server with `--host` (or set `server.host`): the dev-only `/__dev/` harness serves your recordings and writes label and result files, so it refuses to start on a non-loopback host.

بعد `npm install` شغّل `npm run fetch-assets` (مرة واحدة)، ثم `npm run dev` وافتح الروابط أعلاه. إن ظهرت رسالة «شغّل الأمر npm run fetch-assets» فالنموذج غير منزَّل بعد.

## 2. Variants / النسخ

| Id | What |
|---|---|
| A1 | tilawa default model (a0w), tracking mode. |
| A2 | same model, correction mode with the expected passage set to Al-Fatiha; any correction issue is logged and auto-closed so feeding continues |
| B1 | raw Quran-Lab v3 export, 320 ms hop (stretch: if it fails to load the error is shown and A1/A2 are unaffected) |
| B2 | same model and io override as B1, with A2's correction mode and expected passage Al-Fatiha (stretch). **Default** (best result in `RESULTS.md`) |

## 3. Record / التسجيل

Record at least 5 correct readings of Al-Fatiha yourself (no recordings are included or generated): vary the device (laptop and phone mic), the room (quiet and some noise) and the pace (slow and normal), and include one with a stop in the middle of an ayah and a restart. Put them in `spike/recordings/` (git-ignored). Any format the browser can decode (wav, mp3, m4a, webm, ogg).

سجّل خمس قراءات صحيحة على الأقل بصوتك (لا تُنشأ تسجيلات تلقائياً)، مع تنويع الجهاز والمكان والسرعة، ومع قراءة واحدة فيها توقف في منتصف آية ثم إعادة. ضعها في `spike/recordings/`.

## 4. Label at 0.5x / التعليم

1. Open `label.html`, choose a recording, keep the rate at **0.5x**, press play.
2. Press **Space** at the end of each word. **Backspace** undoes the last mark. The highlighted word is the one you are marking.
3. After the 29th mark, click download. The file is named `<recording name>.labels.json` and is validated before saving (29 strictly increasing times).
4. Put the label files next to the recordings.

Tap reaction adds roughly 100-250 ms of bias. Label at 0.5x to keep it small; the bias is the same for every variant, so comparisons stay fair. Absolute latency numbers include it.

اضغط المسافة عند نهاية كل كلمة (Backspace للتراجع) على سرعة 0.5×. اسم الملف الناتج `<اسم التسجيل>.labels.json`. يضيف الضغط تأخراً بشرياً نحو 100–250 ms، وهو نفسه لكل النسخ.

## 5. Bench and read the results / القياس وقراءة النتائج

1. Open `bench.html`, select the recordings and their label files (a label file matches a recording when its `recording` field equals the file name, or its file name is `<recording base name>.labels.json`).
2. Choose the variant and the chunk size (80 / 150 / 300 ms, default 80; the same list and default as the live page, defined in `src/audio.ts`), click Run. Files run one after another on a fresh model session for the run; the session is reset between files.
3. Each file is fed in fixed chunks back-to-back, then **2.0 s of zeros** as ordinary chunks, then `stop()`. The last word's confirmation is read from the final "flush entry, after +2 s tail inside stop()". The padding counts toward audio duration and RTF.
4. Download `results.json` (metrics, variant, chunk size, user agent, core count, backend "WASM single-thread") and, if wanted, the EventLogs.

Results are deterministic: the same file, variant and chunk size give identical latency numbers (compute times vary run to run).

Engine override and verdict log:

- `bench.html?settle=<1..200>` overrides tilawa's `settleFrames` (default 25 frames = 1 s at 25 Hz; the engine decodes 8 frames per 320 ms step, so it acts in whole steps). It is read from the URL only (no control on the page, not on the live page); an invalid value falls back to the default and is noted in the run, and the dev autorun (`?autorun=1&variant=B2&chunk=80&settle=12`) rejects it with an error. The value actually applied is recorded as `engineConfig` in the results and EventLog JSON (`{}` = defaults) and shown in the page header; dev autorun result files get a `_settle<n>` part (`<time>_B2_80ms_settle12_results.json`).
- Each EventLog entry may carry `verdicts`: the full Al-Fatiha tilawa verdict list (`w` global word index 0-28, `s` state `ok|unsure|wrong|skipped|pending`, `d` distance, `h` heard ratio, `m` margin), written only when it differs from the previous entry's. An empty list means tilawa went back to search. The final entry (`flush`) always has one. Older logs have no `verdicts`.
- `node scripts/verdict-report.ts <results.json> <eventlogs.json> [--word 1:6:1 ...]` (Node 22.18+ or newer, which strips types by default) prints the per-word confirm table, ayah-end / interior latency, every word whose verdict was ever `wrong` or `skipped` (with all-correct recordings these are false alarms), and a timeline of the verdicts, cursor and verse events for each `--word <surah>:<ayah>:<word in ayah, 1-based>`. It prints positions and numbers only, never text.

What the columns mean:

- **confirm ms**: **the project's latency metric** (decided 2026-10-08): time from the labelled word end until the word first shows as matched (turns green), either in `word_progress.matched_indices` or in the verdict snapshot taken after each chunk. These two sources have different settling rules, so the earlier of them is used. This is the only way to see ayah-final words once the cursor has moved on.
- **cursor ms**: time from the labelled word end until the tracker cursor first moves past that word. Expected to be the earliest signal, but measured about 2x later than confirm, so it is kept for comparison only. Word 29 has none (no next word).
- **tracked**: words ever confirmed out of 29. **missed words**: numbers (1-29) never confirmed.
- **false adv.**: words the cursor passed before the word started (labelled start, or the previous word's end if no starts).
- **restarts**: backward cursor moves. **lock s**: audio time of the first Al-Fatiha `word_progress`.
- **compute**: time of each `feed()` call only. **RTF** = total compute / total audio duration (padding included). **RTF+verdicts** adds the time of the verdict snapshot.

Always read numbers together with the browser, device, backend (WASM single-thread) and chunk size; compare only within one setup.

الأرقام تُقارَن فقط داخل نفس المتصفح والجهاز والخلفية وحجم القطعة. انسخ النتائج إلى `RESULTS.md`.

## 6. Decision / القرار

See `RESULTS.md`.

## Layout

- `src/fatiha.ts` word table and mappings; `src/metrics.ts` latency/accuracy; `src/labels.ts` label format; `src/resample.ts` + `public/audio-processor.js` 16 kHz resampling (keep in sync); `src/tracker.worker.ts` model session; `src/tracker-client.ts`, `src/progress.ts`, `src/common.ts` page helpers.
- `src/engine-config.ts` bench-only tilawa override (`?settle=`); `scripts/verdict-report.ts` offline report on a results + EventLog pair.
- `scripts/assets.json` is the only place with asset URLs and hashes; `src/variants.ts` is the only place with variant settings.
- Display text is tilawa's plain Uthmani, temporary until the KFGQPC text is integrated.
