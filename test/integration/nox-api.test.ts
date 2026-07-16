import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

describe("nox API", () => {
  it("connect() returns a viem connection and a pre-configured handleClient", async () => {
    const conn = await nox.connect();
    assert.ok(conn.viem, "viem should be present");
    assert.ok(conn.handleClient, "handleClient should be present");
    assert.equal(typeof conn.handleClient.publicDecrypt, "function");
    assert.equal(typeof conn.handleClient.encryptInput, "function");
    assert.equal(typeof conn.handleClient.decrypt, "function");
  });

  it("encryptInput() returns a { handle, handleProof } pair", async () => {
    const { viem } = await nox.connect();
    const [walletClient] = await viem.getWalletClients();
    const result = await nox.encryptInput(
      42n,
      "uint256",
      walletClient.account.address,
    );
    assert.match(
      result.handle,
      /^0x[0-9a-fA-F]{64}$/,
      "handle should be a 32-byte hex string",
    );
    assert.match(
      result.handleProof,
      /^0x[0-9a-fA-F]+$/,
      "handleProof should be a hex string",
    );
  });

  it("publicDecrypt() returns the cleartext of a publicly decryptable handle", async () => {
    const { viem } = await nox.connect();
    const token = await viem.deployContract("MyConfidentialToken", [
      "Nox API Token",
      "NAT",
      "ipfs://example",
      7n,
    ]);
    const handle =
      (await token.read.confidentialTotalSupply()) as `0x${string}`;
    const { value } = await nox.publicDecrypt(handle);
    assert.equal(value, 7n);
  });
});
