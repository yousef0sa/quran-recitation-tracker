// What the spike compares. Variant config lives only here; asset URLs/hashes only in scripts/assets.json.
import type { ZipformerIo } from "@tilawa/core";

export type VariantId = "A1" | "A2" | "B1" | "B2";
export const VARIANT_IDS: readonly VariantId[] = ["A1", "A2", "B1", "B2"];
export const DEFAULT_VARIANT: VariantId = "A1";

/** Override of tilawa's bundled I/O manifest (only what differs for the c16 export). */
export interface IoOverride {
  T: number;
  hop: number;
  /** log_probs frames per step (T=45/hop=32 gives 8 frames at 25 Hz). */
  logProbsFrames: number;
}

export interface Variant {
  id: VariantId;
  label: string;
  /** Path under the site root (public/), e.g. "models/x.onnx". Must be listed in scripts/assets.json. */
  modelPath: string;
  io: IoOverride | null;
  mode: "tracking" | "correction";
  expected: { surah: number; ayah: number; ayahEnd: number } | null;
  /** Stretch variants may fail to load; the failure is recorded, nothing else depends on them. */
  stretch: boolean;
}

export const CORPUS_PATH = "data/zipformer_quran.json";

export const VARIANTS: Readonly<Record<VariantId, Variant>> = {
  A1: {
    id: "A1",
    label: "A1: a0w, tracking",
    modelPath: "models/zipformer_a0w_ep1_a05.int8.onnx",
    io: null,
    mode: "tracking",
    expected: null,
    stretch: false,
  },
  A2: {
    id: "A2",
    label: "A2: a0w, correction + expected Fatiha",
    modelPath: "models/zipformer_a0w_ep1_a05.int8.onnx",
    io: null,
    mode: "correction",
    expected: { surah: 1, ayah: 1, ayahEnd: 7 },
    stretch: false,
  },
  B1: {
    id: "B1",
    label: "B1: v3 c16 (320 ms hop), tracking",
    modelPath: "models/zipformer_p_arabic_v3_c16.int8.onnx",
    io: { T: 45, hop: 32, logProbsFrames: 8 },
    mode: "tracking",
    expected: null,
    stretch: true,
  },
  B2: {
    id: "B2",
    label: "B2: v3 c16 (320 ms hop), correction + expected Fatiha",
    modelPath: "models/zipformer_p_arabic_v3_c16.int8.onnx",
    io: { T: 45, hop: 32, logProbsFrames: 8 },
    mode: "correction",
    expected: { surah: 1, ayah: 1, ayahEnd: 7 },
    stretch: true,
  },
};

export function isVariantId(value: unknown): value is VariantId {
  return typeof value === "string" && (VARIANT_IDS as readonly string[]).includes(value);
}

/** `?variant=A1|A2|B1|B2`; anything else falls back to A1. */
export function parseVariantId(value: string | null | undefined): VariantId {
  return isVariantId(value) ? value : DEFAULT_VARIANT;
}

/**
 * Derive the manifest for a variant from tilawa's bundled one: new T/hop, the `x` input
 * reshaped to [1, T, featureDim], log_probs frame count adjusted, and no encoder-frame
 * output (the c16 export has none, so the slip head stays off).
 */
export function applyIoOverride(base: ZipformerIo, override: IoOverride): ZipformerIo {
  const { encoderFrames: _dropped, ...rest } = base;
  void _dropped;
  return {
    ...rest,
    T: override.T,
    hop: override.hop,
    inputs: base.inputs.map((input) =>
      input.name === "x" ? { ...input, dims: [1, override.T, base.featureDim] } : input,
    ),
    outputs: (base.outputs ?? [])
      .filter((output) => output.name === "log_probs" || output.name.startsWith("new_"))
      .map((output) =>
        output.name === "log_probs"
          ? { ...output, dims: [1, override.logProbsFrames, base.vocabSize] }
          : output,
      ),
  };
}
