// Entry point for the quran-guard tests (the suite is quran-guard.suite.mjs).
// The suite needs the corpus (npm run fetch-assets in spike/). Without it the suite is skipped
// locally with that reason, and fails with the same message in CI (CI=true), never silently.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = JSON.parse(readFileSync(join(HERE, "quran-guard.config.json"), "utf8")).sources[0].path;
const MISSING = `corpus missing: ${SOURCE} (run npm run fetch-assets in spike/)`;

if (existsSync(join(resolve(HERE, "..", ".."), SOURCE))) await import("./quran-guard.suite.mjs");
else if (process.env.CI) throw new Error(MISSING);
else test("quran-guard suite", { skip: MISSING }, () => {});
