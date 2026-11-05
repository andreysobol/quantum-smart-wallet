// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Returns a fixed opcode adapter as runtime code. It has no mutable state.
contract FrameTxOpcode {
    constructor(bytes memory runtime) {
        assembly ("memory-safe") {
            return(add(runtime, 0x20), mload(runtime))
        }
    }
}

/// @dev EIP-8141 opcodes for the Mumbai ethrex `9aa3645d` profile.
/// Stock Solidity does not emit these instructions. Like the workshop's
/// HegotaSupport, reads use STATICCALL and APPROVE uses DELEGATECALL so ADDRESS
/// remains the account. The helpers are fixed at construction, never supplied by
/// a caller, and have no storage, upgrade or self-destruct mechanism.
///
/// Runtime mnemonics, in stack push order (top operand pushed last):
/// TXPARAM:      CALLDATALOAD(0), TXPARAM, MSTORE(0), RETURN(0,32)
/// FRAMEPARAM:   CALLDATALOAD(32), CALLDATALOAD(0), FRAMEPARAM, MSTORE(0), RETURN(0,32)
/// SIGPARAM:     CALLDATALOAD(32), CALLDATALOAD(0), SIGPARAM, MSTORE(0), RETURN(0,32)
/// SIGDATACOPY:  CALLDATALOAD(64), CALLDATALOAD(32), CALLDATALOAD(0), 0,
///               SIGDATACOPY, RETURN(0,CALLDATALOAD(32))
/// APPROVE:      CALLDATALOAD(0), 0, 0, APPROVE
///
/// Reference: github.com/forshtat/hegota-support and the pinned ethrex opcode
/// handlers. These bytecodes intentionally fail on ordinary EVMs without 8141.
abstract contract FrameTxSupport {
    address internal immutable _TX_PARAM_HELPER;
    address internal immutable _FRAME_PARAM_HELPER;
    address internal immutable _SIG_PARAM_HELPER;
    address internal immutable _SIG_DATA_COPY_HELPER;
    address internal immutable _APPROVE_HELPER;

    error NativeOpcodeFailed(uint8 opcode);
    error InvalidNativeReturnLength(uint8 opcode, uint256 expected, uint256 actual);

    constructor() {
        _TX_PARAM_HELPER = address(new FrameTxOpcode(hex"600035b060005260206000f3"));
        _FRAME_PARAM_HELPER = address(new FrameTxOpcode(hex"602035600035b360005260206000f3"));
        _SIG_PARAM_HELPER = address(new FrameTxOpcode(hex"602035600035b460005260206000f3"));
        _SIG_DATA_COPY_HELPER = address(new FrameTxOpcode(hex"6040356020356000356000b56020356000f3"));
        _APPROVE_HELPER = address(new FrameTxOpcode(hex"600035600080aa"));
    }

    function _txParam(uint256 param) internal view returns (uint256) {
        return _readWord(_TX_PARAM_HELPER, abi.encode(param), 0xb0);
    }

    function _frameParam(uint256 index, uint256 param) internal view returns (uint256) {
        return _readWord(_FRAME_PARAM_HELPER, abi.encode(index, param), 0xb3);
    }

    function _sigParam(uint256 index, uint256 param) internal view returns (uint256) {
        return _readWord(_SIG_PARAM_HELPER, abi.encode(index, param), 0xb4);
    }

    function _signatureData(uint256 index, uint256 length) internal view returns (bytes memory data) {
        bool success;
        (success, data) = _SIG_DATA_COPY_HELPER.staticcall(abi.encode(uint256(0), length, index));
        if (!success) revert NativeOpcodeFailed(0xb5);
        if (data.length != length) revert InvalidNativeReturnLength(0xb5, length, data.length);
    }

    function _approve(uint256 scope) internal {
        (bool success,) = _APPROVE_HELPER.delegatecall(abi.encode(scope));
        if (!success) revert NativeOpcodeFailed(0xaa);
    }

    function _readWord(address helper, bytes memory input, uint8 opcode) private view returns (uint256) {
        (bool success, bytes memory data) = helper.staticcall(input);
        if (!success) revert NativeOpcodeFailed(opcode);
        if (data.length != 32) revert InvalidNativeReturnLength(opcode, 32, data.length);
        return abi.decode(data, (uint256));
    }
}
