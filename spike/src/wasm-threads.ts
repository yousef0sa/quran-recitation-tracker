// WASM thread count of onnxruntime-web, chosen with `?threads=` (bench and live page).
// More than 1 needs a cross-origin isolated page (SharedArrayBuffer): see crossOriginIsolation() in vite.config.ts.
export const THREAD_OPTIONS = [1, 2, 4] as const;
export type Threads = (typeof THREAD_OPTIONS)[number];
export const DEFAULT_THREADS: Threads = 1;
/** Phones default to 4: single-thread B2 is slower than real time on a mid-range phone (RESULTS.md, follow-up 2). Provisional. */
export const PHONE_THREADS: Threads = 4;

/** PHONE_THREADS on a phone (by user agent), else DEFAULT_THREADS. */
export function defaultThreads(userAgent: string): Threads {
  return /Android|iPhone|iPod|Mobile/i.test(userAgent) ? PHONE_THREADS : DEFAULT_THREADS;
}

/**
 * Thread count to request: `?threads=` or the device default on the dev server.
 * A production build always uses 1, whatever `?threads=` says: more than 1 hangs at load there (RESULTS.md, follow-up 2).
 */
export function requestThreads(value: string | null, userAgent: string, devServer: boolean): Threads {
  return devServer ? parseThreads(value, defaultThreads(userAgent)) : DEFAULT_THREADS;
}

/** `?threads=1|2|4`; anything else falls back to `fallback` (the device default). */
export function parseThreads(value: string | null | undefined, fallback: Threads = DEFAULT_THREADS): Threads {
  const found = THREAD_OPTIONS.find((n) => String(n) === value);
  return found ?? fallback;
}

/** Text shown for the backend; pass the effective count once the worker reported it. */
export function backendLabel(threads: number): string {
  return threads === 1 ? "WASM single-thread" : `WASM ${threads} threads`;
}

/**
 * Result file-name suffix: "" for 1 thread (or unknown), else "_t<effective>", plus "_req<requested>"
 * when ORT ran with a different count, so a fallback run can never pass for a real one.
 */
export function threadsFileSuffix(requested: Threads, effective: number | null): string {
  if (effective === null || (effective === 1 && requested === 1)) return "";
  const effectivePart = effective === 1 ? "" : `_t${effective}`;
  return effective === requested ? effectivePart : `${effectivePart}_req${requested}`;
}

/** "" for 1 thread (or unknown), else "، WASM <n> threads" for the end of a status line. */
export function threadsStatusPart(effective: number | null): string {
  return effective === null || effective === 1 ? "" : `، ${backendLabel(effective)}`;
}
