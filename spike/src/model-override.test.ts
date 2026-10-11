import { describe, expect, it } from "vitest";
import { modelFileSuffix, parseModelName } from "./model-override";

describe("parseModelName", () => {
  it("accepts a plain model file name", () => {
    expect(parseModelName("a.onnx")).toBe("a.onnx");
    expect(parseModelName("zipformer_p_arabic_v3_c16.int8.onnx")).toBe("zipformer_p_arabic_v3_c16.int8.onnx");
    expect(parseModelName("0-x_y.deq-fp32.onnx")).toBe("0-x_y.deq-fp32.onnx");
  });

  it("rejects path tricks and the wrong extension", () => {
    for (const bad of ["../x.onnx", ".x.onnx", "a..b.onnx", "x.onnx.exe", "a/b.onnx", "a\\b.onnx", "models/a.onnx", "a b.onnx", "x.ONNX", "x", ".onnx"]) {
      expect(parseModelName(bad)).toBeNull();
    }
  });

  it("rejects empty, null and undefined", () => {
    expect(parseModelName("")).toBeNull();
    expect(parseModelName(null)).toBeNull();
    expect(parseModelName(undefined)).toBeNull();
  });

  it("accepts a 96-character base name and rejects 97", () => {
    expect(parseModelName(`${"a".repeat(96)}.onnx`)).toBe(`${"a".repeat(96)}.onnx`);
    expect(parseModelName(`${"a".repeat(97)}.onnx`)).toBeNull();
  });
});

describe("modelFileSuffix", () => {
  it("is empty without an override and names the model otherwise", () => {
    expect(modelFileSuffix(null)).toBe("");
    expect(modelFileSuffix("x.int8.onnx")).toBe("_mx.int8");
    expect(modelFileSuffix("zipformer_p_arabic_v3_c16.int8.onnx")).toBe("_mzipformer_p_arabic_v3_c16.int8");
  });
});
