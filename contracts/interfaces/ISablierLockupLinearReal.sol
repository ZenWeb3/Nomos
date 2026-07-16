// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@sablier/lockup/src/types/Lockup.sol";
import {LockupLinear} from "@sablier/lockup/src/types/LockupLinear.sol";

/// @notice Broker parameters passed to Sablier's create functions. Both
/// fields can be zero, as they are everywhere in this project.
/// @dev `fee` mirrors Sablier's `UD60x18` (a fixed-point type defined as
/// `type UD60x18 is uint256;` in @prb/math) — ABI-identical to `uint256`,
/// declared directly to avoid an extra dependency for one field.
struct SablierBroker {
    address account;
    uint256 fee;
}

/// @notice Mirrors the real, currently-deployed `SablierLockup.createWithDurationsLL`
/// parameter shape on Ethereum Sepolia — confirmed against the contract's own
/// verified source at 0xC2Da366fD67423b500cDF4712BdB41d0995b0794.
///
/// This deliberately does NOT reuse `@sablier/lockup@4.0.1`'s own
/// `Lockup.CreateWithDurations` type: that npm package's struct omits the
/// `broker` field entirely and names the amount field `depositAmount`
/// instead of `totalAmount`. Solidity function selectors are derived from
/// the full canonical parameter type signature, so a struct with a
/// different field count encodes to a completely different selector —
/// calling `createWithDurationsLL` built against the npm package's shape
/// hits no matching function on the real deployed contract and reverts
/// with empty returndata (no custom error, no reason string; confirmed
/// live on Sepolia). The npm package is evidently a different release than
/// what's actually deployed there.
struct SablierCreateWithDurations {
    address sender;
    address recipient;
    uint128 totalAmount;
    IERC20 token;
    bool cancelable;
    bool transferable;
    string shape;
    SablierBroker broker;
}

/// @notice Minimal interface for the one Sablier entry point NomosPayroll
/// calls, matching the real deployed contract rather than the npm
/// package's (mismatched) interface. See `SablierCreateWithDurations` for
/// why a custom struct was necessary.
interface ISablierLockupLinearReal {
    function createWithDurationsLL(
        SablierCreateWithDurations calldata params,
        LockupLinear.UnlockAmounts calldata unlockAmounts,
        LockupLinear.Durations calldata durations
    ) external payable returns (uint256 streamId);
}
