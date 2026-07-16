import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { nox } from "@iexec-nox/nox-hardhat-plugin";

const INITIAL_SUPPLY = 1000n;

describe("MyConfidentialToken end-to-end", () => {
  it(
    "mints a confidential totalSupply that the Nox stack resolves and matches the cleartext value",
    { timeout: 120_000 },
    async () => {
      const { viem } = await nox.connect();

      const token = await viem.deployContract("MyConfidentialToken", [
        "My Confidential Token",
        "MCT",
        "ipfs://example",
        INITIAL_SUPPLY,
      ]);

      const totalSupplyHandle =
        (await token.read.confidentialTotalSupply()) as `0x${string}`;

      const { value } = await nox.publicDecrypt(totalSupplyHandle);
      assert.equal(value, INITIAL_SUPPLY);
    },
  );
});
