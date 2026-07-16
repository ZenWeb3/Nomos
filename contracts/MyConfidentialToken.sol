// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {ERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/token/ERC7984.sol";
import {Nox} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

/// @title MyConfidentialToken
/// @notice Minimal ERC-7984 confidential fungible token used as a sample for
///         the Nox Hardhat plugin example project.
contract MyConfidentialToken is ERC7984 {
    constructor(string memory name_, string memory symbol_, string memory contractURI_, uint256 supply)
        ERC7984(name_, symbol_, contractURI_)
    {
        _mint(msg.sender, Nox.toEuint256(supply));
        Nox.allowPublicDecryption(confidentialTotalSupply());
    }
}
