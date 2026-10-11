// Bench-only model override, chosen with `?model=<name>.onnx`: a file in public/models/ that is loaded instead of the
// variant's own model. The variant's io is kept unless `?io=<name>.io.json` (a tilawa io manifest in public/models/,
// made by scripts/model/make_io.py) replaces it. No override means the variant's model and io.

/** One path segment, base name of 1-96 characters, not starting with ".", ending in ".onnx". `..` is rejected separately. */
const MODEL_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,95}\.onnx$/;

/** Same rule for the io manifest: base name of 1-96 characters, ending in ".io.json". */
const IO_NAME_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,95}\.io\.json$/;

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

/** `?io=<name>.io.json`; anything else (or absent) means the variant's io (null). */
export function parseIoName(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!IO_NAME_PATTERN.test(value) || value.includes("..")) return null;
  return value;
}

/** "" without an io override, else "_io<name without .io.json>"; used in result file names (after the model suffix). */
export function ioFileSuffix(name: string | null): string {
  return name === null ? "" : `_io${name.slice(0, -".io.json".length)}`;
}
