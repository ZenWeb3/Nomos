// Entrypoint for the Nomos keeper agent. Run with:
//   pnpm agent
// (tsx runs this directly — no separate build step. See agent/README.md
// for required env vars.)
//
// This process is the "dumb external keeper" from CONTRACT_DESIGN.md: it
// holds the agent's private key and decides *when* to call runCycle, but
// has no policy logic of its own — cooldown, spend cap, and allowlist
// enforcement all live on-chain in NomosPayroll.

import "dotenv/config";
import { createLogger } from "./log.js";
import { loadKeeperConfigFromEnv, runKeeperLoop } from "./keeper.js";

const log = createLogger("index");

async function main(): Promise<void> {
  const config = loadKeeperConfigFromEnv(process.env);

  const controller = new AbortController();
  const stop = (signal: string) => {
    log.info("received shutdown signal, stopping after the current tick", { signal });
    controller.abort();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  await runKeeperLoop(config, { signal: controller.signal });
}

main().catch((error) => {
  log.error("keeper crashed", { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
});
