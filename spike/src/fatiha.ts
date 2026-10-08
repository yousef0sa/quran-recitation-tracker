// Al-Fatiha word model: 7 ayahs (Kufan count, basmala = ayah 1), 29 words.
// Ayah numbers are 1-based, word indices within an ayah are 0-based.

export const AYAH_WORD_COUNTS = [4, 4, 2, 3, 4, 3, 9] as const;
const AYAH_COUNT =AYAH_WORD_COUNTS.length;
export const WORD_COUNT = 29;

/** Global index of the first word of each ayah: [0, 4, 8, 10, 13, 17, 20]. */
export const AYAH_OFFSETS: readonly number[] = (() => {
  const offsets: number[] = [];
  let sum = 0;
  for (const count of AYAH_WORD_COUNTS) {
    offsets.push(sum);
    sum += count;
  }
  return offsets;
})();

function ayahInfo(ayah: number): { count: number; offset: number } {
  const count = Number.isInteger(ayah) ? AYAH_WORD_COUNTS[ayah - 1] : undefined;
  const offset = Number.isInteger(ayah) ? AYAH_OFFSETS[ayah - 1] : undefined;
  if (count === undefined || offset === undefined) {
    throw new RangeError(`Al-Fatiha ayah out of range 1..${AYAH_COUNT}: ${ayah}`);
  }
  return { count, offset };
}

/** (ayah 1..7, word 0..count-1) -> global word index 0..28. Throws when out of range. */
export function toGlobalWordIndex(ayah: number, wordIndex: number): number {
  const { count, offset } = ayahInfo(ayah);
  if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex >= count) {
    throw new RangeError(`word ${wordIndex} out of range 0..${count - 1} for ayah ${ayah}`);
  }
  return offset + wordIndex;
}

/**
 * Tracker cursor -> global word index. Unlike toGlobalWordIndex this also accepts
 * wordIndex === count (cursor just past the last word of the ayah): that is the
 * first word of the next ayah, or 29 after ayah 7.
 * (tilawa's own cursor is wordInAyah, always < count, so this is a safety net.)
 */
export function cursorToGlobal(ayah: number, wordIndex: number): number {
  const { count, offset } = ayahInfo(ayah);
  if (!Number.isInteger(wordIndex) || wordIndex < 0 || wordIndex > count) {
    throw new RangeError(`cursor ${wordIndex} out of range 0..${count} for ayah ${ayah}`);
  }
  return offset + wordIndex;
}

/** toGlobalWordIndex that returns null instead of throwing. */
export function tryToGlobalWordIndex(ayah: number, wordIndex: number): number | null {
  try {
    return toGlobalWordIndex(ayah, wordIndex);
  } catch {
    return null;
  }
}

/** cursorToGlobal that returns null instead of throwing. */
export function tryCursorToGlobal(ayah: number, wordIndex: number): number | null {
  try {
    return cursorToGlobal(ayah, wordIndex);
  } catch {
    return null;
  }
}

export function fromGlobalWordIndex(global: number): { ayah: number; word: number } {
  if (!Number.isInteger(global) || global < 0 || global >= WORD_COUNT) {
    throw new RangeError(`global word index out of range 0..${WORD_COUNT - 1}: ${global}`);
  }
  for (let i = AYAH_COUNT - 1; i >= 0; i--) {
    const offset = AYAH_OFFSETS[i] as number;
    if (global >= offset) return { ayah: i + 1, word: global - offset };
  }
  throw new RangeError(`global word index out of range: ${global}`);
}

interface CorpusAyah {
  w: unknown;
}

/**
 * The 29 plain-Uthmani words of Al-Fatiha from zipformer_quran.json (v=2):
 * surahs[0].ayahs[i].w[j] = [mushafGlyphs, phonemes, plainUthmani].
 * Throws if the shape or the per-ayah word counts do not match AYAH_WORD_COUNTS.
 * Plain Uthmani text from the corpus; a KFGQPC source may replace it later.
 */
export function loadFatihaDisplayWords(corpusJson: unknown): string[] {
  const surahs = (corpusJson as { surahs?: unknown } | null)?.surahs;
  const fatiha = Array.isArray(surahs) ? (surahs[0] as { ayahs?: unknown } | undefined) : undefined;
  const ayahs = fatiha?.ayahs;
  if (!Array.isArray(ayahs) || ayahs.length !== AYAH_COUNT) {
    throw new Error(`corpus: surahs[0].ayahs must have ${AYAH_COUNT} entries`);
  }
  const words: string[] = [];
  (ayahs as CorpusAyah[]).forEach((ayah, i) => {
    const triples = ayah?.w;
    const expected = AYAH_WORD_COUNTS[i];
    if (!Array.isArray(triples) || triples.length !== expected) {
      throw new Error(
        `corpus: Al-Fatiha ayah ${i + 1} has ${Array.isArray(triples) ? triples.length : "no"} words, expected ${expected}`,
      );
    }
    for (const triple of triples) {
      const text = Array.isArray(triple) ? triple[2] : undefined;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error(`corpus: Al-Fatiha ayah ${i + 1} has a word without plain Uthmani text`);
      }
      words.push(text);
    }
  });
  return words;
}
