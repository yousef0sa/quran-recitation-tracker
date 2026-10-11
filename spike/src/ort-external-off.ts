// Stand-in for ort-external.ts in builds made without VITE_EXPERIMENT_PROD_THREADS=1 (see vite.config.ts): it has no `?url`
// imports, so the plain build emits no extra ORT files. tracker.worker.ts only calls it when the flag is set.
export async function useExternalOrtWasm(): Promise<void> {
  throw new Error("useExternalOrtWasm() needs a build made with VITE_EXPERIMENT_PROD_THREADS=1");
}
