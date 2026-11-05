// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Naive, faithful implementation of ERC-8421's IStakingRegistry -
/// no slashing (the spec itself has none: "there are no penalization
/// mechanisms in the alternative mempools protocol and the stake is never
/// slashed"), no admin, purely per-caller stake bookkeeping. Deployed once
/// to the sidecar devnet so StakingRegistryService/FrameTxValidationService's
/// stake-gated code paths can be exercised against a real on-chain stake
/// instead of the AddressZero placeholder's always-zero short-circuit.
contract NaiveStakingRegistry {
    struct Deposit {
        uint256 stake;
        uint32 unstakeDelaySec;
        uint64 withdrawTime;
    }

    mapping(address => Deposit) private deposits;

    /// Locks msg.value as the caller's stake, adding to any existing stake
    /// (ERC-4337 StakeManager convention). Reverts if unstakeDelaySec would
    /// be lowered - raise it via a later call instead. Clears any pending
    /// withdrawal: adding more stake means you're staked again.
    function addStake(uint32 unstakeDelaySec) external payable {
        Deposit storage d = deposits[msg.sender];
        require(unstakeDelaySec >= d.unstakeDelaySec, "cannot decrease unstake delay");
        d.stake += msg.value;
        d.unstakeDelaySec = unstakeDelaySec;
        d.withdrawTime = 0;
    }

    /// Begins the withdrawal delay. From this point getDepositInfo's
    /// withdrawTime is non-zero, so STAKING-010's "withdrawal has not been
    /// initiated" no longer holds - the caller is not staked anymore.
    function unlockStake() external {
        Deposit storage d = deposits[msg.sender];
        require(d.stake > 0, "no stake");
        require(d.withdrawTime == 0, "already unlocking");
        d.withdrawTime = uint64(block.timestamp) + d.unstakeDelaySec;
    }

    /// Withdraws the full stake once the delay has passed. State is zeroed
    /// before the external call (checks-effects-interactions).
    function withdrawStake(address payable withdrawAddress) external {
        Deposit storage d = deposits[msg.sender];
        require(d.withdrawTime != 0, "not unlocked");
        require(block.timestamp >= d.withdrawTime, "delay not elapsed");
        uint256 amount = d.stake;
        d.stake = 0;
        d.withdrawTime = 0;
        (bool success, ) = withdrawAddress.call{value: amount}("");
        require(success, "withdraw failed");
    }

    function getDepositInfo(address account)
        external
        view
        returns (uint256 stake, uint32 unstakeDelaySec, uint64 withdrawTime)
    {
        Deposit storage d = deposits[account];
        return (d.stake, d.unstakeDelaySec, d.withdrawTime);
    }
}
