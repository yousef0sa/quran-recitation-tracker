// Deterministic end-to-end tests only: no agents, no model, nothing leaves the machine.
import type { E2EConfig } from "e2e";
import { web } from "@e2e-dev/web";

export default {
  tests: "tests/**/*.e2e.ts",
  targets: [
    {
      engine: web(),
      app: {
        // Port 0 takes a free port; the dev harness only accepts loopback hosts.
        url: "http://127.0.0.1:0",
        command: {
          executable: "node",
          args: ["node_modules/vite/bin/vite.js", "--host", "127.0.0.1", "--port", "{port}", "--strictPort"],
          log: ".e2e/logs/app.log",
        },
      },
    },
  ],
} satisfies E2EConfig;
