import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Abi, Address, Hex } from "viem";
import { zeroAddress } from "viem";
import { nox } from "@iexec-nox/nox-hardhat-plugin";
import NoxComputeArtifact from "@iexec-nox/nox-protocol-contracts/artifacts/contracts/NoxCompute.sol/NoxCompute.json" with { type: "json" };

const NOX_COMPUTE_ABI = NoxComputeArtifact.abi as Abi;

describe("Nox stack", () => {
  it("handle gateway is up", async () => {
    const response = await fetch(nox.handleGatewayUrl);
    assert.ok(
      response.ok,
      `Handle gateway health check failed with status ${response.status}`,
    );
  });

  it("NoxCompute contract is deployed", async () => {
    const noxComputeAddress = nox.noxComputeAddress;
    const { viem } = await nox.connect();
    const publicClient = await viem.getPublicClient();
    const code = await publicClient.getCode({
      address: noxComputeAddress,
    });
    assert.ok(
      code !== undefined && code !== "0x",
      `No contract deployed at ${noxComputeAddress}`,
    );
  });

  it("NoxCompute constructor ran (EIP712 immutables are set)", async () => {
    const noxComputeAddress = nox.noxComputeAddress;
    const { viem } = await nox.connect();
    const publicClient = await viem.getPublicClient();
    const [, name, version] = (await publicClient.readContract({
      address: noxComputeAddress,
      abi: NOX_COMPUTE_ABI,
      functionName: "eip712Domain",
    })) as readonly [
      Hex,
      string,
      string,
      bigint,
      Address,
      Hex,
      readonly bigint[],
    ];
    assert.equal(
      name,
      "NoxCompute",
      "EIP712 domain name is empty — the constructor did not run",
    );
    assert.equal(
      version,
      "1",
      "EIP712 domain version is empty — the constructor did not run",
    );
  });

  it("NoxCompute initializer ran (gateway and KMS key are set)", async () => {
    const noxComputeAddress = nox.noxComputeAddress;
    const { viem } = await nox.connect();
    const publicClient = await viem.getPublicClient();
    const [gateway, kmsPublicKey] = (await Promise.all([
      publicClient.readContract({
        address: noxComputeAddress,
        abi: NOX_COMPUTE_ABI,
        functionName: "gateway",
      }),
      publicClient.readContract({
        address: noxComputeAddress,
        abi: NOX_COMPUTE_ABI,
        functionName: "kmsPublicKey",
      }),
    ])) as [Address, Hex];
    assert.notEqual(
      gateway,
      zeroAddress,
      "gateway is unset — initialize() did not run",
    );
    assert.ok(
      kmsPublicKey !== undefined && kmsPublicKey !== "0x",
      "kmsPublicKey is empty — initialize() did not run",
    );
  });
});
