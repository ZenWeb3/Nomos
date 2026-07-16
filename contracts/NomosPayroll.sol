// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.28;

import {Nox, euint256, externalEuint256, ebool} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";
import {IERC20} from "@sablier/lockup/src/types/Lockup.sol";
import {LockupLinear} from "@sablier/lockup/src/types/LockupLinear.sol";
import {ISablierLockupLinearReal, SablierCreateWithDurations, SablierBroker} from "./interfaces/ISablierLockupLinearReal.sol";

/// @title NomosPayroll
/// @notice Confidential, agent-run payroll. Salary amounts stay behind Nox
///         handles; the schedule (cooldown, cycle count) and the spend cap
///         are plaintext by design. See CONTRACT_DESIGN.md for the full
///         rationale — this file follows that document section by section.
contract NomosPayroll {
    // ============ Errors ============

    error NotOwner();
    error NotAgent();
    error Reentrant();
    error ZeroAddress();
    error ZeroAmount();
    error AlreadyAllowlisted(address recipient);
    error NotAllowlisted(address recipient);
    error AuditorNotFound(address auditor);
    error CooldownNotElapsed(uint256 nextAllowedTimestamp);
    error PaymentsLengthMismatch(uint256 expected, uint256 actual);
    error RecipientMismatch(uint256 index, address expected, address actual);
    error ZeroSalary(address recipient);
    error AmountTooLarge(address recipient);
    error ZeroStreamDuration();
    error OverSpendCap();
    error TransferFailed();

    // ============ Events ============
    // No salary amount is ever emitted — only handles (opaque bytes32) or
    // pass/fail booleans. See CONTRACT_DESIGN.md §7.

    event EmployeeAdded(address indexed recipient);
    event EmployeeRemoved(address indexed recipient);
    event PolicyUpdated(uint256 cooldownSeconds, uint40 cliffDuration, uint40 streamDuration, uint256 spendCap);
    event AgentUpdated(address indexed newAgent);
    event AuditorGranted(address indexed auditor);
    event AuditorRevoked(address indexed auditor);
    event Deposited(address indexed from, uint256 amount);
    event CycleExecuted(uint256 indexed cycleCount, uint256 timestamp, uint256 employeeCount);
    event PaymentAttested(
        address indexed recipient, uint256 indexed streamId, uint256 indexed cycleCount, bytes32 matchesLedgerHandle
    );

    // ============ Types ============

    struct Policy {
        uint256 cooldownSeconds;
        uint40 cliffDuration;
        uint40 streamDuration;
        uint256 spendCap; // plaintext — see CONTRACT_DESIGN.md §1/§4/§6
    }

    struct CyclePayment {
        address recipient; // must equal _employees[i] at the same index
        uint256 amount; // agent-decrypted plaintext salary, unverifiable on-chain (§0)
    }

    // ============ State ============

    address public immutable owner;
    address public agent;

    IERC20 public immutable payrollToken;
    ISablierLockupLinearReal public immutable sablier;

    Policy public policy;

    mapping(address => bool) public isAllowlisted;
    mapping(address => euint256) private _salaryOf;
    address[] private _employees;

    euint256 private _cycleSpendHandle;
    ebool private _withinCapHandle;

    address[] private _auditors;

    uint256 public lastRunTimestamp;
    uint256 public cycleCount;
    uint256 public totalDeposited;

    uint256 private _locked = 1;

    // ============ Modifiers ============

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAgent() {
        if (msg.sender != agent) revert NotAgent();
        _;
    }

    modifier nonReentrant() {
        if (_locked == 2) revert Reentrant();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ============ Constructor ============

    constructor(
        address agent_,
        IERC20 payrollToken_,
        ISablierLockupLinearReal sablier_,
        uint256 cooldownSeconds_,
        uint40 cliffDuration_,
        uint40 streamDuration_,
        uint256 spendCap_
    ) {
        if (agent_ == address(0) || address(payrollToken_) == address(0) || address(sablier_) == address(0)) {
            revert ZeroAddress();
        }
        owner = msg.sender;
        agent = agent_;
        payrollToken = payrollToken_;
        sablier = sablier_;
        policy = Policy(cooldownSeconds_, cliffDuration_, streamDuration_, spendCap_);
        emit AgentUpdated(agent_);
        emit PolicyUpdated(cooldownSeconds_, cliffDuration_, streamDuration_, spendCap_);
    }

    // ============ Owner: roster ============

    function addEmployee(externalEuint256 encryptedAmount, bytes calldata proof, address recipient)
        external
        onlyOwner
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (isAllowlisted[recipient]) revert AlreadyAllowlisted(recipient);

        euint256 salary = Nox.fromExternal(encryptedAmount, proof);
        Nox.allowThis(salary); // persist beyond this tx — required for runCycle's later Nox.eq (§0/Finding 1)
        _salaryOf[recipient] = salary;
        isAllowlisted[recipient] = true;
        _employees.push(recipient);

        Nox.allow(salary, recipient);
        Nox.allow(salary, agent);

        _cycleSpendHandle = Nox.add(_cycleSpendHandle, salary);
        Nox.allowThis(_cycleSpendHandle); // persist beyond this tx — required for the next roster edit
        // Deliberately NOT Nox.allowPublicDecryption here — the raw aggregate is
        // auditor-only (§2/§4). Only _withinCapHandle (a boolean) is public.

        _recomputeWithinCap();
        _regrantAuditors();

        emit EmployeeAdded(recipient);
    }

    function removeEmployee(address recipient) external onlyOwner {
        if (!isAllowlisted[recipient]) revert NotAllowlisted(recipient);

        euint256 salary = _salaryOf[recipient];
        isAllowlisted[recipient] = false;
        _salaryOf[recipient] = euint256.wrap(bytes32(0));
        // Note: this only clears our own bookkeeping. The Nox.allow grants already
        // given to `recipient`/`agent` on the orphaned handle are not revocable —
        // see CONTRACT_DESIGN.md §8, Known Limitations.

        uint256 len = _employees.length;
        for (uint256 i = 0; i < len; i++) {
            if (_employees[i] == recipient) {
                _employees[i] = _employees[len - 1];
                _employees.pop();
                break;
            }
        }

        _cycleSpendHandle = Nox.sub(_cycleSpendHandle, salary);
        Nox.allowThis(_cycleSpendHandle);
        // Deliberately NOT Nox.allowPublicDecryption here — see addEmployee.

        _recomputeWithinCap();
        _regrantAuditors();

        emit EmployeeRemoved(recipient);
    }

    // ============ Owner: policy / roles ============

    function setPolicy(uint256 cooldownSeconds, uint40 cliffDuration, uint40 streamDuration, uint256 spendCap)
        external
        onlyOwner
    {
        if (streamDuration == 0) revert ZeroStreamDuration();
        policy = Policy(cooldownSeconds, cliffDuration, streamDuration, spendCap);
        _recomputeWithinCap();
        emit PolicyUpdated(cooldownSeconds, cliffDuration, streamDuration, spendCap);
    }

    function setAgent(address newAgent) external onlyOwner {
        if (newAgent == address(0)) revert ZeroAddress();
        agent = newAgent;
        emit AgentUpdated(newAgent);
    }

    function grantAuditor(address auditor) external onlyOwner {
        if (auditor == address(0)) revert ZeroAddress();
        _auditors.push(auditor);
        Nox.allow(_cycleSpendHandle, auditor);
        emit AuditorGranted(auditor);
    }

    function revokeAuditor(address auditor) external onlyOwner {
        uint256 len = _auditors.length;
        for (uint256 i = 0; i < len; i++) {
            if (_auditors[i] == auditor) {
                _auditors[i] = _auditors[len - 1];
                _auditors.pop();
                emit AuditorRevoked(auditor);
                return;
            }
        }
        revert AuditorNotFound(auditor);
    }

    // ============ Funding ============

    function deposit(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        totalDeposited += amount; // CEI: state before external call
        bool ok = payrollToken.transferFrom(msg.sender, address(this), amount);
        if (!ok) revert TransferFailed();
        emit Deposited(msg.sender, amount);
    }

    // ============ Agent: cycle execution ============

    function runCycle(bytes calldata withinCapProof, CyclePayment[] calldata payments)
        external
        onlyAgent
        nonReentrant
    {
        uint256 nextAllowed = lastRunTimestamp + policy.cooldownSeconds;
        if (block.timestamp < nextAllowed) revert CooldownNotElapsed(nextAllowed);

        uint256 len = _employees.length;
        if (payments.length != len) revert PaymentsLengthMismatch(len, payments.length);

        bool withinCap = Nox.publicDecrypt(_withinCapHandle, withinCapProof);
        if (!withinCap) revert OverSpendCap();

        if (policy.streamDuration == 0) revert ZeroStreamDuration();

        // CEI: bump schedule state before the external-call loop below.
        lastRunTimestamp = block.timestamp;
        cycleCount += 1;

        for (uint256 i = 0; i < len; i++) {
            CyclePayment calldata payment = payments[i];
            if (payment.recipient != _employees[i]) {
                revert RecipientMismatch(i, _employees[i], payment.recipient);
            }
            if (payment.amount == 0) revert ZeroSalary(payment.recipient);
            if (payment.amount > type(uint128).max) revert AmountTooLarge(payment.recipient);

            uint128 amount128 = uint128(payment.amount);

            payrollToken.approve(address(sablier), amount128);

            uint256 streamId = sablier.createWithDurationsLL(
                SablierCreateWithDurations({
                    sender: address(this),
                    recipient: payment.recipient,
                    totalAmount: amount128,
                    token: payrollToken,
                    cancelable: true,
                    transferable: false,
                    shape: "nomos-payroll",
                    broker: SablierBroker({account: address(0), fee: 0})
                }),
                LockupLinear.UnlockAmounts({start: 0, cliff: 0}),
                LockupLinear.Durations({cliff: policy.cliffDuration, total: policy.streamDuration})
            );

            ebool matchesLedger = Nox.eq(Nox.toEuint256(payment.amount), _salaryOf[payment.recipient]);
            Nox.allowPublicDecryption(matchesLedger);
            // No Nox.allowThis needed — this contract never reads matchesLedger again.

            emit PaymentAttested(payment.recipient, streamId, cycleCount, ebool.unwrap(matchesLedger));
        }

        emit CycleExecuted(cycleCount, block.timestamp, len);
    }

    // ============ Views ============

    function getEmployeeSalaryHandle(address recipient) external view returns (euint256) {
        return _salaryOf[recipient];
    }

    function getAggregateOutflowHandle() external view returns (euint256) {
        return _cycleSpendHandle;
    }

    function getWithinCapHandle() external view returns (ebool) {
        return _withinCapHandle;
    }

    function getEmployees() external view returns (address[] memory) {
        return _employees;
    }

    function getAuditors() external view returns (address[] memory) {
        return _auditors;
    }

    // ============ Private helpers ============

    function _recomputeWithinCap() private {
        _withinCapHandle = Nox.le(_cycleSpendHandle, Nox.toEuint256(policy.spendCap));
        Nox.allowPublicDecryption(_withinCapHandle);
    }

    function _regrantAuditors() private {
        uint256 len = _auditors.length;
        for (uint256 i = 0; i < len; i++) {
            Nox.allow(_cycleSpendHandle, _auditors[i]);
        }
    }
}
