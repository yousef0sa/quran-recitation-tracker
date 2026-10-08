// Dev-only bench additions: use spike/recordings without file pickers, and URL autorun
// (bench.html?autorun=1&variant=A1&chunk=150). Loaded via a dynamic import behind
// `import.meta.env.DEV` in bench.ts.
import { errorMessage } from "../common";
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
  toResultsJson(result: R): { variant: string; chunkMs: number };
  toLogsJson(result: R): unknown;
  toSummaryJson(result: R): Record<string, unknown>;
  didFail(result: R): boolean;
}

export function initBenchDev<R>(host: BenchDevHost<R>): void {
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
    const all = await listRecordings();
    const labelled = all.filter((r) => r.hasLabels);
    const recordings = await Promise.all(labelled.map((r) => fetchRecordingFile(r.name)));
    const labels = await Promise.all(labelled.map((r) => fetchLabelsFile(r.base)));
    host.select(recordings, labels);
    const skipped = all.length - labelled.length;
    host.setStatus(
      labelled.length > 0
        ? `تم اختيار ${labelled.length} تسجيل له تعليم من spike/recordings${skipped > 0 ? ` (تم تجاهل ${skipped} بلا تعليم)` : ""}.`
        : "لا توجد تسجيلات لها تعليم في spike/recordings.",
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

  const params = new URLSearchParams(location.search);
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
          throw new Error(`unsupported chunk "${chunk}" (use 80, 150 or 300)`);
        }
        host.chunkSelect.value = chunk;
      }

      const count = await useDevRecordings();
      if (count === 0) {
        finish("error", { error: "no labelled recordings in spike/recordings (a recording needs <base>.labels.json)" });
        return;
      }

      const result = await host.run();
      if (result === null) {
        finish("error", { error: "nothing to run (no recordings selected)" });
        return;
      }
      const failed = host.didFail(result);
      const results = host.toResultsJson(result);
      const now = new Date();
      const saved: string[] = [];
      let saveError: string | null = null;
      try {
        saved.push(await postResult(resultFileName(now, results.variant, results.chunkMs, "results"), results));
        saved.push(
          await postResult(resultFileName(now, results.variant, results.chunkMs, "eventlogs"), host.toLogsJson(result)),
        );
      } catch (err) {
        saveError = errorMessage(err);
        console.error("[spike] could not save results", saveError);
      }
      const payload = host.toSummaryJson(result);
      finish(failed || saveError !== null ? "error" : "1", { ...payload, savedTo: saved, saveError });
    } catch (err) {
      const message = errorMessage(err);
      console.error("[spike] autorun failed", message);
      finish("error", { error: message });
    }
  })();
}
