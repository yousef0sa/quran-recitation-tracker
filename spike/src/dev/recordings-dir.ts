// The `dir` option of the dev bench (`bench.html?autorun=1&dir=trust`): ONE subfolder of spike/recordings/.
// Shared by the dev-server harness (scripts/dev-harness.ts, which enforces it) and the bench client, so
// both sides accept exactly the same names. One path segment only: no separators, dots or spaces.
export const RECORDINGS_DIR_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function isValidRecordingsDir(value: unknown): value is string {
  return typeof value === "string" && RECORDINGS_DIR_PATTERN.test(value);
}
