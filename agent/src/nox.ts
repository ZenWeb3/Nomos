// Nox handle client factory. Uses createViemHandleClient directly (not the
// nox-hardhat-plugin's `nox` singleton, which is hard-bound to a local
// Hardhat network connection and account[0] — see the Sprint 2 test-suite
// notes in SPRINT.md for why that doesn't work outside a Hardhat process).
//
// createViemHandleClient auto-resolves gatewayUrl/smartContractAddress/
// subgraphUrl for chain 11155111 from @iexec-nox/handle's own
// NETWORK_CONFIGS table — the same pattern already proven in
// scripts/deploy-sepolia.ts. A wallet client backed by a local private-key
// account (not a JSON-RPC/node-managed one) reports its own address
// directly via `getAddresses()`, so — unlike the local Hardhat-node test
// setup — no address-scoping proxy is needed here.

import { createViemHandleClient, type HandleClient } from "@iexec-nox/handle";
import type { WalletClient } from "viem";

/** NoxCompute's address on Ethereum Sepolia — Nox.sol's own hardcoded per-chain table. */
export const NOX_COMPUTE_ADDRESS = "0x24Ef36Ec5b626D7DCD09a98F3083c2758F0F77bF" as const;

/** Minimal ABI fragment for the two NoxCompute reads the CLI needs. */
export const NOX_COMPUTE_ABI = [
  {
    type: "function",
    name: "validateDecryptionProof",
    inputs: [
      { name: "handle", type: "bytes32" },
      { name: "decryptionProof", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "gateway",
    inputs: [],
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
  },
] as const;

export async function createNoxHandleClient(walletClient: WalletClient): Promise<HandleClient> {
  return createViemHandleClient(walletClient as never);
}
