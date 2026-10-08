# Notice / إشعار

## Licence boundaries / حدود التراخيص

- **Code in this folder (`spike/src`, `spike/scripts`, pages, `public/audio-processor.js`)**: MIT.
- **`@tilawa/core`** (npm dependency, MIT code) is installed from npm and is not copied into this repository.
- **The speech model and everything derived from it are NPL-1.2** (Quran-Lab No-Profit License) and are **not committed to git**:
  - `zipformer_a0w_ep1_a05.int8.onnx` and its `.io.json` (tilawa release `zipformer-a0w-ep1-a0.5`; a blend of Quran-Lab `zipformer_p-arabic-v3` with tilawa's fine-tune).
  - `zipformer_p_arabic_v3_c16.int8.onnx` (unmodified weights of Quran-Lab `zipformer_p-arabic-v3`, ungated mirror `halawanyAi/natlu-zipformer-p-arabic-v3-c16`, pinned commit `df8ec413aea3e0ec0e69fc816889f0dbf4aa91a3`).
  - `zipformer_quran.json`, the phoneme corpus derived from Quran-Lab's `quran_text2phoneme.json` (tilawa release `v0.3.0`).
- `npm run fetch-assets` downloads these files into `spike/public/models/` and `spike/public/data/` (both git-ignored), verifies their size and SHA-256 (values in `scripts/assets.json`), and puts each source's licence files next to them (`tilawa-NOTICE.md`, `tilawa-LICENSE`, `natlu-zipformer-p-arabic-v3-c16-LICENSE`).
- NPL-1.2 terms to keep in mind: no charging for the work or for any feature it powers; derivatives are shared under the same licence. Read the licence files that the fetch script places next to the assets.
- `npm run build` copies `public/` into `dist/`, so `dist/` then contains the NPL files. `dist/` is git-ignored; do not publish or commit it without the licence files that sit next to the assets.

## Privacy / الخصوصية

Audio is processed only inside the browser on your device. Nothing is uploaded: no server calls with audio, no accounts, no analytics, no ads. Recordings and labels you pick in the bench or labeler stay in the browser tab. `spike/recordings/` and `spike/results/` are git-ignored.

## Disclaimer / تنبيه

قد يخطئ التطبيق، ولا يغني أبداً عن الشيخ.

The app may be wrong and is not a substitute for a qualified teacher.
