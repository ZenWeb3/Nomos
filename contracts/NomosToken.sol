// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title NomosToken
/// @notice Demo ERC-20 used as the Nomos payroll token on testnets, standing
/// in for a real stablecoin. `mint` is intentionally open to anyone — this
/// is a testnet demo token, not a production asset, and unrestricted minting
/// is what lets the deploy script and demos fund the payroll treasury
/// without depending on a third-party faucet.
contract NomosToken is ERC20 {
    constructor() ERC20("Nomos Payroll Token", "NMS") {}

    /// @notice Mints `amount` tokens to `to`. No access control by design.
    /// @param to The address to receive the minted tokens.
    /// @param amount The amount to mint, denoted in the token's decimals (18).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
