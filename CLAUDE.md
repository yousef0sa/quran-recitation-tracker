# CLAUDE.md

Free, open-source Quran recitation tracker that runs fully in the browser, on the user's device. MVP: Al-Fatiha.
- Why and scope: `.claude/PRPs/prds/quran-recitation-tracker.prd.md`
- Current code is only `spike/`, a measured feasibility spike. Outcome and next steps: `spike/RESULTS.md`
- How the spike works: `spike/README.md` and the header comment at the top of each source file in `spike/src/`

## Rules

- IMPORTANT: Never type Quranic text, in any file or command. Refer to words by position (e.g. "1:6 word 1"); display text is loaded at runtime from the corpus. The `quran-guard` hook enforces this: if it blocks you, rephrase by position, never work around it.
- Never write religious rulings or wording about prayer validity; the app only points out where a reading may be wrong. Keep the "may be wrong, not a substitute for a teacher" notice.
- Audio and user data never leave the device: no servers, accounts, analytics, or network calls with user data. Never run `npx e2e feedback` or anything else that sends data out.
- Run the dev server on loopback only (no bare `--host`, no LAN address): its dev-only `/__dev/` endpoints serve personal recordings and write files.
- Never commit audio, models, the corpus, `spike/recordings/` or `spike/results/` (privacy, and the NPL-1.2 licence: `spike/NOTICE.md`).
- Two test sets, reported separately: the owner's own recordings in `spike/recordings/` (all latency and accuracy numbers), and the trust set in `spike/recordings/trust/` (known reciters, only to count false alarms on correct readings).

## Commands (run in `spike/`)

```bash
npm run fetch-assets   # once: model + corpus (git-ignored); model-dependent tests skip without them
npm run dev
npm run typecheck      # src and tests
npm test               # vitest; one file: npx vitest run src/metrics.test.ts
npm run test:e2e       # browser tests; one: npx e2e run tests/live.e2e.ts --grep "missing model"
```

## Gotcha

- The audio chunk size is defined only in `src/audio.ts` (`CHUNK_MS_OPTIONS`, `DEFAULT_CHUNK_MS`); the live page reads `?chunk=` and the worklet gets its size through `processorOptions`, so there is nothing to keep in sync. Do not add a size constant to `public/audio-processor.js`.
