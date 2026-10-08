// Ground-truth labels for one recording (seconds on the recording's own timeline).
import { WORD_COUNT } from "./fatiha";

export interface Labels {
  recording: string;
  /** End time of each of the 29 words, strictly increasing. */
  wordEnds: number[];
  /** Optional start time of each word (each must be before its end). */
  wordStarts?: number[];
  notes?: string;
}

function bad(en: string, ar: string): never {
  throw new Error(`${ar} / ${en}`);
}

function timeArray(value: unknown, field: string, fieldAr: string): number[] {
  if (!Array.isArray(value) || value.length !== WORD_COUNT) {
    bad(
      `${field} must have exactly ${WORD_COUNT} times (got ${Array.isArray(value) ? value.length : typeof value})`,
      `${fieldAr} يجب أن تحتوي ${WORD_COUNT} زمنًا بالضبط`,
    );
  }
  (value as unknown[]).forEach((t, i) => {
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      bad(`${field}[${i}] is not a finite time >= 0 (${String(t)})`, `${fieldAr}[${i}] ليس زمنًا صالحًا`);
    }
  });
  return value as number[];
}

/** Parse and validate a labels JSON object (already JSON.parse'd). */
export function parseLabels(json: unknown): Labels {
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    bad("labels must be a JSON object", "ملف التعليم يجب أن يكون كائن JSON");
  }
  const obj = json as Record<string, unknown>;
  if (typeof obj.recording !== "string" || obj.recording.length === 0) {
    bad("recording must be a non-empty string", "اسم التسجيل مفقود");
  }
  const wordEnds = timeArray(obj.wordEnds, "wordEnds", "نهايات الكلمات");
  for (let i = 1; i < wordEnds.length; i++) {
    if ((wordEnds[i] as number) <= (wordEnds[i - 1] as number)) {
      bad(
        `wordEnds must be strictly increasing (index ${i}: ${wordEnds[i]} <= ${wordEnds[i - 1]})`,
        `نهايات الكلمات يجب أن تتزايد بصرامة (الموضع ${i})`,
      );
    }
  }
  const labels: Labels = { recording: obj.recording, wordEnds };
  if (obj.wordStarts !== undefined) {
    const wordStarts = timeArray(obj.wordStarts, "wordStarts", "بدايات الكلمات");
    wordStarts.forEach((start, i) => {
      if (start >= (wordEnds[i] as number)) {
        bad(
          `wordStarts[${i}] (${start}) must be before wordEnds[${i}] (${wordEnds[i]})`,
          `بداية الكلمة ${i} يجب أن تسبق نهايتها`,
        );
      }
    });
    labels.wordStarts = wordStarts;
  }
  if (obj.notes !== undefined) {
    if (typeof obj.notes !== "string") bad("notes must be a string", "الملاحظات يجب أن تكون نصًا");
    labels.notes = obj.notes;
  }
  return labels;
}
