import { describe, expect, it } from "vitest";
import { ioFileSuffix, modelFileSuffix, parseIoName, parseModelName } from "./model-override";

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

describe("parseIoName", () => {
  it("accepts a plain io manifest file name", () => {
    expect(parseIoName("a.io.json")).toBe("a.io.json");
    expect(parseIoName("zipformer_a0w_ep1_a05.io.json")).toBe("zipformer_a0w_ep1_a05.io.json");
    expect(parseIoName("zipformer_p_arabic_v3.1_left64.int8.io.json")).toBe("zipformer_p_arabic_v3.1_left64.int8.io.json");
  });

  it("rejects path tricks and the wrong extension", () => {
    for (const bad of ["../x.io.json", ".x.io.json", "a..b.io.json", "x.io.json.exe", "a/b.io.json", "a\b.io.json", "models/a.io.json", "a b.io.json", "x.IO.json", "x.json", "x.onnx", "xio.json", ".io.json", "x.io.JSON"]) {
      expect(parseIoName(bad)).toBeNull();
    }
  });

  it("rejects empty, null and undefined", () => {
    expect(parseIoName("")).toBeNull();
    expect(parseIoName(null)).toBeNull();
    expect(parseIoName(undefined)).toBeNull();
  });

  it("accepts a 96-character base name and rejects 97", () => {
    expect(parseIoName(`${"a".repeat(96)}.io.json`)).toBe(`${"a".repeat(96)}.io.json`);
    expect(parseIoName(`${"a".repeat(97)}.io.json`)).toBeNull();
  });
});

describe("ioFileSuffix", () => {
  it("is empty without an override and names the manifest otherwise", () => {
    expect(ioFileSuffix(null)).toBe("");
    expect(ioFileSuffix("x.io.json")).toBe("_iox");
    expect(ioFileSuffix("zipformer_p_arabic_v3.1_left64.int8.io.json")).toBe("_iozipformer_p_arabic_v3.1_left64.int8");
  });
});
