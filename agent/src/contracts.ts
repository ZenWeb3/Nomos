// Shared ABI access for the agent, CLI, and demo scripts — all of which
// run as plain Node processes outside Hardhat (the keeper is meant to be a
// "dumb" external process holding the agent key, not something that runs
// through `hardhat run`), so they read the compiled ABI directly from
// Hardhat's own build output rather than going through `hre.viem`.
//
// Requires `pnpm hardhat compile` to have been run at least once.

import NomosPayrollArtifact from "../../artifacts/contracts/NomosPayroll.sol/NomosPayroll.json" with { type: "json" };
import NomosTokenArtifact from "../../artifacts/contracts/NomosToken.sol/NomosToken.json" with { type: "json" };

export const NOMOS_PAYROLL_ABI = NomosPayrollArtifact.abi;
export const NOMOS_TOKEN_ABI = NomosTokenArtifact.abi;

/** Minimal ERC-20 ABI fragment, in case a payroll token other than NomosToken is ever used. */
export const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "approve",
    inputs: [
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
  },
] as const;
