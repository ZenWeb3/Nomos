#!/usr/bin/env -S node --
// Nomos verification CLI. Run with:
//   pnpm nomos <command>
// See each command's --help, or cli/README.md.

import "dotenv/config";
import { Command } from "commander";
import { statusCommand } from "./status.js";
import { verifyCommand } from "./verify.js";
import { auditCommand } from "./audit.js";

const program = new Command();
program.name("nomos").description("Nomos payroll independent-verification CLI").version("0.1.0");

program
  .command("status")
  .description("Roster size, treasury balance, cycle count, time until next eligible cycle. No keys needed.")
  .action(async () => {
    await statusCommand();
  });

program
  .command("verify")
  .description(
    "Independently verify every PaymentAttested handle for a cycle via Nox's publicDecrypt + on-chain proof re-check. No keys needed.",
  )
  .requiredOption("--cycle <n>", "cycle number to verify", (value) => Number(value))
  .option(
    "--from-block <n>",
    "skip the backward log-scan and start from this block (faster if you already know it, e.g. from a deploy script's output)",
    (value) => BigInt(value),
  )
  .action(async (opts: { cycle: number; fromBlock?: bigint }) => {
    process.exitCode = await verifyCommand(opts.cycle, opts.fromBlock);
  });

program
  .command("audit")
  .description(
    "Decrypt the confidential aggregate outflow using an auditor key. A key that was never granted via grantAuditor gets an ACL error.",
  )
  .requiredOption(
    "--auditor-key <path>",
    "path to a file with the auditor's private key (raw hex, or a deployments JSON with an auditor.privateKey field)",
  )
  .action(async (opts: { auditorKey: string }) => {
    process.exitCode = await auditCommand(opts.auditorKey);
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
