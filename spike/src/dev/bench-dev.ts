// Dev-only bench additions: use spike/recordings without file pickers, and URL autorun
// (bench.html?autorun=1&variant=A1&chunk=150, plus &settle=12 to override tilawa's settleFrames).
// `&dir=trust` (also for the button) uses the recordings in spike/recordings/trust/ instead of the top level;
// the name rule is RECORDINGS_DIR_PATTERN, the same one the dev server enforces. Result files then get a
// `_<dir>` part and the results/summary JSON a `recordingsDir` field (null for the top level).
// Loaded via a dynamic import behind `import.meta.env.DEV` in bench.ts.
import { CHUNK_MS_OPTIONS } from "../audio";
import { errorMessage } from "../common";
import { SETTLE_FRAMES_MAX, SETTLE_FRAMES_MIN, engineConfigSuffix, parseSettleFrames, type EngineOverride } from "../engine-config";
import { isValidRecordingsDir, RECORDINGS_DIR_PATTERN } from "./recordings-dir";
import { fetchLabelsFile, fetchRecordingFile, listRecordings, postResult, resultFileName } from "./dev-api";
import { isVariantId } from "../variants";

export interface BenchDevHost<R> {
  controls: HTMLElement;
  variantSelect: HTMLSelectElement;
  chunkSelect: HTMLSelectElement;
  setStatus(text: string, isError?: boolean): void;
  select(recordings: File[], labels: File[]): void;
  /** Null when nothing was selected to run. */
  run(): Promise<R | null>;
  toResultsJson(result: R): { variant: string; chunkMs: number; engineConfig: EngineOverride };
  toLogsJson(result: R): unknown;
  toSummaryJson(result: R): Record<string, unknown>;
  didFail(result: R): boolean;
}

export function initBenchDev<R>(host: BenchDevHost<R>): void {
  const params = new URLSearchParams(location.search);

  /** The page's `?dir=` (null = top level). Throws on a name the dev server would refuse. */
  function recordingsDirParam(): string | null {
    const dir = params.get("dir");
    if (dir !== null && !isValidRecordingsDir(dir)) {
      throw new Error(`unsupported dir "${dir}" (one folder name matching ${RECORDINGS_DIR_PATTERN})`);
    }
    return dir;
  }

  const useButton = document.createElement("button");
  useButton.id = "dev-use-recordings";
  useButton.textContent = "استخدم spike/recordings";
  host.controls.append(useButton);

  const summary = document.createElement("pre");
  summary.id = "bench-summary";
  summary.className = "log";
  summary.hidden = true;
  document.querySelector("main")?.append(summary);

  /** Loads every recording that has labels. Returns how many were selected. */
  async function useDevRecordings(): Promise<number> {
    const dir = recordingsDirParam() ?? undefined;
    const where = dir === undefined ? "spike/recordings" : `spike/recordings/${dir}`;
    const all = await listRecordings(dir);
    const labelled = all.filter((r) => r.hasLabels);
    const recordings = await Promise.all(labelled.map((r) => fetchRecordingFile(r.name, dir)));
    const labels = await Promise.all(labelled.map((r) => fetchLabelsFile(r.base, dir)));
    host.select(recordings, labels);
    const skipped = all.length - labelled.length;
    host.setStatus(
      labelled.length > 0
        ? `تم اختيار ${labelled.length} تسجيل له تعليم من ${where}${skipped > 0 ? ` (تم تجاهل ${skipped} بلا تعليم)` : ""}.`
        : `لا توجد تسجيلات لها تعليم في ${where}.`,
      labelled.length === 0,
    );
    return labelled.length;
  }

  useButton.addEventListener("click", () => {
    useButton.disabled = true;
    useDevRecordings()
      .catch((err: unknown) => {
        console.error("[spike] dev recordings failed", err);
        host.setStatus(errorMessage(err), true);
      })
      .finally(() => {
        useButton.disabled = false;
      });
  });

  function finish(state: "1" | "error", payload: unknown): void {
    summary.hidden = false;
    summary.textContent = JSON.stringify(payload, null, 2);
    document.body.dataset.benchDone = state;
  }

  if (params.get("autorun") !== "1") return;

  void (async () => {
    try {
      const variant = params.get("variant");
      if (variant !== null) {
        if (!isVariantId(variant)) throw new Error(`unknown variant "${variant}"`);
        host.variantSelect.value = variant;
      }
      const chunk = params.get("chunk");
      if (chunk !== null) {
        if (![...host.chunkSelect.options].some((o) => o.value === chunk)) {
          throw new Error(`unsupported chunk "${chunk}" (use ${CHUNK_MS_OPTIONS.join(", ")})`);
        }
        host.chunkSelect.value = chunk;
      }
      // bench.ts reads ?settle= itself; here a bad value is an error instead of a silent fallback.
      const settle = params.get("settle");
      if (settle !== null && parseSettleFrames(settle) === null) {
        throw new Error(`unsupported settle "${settle}" (integer ${SETTLE_FRAMES_MIN}-${SETTLE_FRAMES_MAX})`);
      }
      const dir = recordingsDirParam();

      const count = await useDevRecordings();
      if (count === 0) {
        finish("error", {
          error: `no labelled recordings in spike/recordings${dir === null ? "" : `/${dir}`} (a recording needs <base>.labels.json)`,
        });
        return;
      }

      const result = await host.run();
      if (result === null) {
        finish("error", { error: "nothing to run (no recordings selected)" });
        return;
      }
      const failed = host.didFail(result);
      const results = { ...host.toResultsJson(result), recordingsDir: dir };
      const now = new Date();
      const saved: string[] = [];
      let saveError: string | null = null;
      try {
        const suffix = engineConfigSuffix(results.engineConfig);
        saved.push(await postResult(resultFileName(now, results.variant, results.chunkMs, "results", suffix, dir), results));
        saved.push(
          await postResult(
            resultFileName(now, results.variant, results.chunkMs, "eventlogs", suffix, dir),
            host.toLogsJson(result),
          ),
        );
      } catch (err) {
        saveError = errorMessage(err);
        console.error("[spike] could not save results", saveError);
      }
      const payload = host.toSummaryJson(result);
      finish(failed || saveError !== null ? "error" : "1", { ...payload, recordingsDir: dir, savedTo: saved, saveError });
    } catch (err) {
      const message = errorMessage(err);
      console.error("[spike] autorun failed", message);
      finish("error", { error: message });
    }
  })();
}
