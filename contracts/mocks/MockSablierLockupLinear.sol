// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {LockupLinear} from "@sablier/lockup/src/types/LockupLinear.sol";
import {SablierCreateWithDurations} from "../interfaces/ISablierLockupLinearReal.sol";

/// @title MockSablierLockupLinear
/// @notice Records `createWithDurationsLL` calls instead of running real
///         Sablier logic — we're testing NomosPayroll's behavior, not
///         Sablier's, so a mock is the honest choice here. Still pulls the
///         deposit via `transferFrom` like the real contract does, so
///         NomosPayroll's approve-then-call sequence is genuinely exercised.
///         Matches `ISablierLockupLinearReal`'s parameter shape (the real
///         deployed Sepolia contract's shape, not the mismatched npm
///         package's) — see that file for why.
contract MockSablierLockupLinear {
    struct RecordedCall {
        address sender;
        address recipient;
        uint128 totalAmount;
        address token;
        bool cancelable;
        bool transferable;
        uint40 cliffDuration;
        uint40 totalDuration;
    }

    RecordedCall[] public calls;
    uint256 private _nextStreamId = 1;

    function createWithDurationsLL(
        SablierCreateWithDurations calldata params,
        LockupLinear.UnlockAmounts calldata, /* unlockAmounts */
        LockupLinear.Durations calldata durations
    ) external payable returns (uint256 streamId) {
        params.token.transferFrom(msg.sender, address(this), params.totalAmount);

        calls.push(
            RecordedCall({
                sender: params.sender,
                recipient: params.recipient,
                totalAmount: params.totalAmount,
                token: address(params.token),
                cancelable: params.cancelable,
                transferable: params.transferable,
                cliffDuration: durations.cliff,
                totalDuration: durations.total
            })
        );

        streamId = _nextStreamId++;
    }

    function callsLength() external view returns (uint256) {
        return calls.length;
    }
}
