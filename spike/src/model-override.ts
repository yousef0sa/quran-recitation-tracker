// Bench-only model override, chosen with `?model=<name>.onnx`: a file in public/models/ that is loaded instead of the
// variant's own model (the variant's io is kept). No override means the variant's model.

/** One path segment, base name of 1-96 characters, not starting with ".", ending in ".onnx". `..` is rejected separately. */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,95}\.onnx$/;

/** `?model=<name>.onnx`; anything else (or absent) means the variant's model (null). */
export function parseModelName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!MODEL_NAME_PATTERN.test(value) || value.includes("..")) return null;
  return value;
}

/** "" without an override, else "_m<name without .onnx>"; used in result file names. */
export function modelFileSuffix(name: string | null): string {
  return name === null ? "" : `_m${name.slice(0, -".onnx".length)}`;
}
