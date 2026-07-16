// Plain viem clients for Ethereum Sepolia. Deliberately not routed through
// Hardhat's `network.create()` — the keeper and CLI are meant to run as
// ordinary standalone Node processes (the "dumb external keeper" from
// CONTRACT_DESIGN.md), the same way a real cron job or systemd timer would
// invoke them, not as Hardhat scripts.

import { createPublicClient, createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { sepolia } from "viem/chains";

export const SEPOLIA_CHAIN_ID = 11_155_111;

/** Normalizes a private key string to a 0x-prefixed Hex, tolerating a missing prefix. */
export function normalizePrivateKey(raw: string): Hex {
  const trimmed = raw.trim();
  return (trimmed.startsWith("0x") ? trimmed : `0x${trimmed}`) as Hex;
}

export function createSepoliaClients(rpcUrl: string, privateKey: Hex) {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ chain: sepolia, transport });
  const walletClient = createWalletClient({ account, chain: sepolia, transport });
  return { publicClient, walletClient, account };
}

export type SepoliaClients = ReturnType<typeof createSepoliaClients>;

export async function assertSepolia(publicClient: SepoliaClients["publicClient"]): Promise<void> {
  const chainId = await publicClient.getChainId();
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Expected chain id ${SEPOLIA_CHAIN_ID} (Ethereum Sepolia), got ${chainId}. Check SEPOLIA_RPC_URL.`,
    );
  }
}
