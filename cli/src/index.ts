#!/usr/bin/env -S node --
// Nomos verification CLI. Run with:
//   pnpm nomos <command>
// See each command's --help, or cli/README.md.

import "dotenv/config";
import { Command } from "commander";
import { statusCommand, statusWatchCommand } from "./status.js";
import { verifyCommand, verifyAllCommand } from "./verify.js";
import { auditCommand } from "./audit.js";
import { mySalaryCommand } from "./my-salary.js";

const program = new Command();
program.name("nomos").description("Nomos payroll independent-verification CLI").version("0.1.0");

program
  .command("status")
  .description("Roster size, treasury balance, cycle count, time until next eligible cycle. No keys needed.")
  .option("--json", "output machine-readable JSON instead of a formatted report")
  .option("--watch", "re-fetch and reprint on an interval instead of exiting after one read")
  .option("--interval <seconds>", "seconds between refreshes in --watch mode (default: 5)", (value) => Number(value))
  .action(async (opts: { json?: boolean; watch?: boolean; interval?: number }) => {
    if (opts.watch) {
      await statusWatchCommand(opts.interval ?? 5, Boolean(opts.json));
      return;
    }
    await statusCommand(Boolean(opts.json));
  });

program
  .command("verify")
  .description(
    "Independently verify every PaymentAttested handle for a cycle via Nox's publicDecrypt + on-chain proof re-check. No keys needed.",
  )
  .option("--cycle <n>", "cycle number to verify", (value) => Number(value))
  .option("--all", "verify every cycle found, not just one")
  .option(
    "--from-block <n>",
    "skip the backward log-scan and start from this block (faster if you already know it, e.g. from a deploy script's output)",
    (value) => BigInt(value),
  )
  .option("--json", "output machine-readable JSON instead of a formatted report")
  .action(async (opts: { cycle?: number; all?: boolean; fromBlock?: bigint; json?: boolean }) => {
    if (opts.cycle === undefined && !opts.all) {
      console.error("Pass either --cycle <n> or --all.");
      process.exitCode = 1;
      return;
    }
    if (opts.cycle !== undefined && opts.all) {
      console.error("Pass either --cycle <n> or --all, not both.");
      process.exitCode = 1;
      return;
    }
    const json = Boolean(opts.json);
    process.exitCode =
      opts.cycle !== undefined
        ? await verifyCommand(opts.cycle, opts.fromBlock, json)
        : await verifyAllCommand(opts.fromBlock, json);
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
  .option("--json", "output machine-readable JSON instead of a formatted report")
  .action(async (opts: { auditorKey: string; json?: boolean }) => {
    process.exitCode = await auditCommand(opts.auditorKey, Boolean(opts.json));
  });

program
  .command("my-salary")
  .description(
    "Decrypt your own salary as an employee. Nox.allow(salary, recipient) grants this at addEmployee time — any key that isn't on the roster gets a genuine ACL rejection.",
  )
  .requiredOption(
    "--key <path>",
    "path to a file with your private key (raw hex, or a deployments JSON with an employees[] entry — pass --employee to pick one)",
  )
  .option(
    "--employee <name-or-address>",
    "which employees[] entry to use, when --key points at a deployments JSON with more than one",
  )
  .option("--json", "output machine-readable JSON instead of a formatted report")
  .action(async (opts: { key: string; employee?: string; json?: boolean }) => {
    process.exitCode = await mySalaryCommand(opts.key, opts.employee, Boolean(opts.json));
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
