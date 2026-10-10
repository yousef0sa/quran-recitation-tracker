// Bench-only overrides of tilawa's engine config (today just settleFrames), chosen with `?settle=`.
// No override means tilawa's own defaults: the worker then omits `config` entirely.
export interface EngineOverride {
  /** Frames (25 Hz, 40 ms each) of silence after the last heard character before the cursor word settles. Tilawa default: 25. */
  settleFrames?: number;
}

export const SETTLE_FRAMES_MIN = 1;
export const SETTLE_FRAMES_MAX = 200;

/** `?settle=<integer 1..200>`; anything else (or absent) means tilawa's default (null). */
export function parseSettleFrames(value: string | null | undefined): number | null {
  if (value === null || value === undefined || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return n >= SETTLE_FRAMES_MIN && n <= SETTLE_FRAMES_MAX ? n : null;
}

export function engineOverrideFrom(settleFrames: number | null): EngineOverride {
  return settleFrames === null ? {} : { settleFrames };
}

/** "" without overrides, else "_settle<n>"; used in result file names. */
export function engineConfigSuffix(override: EngineOverride): string {
  return override.settleFrames === undefined ? "" : `_settle${override.settleFrames}`;
}
