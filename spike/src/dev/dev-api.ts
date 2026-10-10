// Dev-only client for the Vite dev-server helper endpoints. Imported only behind
// `import.meta.env.DEV`, so it never reaches the production build.
import type { RecordingInfo } from "../../scripts/dev-harness"; // type only: erased, nothing from scripts/ is bundled
import type { Labels } from "../labels";

const API = "/__dev";

async function ensureOk(res: Response): Promise<Response> {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
  return res;
}

/** `?dir=<subfolder of spike/recordings>` for the read endpoints; "" for the top level. */
function dirQuery(dir?: string): string {
  return dir === undefined ? "" : `?dir=${encodeURIComponent(dir)}`;
}

export async function listRecordings(dir?: string): Promise<RecordingInfo[]> {
  return (await (await ensureOk(await fetch(`${API}/recordings${dirQuery(dir)}`))).json()) as RecordingInfo[];
}

export async function fetchRecordingFile(name: string, dir?: string): Promise<File> {
  const res = await ensureOk(await fetch(`${API}/recordings/${encodeURIComponent(name)}${dirQuery(dir)}`));
  return new File([await res.blob()], name, { type: res.headers.get("content-type") ?? "" });
}

/** The labels file of a recording as a File named `<base>.labels.json`. */
export async function fetchLabelsFile(base: string, dir?: string): Promise<File> {
  const res = await ensureOk(await fetch(`${API}/labels/${encodeURIComponent(base)}${dirQuery(dir)}`));
  return new File([await res.blob()], `${base}.labels.json`, { type: "application/json" });
}

/** POSTs validated labels. Resolves "exists" on 409 so the caller can ask before overwriting. */
export async function postLabels(base: string, labels: Labels, overwrite: boolean): Promise<"written" | "exists"> {
  const res = await fetch(`${API}/labels/${encodeURIComponent(base)}${overwrite ? "?overwrite=1" : ""}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(labels),
  });
  if (res.status === 409) return "exists";
  await ensureOk(res);
  return "written";
}

/** Append-only: the server adds a numeric suffix on a name clash and returns the name it used. */
export async function postResult(fileName: string, data: unknown): Promise<string> {
  const res = await ensureOk(
    await fetch(`${API}/results/${encodeURIComponent(fileName)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }),
  );
  return ((await res.json()) as { written: string }).written;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * `<YYYYMMDD-HHmmss>_<variant>_<chunk>ms[<suffix>][_<dir>]_<kind>.json` in local time; the suffix names engine
 * overrides (e.g. `_settle12`), `dir` the recordings subfolder the run used.
 */
export function resultFileName(
  date: Date,
  variant: string,
  chunkMs: number,
  kind: "results" | "eventlogs",
  suffix = "",
  dir: string | null = null,
): string {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `${stamp}_${variant}_${chunkMs}ms${suffix}${dir === null ? "" : `_${dir}`}_${kind}.json`;
}
