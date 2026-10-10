import { describe, expect, it } from "vitest";
import { DEFAULT_ZIPFORMER_IO } from "@tilawa/core";
import assets from "../scripts/assets.json";
import {
  CORPUS_PATH,
  DEFAULT_VARIANT,
  VARIANT_IDS,
  VARIANTS,
  applyIoOverride,
  parseVariantId,
} from "./variants";

const assetPaths = new Set(assets.assets.map((a) => a.dest.replace(/^public\//, "")));

describe("variants", () => {
  it("each variant's model file is listed in scripts/assets.json", () => {
    for (const id of VARIANT_IDS) {
      expect(assetPaths.has(VARIANTS[id].modelPath), `${id}: ${VARIANTS[id].modelPath}`).toBe(true);
    }
  });
  it("the corpus is listed in scripts/assets.json", () => {
    expect(assetPaths.has(CORPUS_PATH)).toBe(true);
  });
  it("every asset goes to a gitignored folder", () => {
    for (const asset of assets.assets) {
      expect(asset.dest).toMatch(/^public\/(models|data)\//);
    }
  });
  it("B2 combines the B1 model and io override with A2's correction mode", () => {
    expect(VARIANT_IDS).toContain("B2");
    expect(VARIANTS.B2).toMatchObject({
      modelPath: VARIANTS.B1.modelPath,
      io: VARIANTS.B1.io,
      mode: VARIANTS.A2.mode,
      expected: { surah: 1, ayah: 1, ayahEnd: 7 },
      label: "B2: v3 c16 (320 ms hop), correction + expected Fatiha",
      stretch: true,
    });
  });
  it("A1 is primary tracking, A2 is correction with expected Fatiha, B1 is a stretch override", () => {
    expect(VARIANTS.A1).toMatchObject({ mode: "tracking", io: null, expected: null, stretch: false });
    expect(VARIANTS.A2).toMatchObject({
      mode: "correction",
      expected: { surah: 1, ayah: 1, ayahEnd: 7 },
    });
    expect(VARIANTS.B1).toMatchObject({ stretch: true, io: { T: 45, hop: 32 } });
  });
  it("parseVariantId defaults to B2", () => {
    expect(DEFAULT_VARIANT).toBe("B2");
    expect(parseVariantId(null)).toBe("B2");
    expect(parseVariantId("nope")).toBe("B2");
    expect(parseVariantId("A1")).toBe("A1");
    expect(parseVariantId("B1")).toBe("B1");
    expect(parseVariantId("A2")).toBe("A2");
    expect(parseVariantId("B2")).toBe("B2");
  });
});

describe("applyIoOverride", () => {
  const io = applyIoOverride(DEFAULT_ZIPFORMER_IO, { T: 45, hop: 32, logProbsFrames: 8 });
  it("changes T, hop and the x shape only", () => {
    expect(io.T).toBe(45);
    expect(io.hop).toBe(32);
    expect(io.inputs.find((i) => i.name === "x")?.dims).toEqual([1, 45, 80]);
    expect(io.inputs).toHaveLength(DEFAULT_ZIPFORMER_IO.inputs.length);
    const base = DEFAULT_ZIPFORMER_IO.inputs.filter((i) => i.name !== "x");
    expect(io.inputs.filter((i) => i.name !== "x")).toEqual(base);
  });
  it("drops the encoder-frame output and reshapes log_probs", () => {
    expect(io.encoderFrames).toBeUndefined();
    expect(io.outputs?.find((o) => o.name === "log_probs")?.dims).toEqual([1, 8, 251]);
    expect(io.outputs?.some((o) => o.name.startsWith("/"))).toBe(false);
  });
  it("does not mutate the bundled manifest", () => {
    expect(DEFAULT_ZIPFORMER_IO.T).toBe(61);
    expect(DEFAULT_ZIPFORMER_IO.encoderFrames).toBeDefined();
  });
});
