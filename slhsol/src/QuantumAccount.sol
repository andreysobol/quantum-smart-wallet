// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {FrameTxSupport} from "./FrameTxSupport.sol";

interface ISlhDsaVerifier {
    function verify(bytes calldata pk, bytes calldata message, bytes calldata ctx, bytes calldata sig)
        external
        view
        returns (bool);
}

interface IStakingRegistry {
    function addStake(uint32 unstakeDelaySec) external payable;
}

/// @title Native post-quantum account for EIP-8141 frame transactions.
/// @notice SLH-DSA-SHA2-128s authorizes the complete native transaction envelope.
/// Execution uses SENDER frames; no owner EOA or relayer has spending authority.
/// @dev Targets the Mumbai ethrex 9aa3645d devnet, not an arbitrary 8141 draft.
/// The protocol handles nonces. ARBITRARY signature entry 0 is the PQ witness.
contract QuantumAccount is FrameTxSupport {
    address public constant NATIVE_ENTRY_POINT = address(0xaa);
    uint256 public constant SIGNATURE_LENGTH = 7856;
    bytes public constant SIGNING_CONTEXT = "QuantumSmartWallet/SLH-DSA-SHA2-128s/v1";

    uint256 private constant TX_TYPE = 0x00;
    uint256 private constant TX_SENDER = 0x02;
    uint256 private constant TX_SIG_HASH = 0x08;
    uint256 private constant TX_CURRENT_FRAME = 0x0a;
    uint256 private constant TX_SIGNATURE_COUNT = 0x0b;
    uint256 private constant FRAME_TARGET = 0x00;
    uint256 private constant FRAME_MODE = 0x02;
    uint256 private constant FRAME_FLAGS = 0x03;
    uint256 private constant SIG_SCHEME = 0x01;
    uint256 private constant SIG_MESSAGE = 0x02;
    uint256 private constant SIG_LENGTH = 0x03;
    uint256 private constant EXECUTION = 2;
    uint256 private constant EXECUTION_AND_PAYMENT = 3;

    ISlhDsaVerifier public immutable VERIFIER;
    /// @notice Raw PK.seed || PK.root, not the CLI's algorithm-prefixed key file.
    bytes32 public publicKey;

    error InvalidPublicKey();
    error InvalidVerifier();
    error UnauthorizedCaller();
    error InvalidFrameContext();
    error InvalidApprovalScope();
    error InvalidSignatureEntry();
    error InvalidSignatureLength();
    error InvalidSignature();
    error InvalidStakeConfiguration();
    error InsufficientDeploymentValue();

    event PublicKeyRotated(bytes32 indexed previousKey, bytes32 indexed newKey);

    /// @param initialPublicKey Raw 32-byte SLH-DSA-SHA2-128s public key.
    /// @param verifierAddress The stateless SlhDsaVerifier deployed from this repository.
    /// @param stakingRegistry Optional registry, or zero when initialStake is zero.
    /// @param initialStake Stake taken from msg.value; the remainder stays spendable.
    /// @param unstakeDelaySec At least one day when initialStake is nonzero.
    constructor(
        bytes32 initialPublicKey,
        address verifierAddress,
        address stakingRegistry,
        uint256 initialStake,
        uint32 unstakeDelaySec
    ) payable {
        if (initialPublicKey == bytes32(0)) revert InvalidPublicKey();
        if (verifierAddress.code.length == 0) revert InvalidVerifier();
        publicKey = initialPublicKey;
        VERIFIER = ISlhDsaVerifier(verifierAddress);
        emit PublicKeyRotated(bytes32(0), initialPublicKey);

        if (initialStake == 0) {
            if (stakingRegistry != address(0) || unstakeDelaySec != 0) revert InvalidStakeConfiguration();
        } else {
            if (stakingRegistry.code.length == 0 || unstakeDelaySec < 1 days) {
                revert InvalidStakeConfiguration();
            }
            if (msg.value < initialStake) revert InsufficientDeploymentValue();
            // The registry credits this account, not its deployer. This breaks
            // the cycle where expensive PQ validation needs stake to add stake.
            IStakingRegistry(stakingRegistry).addStake{value: initialStake}(unstakeDelaySec);
        }
    }

    receive() external payable {}

    /// @notice Call this selector in the account's VERIFY frame, with flags 2
    /// (execution; a later paymaster pays) or 3 (execution and self-payment).
    /// @dev No digest or witness is accepted in calldata. Both are read from
    /// the native envelope, preventing unchecked execution frames and the
    /// circular hash dependency caused by signatures in frame calldata.
    function validateFrame() external {
        if (msg.sender != NATIVE_ENTRY_POINT) revert UnauthorizedCaller();
        if (_txParam(TX_TYPE) != 0x06 || _txParam(TX_SENDER) != uint256(uint160(address(this)))) {
            revert InvalidFrameContext();
        }
        uint256 index = _txParam(TX_CURRENT_FRAME);
        if (_frameParam(index, FRAME_TARGET) != uint256(uint160(address(this))) || _frameParam(index, FRAME_MODE) != 1)
        {
            revert InvalidFrameContext();
        }
        uint256 scope = _frameParam(index, FRAME_FLAGS);
        if (scope != EXECUTION && scope != EXECUTION_AND_PAYMENT) revert InvalidApprovalScope();
        if (_txParam(TX_SIGNATURE_COUNT) == 0 || _sigParam(0, SIG_SCHEME) != 0 || _sigParam(0, SIG_MESSAGE) != 0) {
            revert InvalidSignatureEntry();
        }
        if (_sigParam(0, SIG_LENGTH) != SIGNATURE_LENGTH) revert InvalidSignatureLength();

        bytes memory signature = _signatureData(0, SIGNATURE_LENGTH);
        bytes32 digest = bytes32(_txParam(TX_SIG_HASH));
        // The verifier applies pure FIPS-205 framing. Do not frame the message
        // twice, sign a hex string, or substitute HashSLH-DSA here.
        if (!VERIFIER.verify(abi.encodePacked(publicKey), abi.encodePacked(digest), SIGNING_CONTEXT, signature)) {
            revert InvalidSignature();
        }
        _approve(scope);
    }

    /// @notice Rotate via a SENDER frame targeting this account. The transaction
    /// must first validate under the current public key.
    function rotateKey(bytes32 newPublicKey) external {
        if (msg.sender != address(this)) revert UnauthorizedCaller();
        if (newPublicKey == bytes32(0)) revert InvalidPublicKey();
        bytes32 previousKey = publicKey;
        publicKey = newPublicKey;
        emit PublicKeyRotated(previousKey, newPublicKey);
    }
}
