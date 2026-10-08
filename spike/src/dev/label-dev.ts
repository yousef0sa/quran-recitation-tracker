// Dev-only labeler additions: a recordings dropdown and "save to folder". Loaded via a dynamic
// import behind `import.meta.env.DEV` in label.ts.
import { baseName, errorMessage } from "../common";
import type { Labels } from "../labels";
import type { RecordingInfo } from "../../scripts/dev-harness";
import { fetchRecordingFile, listRecordings, postLabels } from "./dev-api";

export interface LabelDevHost {
  controls: HTMLElement;
  loadFile(file: File): void;
  buildLabels(): Labels;
  getRecordingName(): string | null;
  setStatus(text: string, isError?: boolean): void;
}

export function initLabelDev(host: LabelDevHost): void {
  const select = document.createElement("select");
  select.id = "dev-recordings";
  select.title = "تسجيلات spike/recordings";
  const saveButton = document.createElement("button");
  saveButton.id = "dev-save";
  saveButton.textContent = "حفظ في المجلد";
  saveButton.disabled = true;
  host.controls.append(select, saveButton);

  let recordings: RecordingInfo[] = [];

  async function refreshList(selected?: string): Promise<void> {
    try {
      recordings = await listRecordings();
    } catch (err) {
      host.setStatus(`تعذر قراءة spike/recordings: ${errorMessage(err)}`, true);
      recordings = [];
    }
    select.replaceChildren();
    const head = document.createElement("option");
    head.value = "";
    head.textContent = recordings.length ? "تسجيلات spike/recordings" : "spike/recordings فارغ";
    select.append(head);
    for (const recording of recordings) {
      const option = document.createElement("option");
      option.value = recording.name;
      option.textContent = `${recording.hasLabels ? "✓ " : ""}${recording.name}${recording.hasLabels ? " (له تعليم)" : ""}`;
      select.append(option);
    }
    select.value = selected ?? "";
  }

  let loadRequest = 0; // a stale recording fetch must not load over a newer selection
  select.addEventListener("change", () => {
    const name = select.value;
    if (!name) return;
    const request = ++loadRequest;
    host.setStatus(`جارٍ تحميل ${name}…`);
    fetchRecordingFile(name)
      .then((file) => {
        if (request !== loadRequest) return;
        host.loadFile(file);
        saveButton.disabled = false;
      })
      .catch((err: unknown) => {
        if (request !== loadRequest) return;
        console.error("[spike] dev recording load failed", err);
        host.setStatus(`تعذر تحميل ${name}: ${errorMessage(err)}`, true);
      });
    select.blur();
  });

  saveButton.addEventListener("click", () => {
    const recording = host.getRecordingName();
    if (recording === null) return;
    const base = baseName(recording);
    void (async () => {
      try {
        const labels = host.buildLabels();
        const outcome = await postLabels(base, labels, false);
        if (outcome === "exists") {
          if (!confirm(`الملف ${base}.labels.json موجود في spike/recordings. هل تريد استبداله؟`)) {
            host.setStatus("لم يُحفظ: الملف موجود.");
            return;
          }
          await postLabels(base, labels, true);
        }
        host.setStatus(`تم الحفظ في spike/recordings/${base}.labels.json`);
        await refreshList(select.value);
      } catch (err) {
        console.error("[spike] dev save failed", err);
        host.setStatus(errorMessage(err), true);
      }
    })();
    saveButton.blur();
  });

  void refreshList();
}
