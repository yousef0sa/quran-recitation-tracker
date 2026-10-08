// Small helpers shared by the three pages.
import { AYAH_OFFSETS, AYAH_WORD_COUNTS, loadFatihaDisplayWords } from "./fatiha";
import { CORPUS_PATH, VARIANT_IDS, VARIANTS, parseVariantId, type VariantId } from "./variants";

export const BACKEND_LABEL = "WASM single-thread";
const FETCH_HINT_AR = "شغّل الأمر npm run fetch-assets داخل مجلد spike ثم أعد تحميل الصفحة";

export function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A status-line setter: sets the text and toggles the "error" class. */
export function makeStatus(line: HTMLElement): (text: string, isError?: boolean) => void {
  return (text, isError = false) => {
    line.textContent = text;
    line.classList.toggle("error", isError);
  };
}

/**
 * Fills `box` with the 29 words grouped by ayah (ayah / word / ayah-marker spans) and returns the
 * word nodes in order. Without `words` (corpus missing) the nodes show their 1-based number.
 */
export function renderWords(box: HTMLElement, words: readonly string[] | null): HTMLSpanElement[] {
  box.replaceChildren();
  const nodes: HTMLSpanElement[] = [];
  AYAH_WORD_COUNTS.forEach((count, ayahIndex) => {
    const line = document.createElement("span");
    line.className = "ayah";
    const offset = AYAH_OFFSETS[ayahIndex] as number;
    for (let i = 0; i < count; i++) {
      const node = document.createElement("span");
      node.className = "word";
      node.textContent = words ? (words[offset + i] as string) : String(offset + i + 1);
      nodes.push(node);
      line.append(node, " ");
    }
    const marker = document.createElement("span");
    marker.className = "ayah-marker";
    marker.textContent = String(ayahIndex + 1);
    line.append(marker);
    box.append(line);
  });
  return nodes;
}

/** Labels the variant options and selects the one named by `?variant=` (default A1); returns it. */
export function initVariantSelect(select: HTMLSelectElement): VariantId {
  for (const id of VARIANT_IDS) {
    const option = [...select.options].find((o) => o.value === id);
    if (option) option.textContent = VARIANTS[id].label;
  }
  const variant = parseVariantId(new URLSearchParams(location.search).get("variant"));
  select.value = variant;
  return variant;
}

export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function formatMs(value: number | null | undefined, digits = 0): string {
  return value === null || value === undefined || Number.isNaN(value) ? "-" : value.toFixed(digits);
}

/** "file.name.wav" -> "file.name" */
export function baseName(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * The 29 display words from the (gitignored) corpus, fetched on the main thread.
 * Throws an Error whose message is Arabic status text when the corpus is missing.
 */
export async function fetchDisplayWords(): Promise<string[]> {
  const url = `${import.meta.env.BASE_URL}${CORPUS_PATH}`;
  const res = await fetch(url);
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || type.includes("text/html")) {
    throw new Error(`ملف القاموس غير موجود (${url}). ${FETCH_HINT_AR}`);
  }
  return loadFatihaDisplayWords(await res.json());
}
