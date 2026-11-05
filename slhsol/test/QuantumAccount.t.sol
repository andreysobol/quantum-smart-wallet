// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {QuantumAccount} from "../src/QuantumAccount.sol";
import {FrameTxSupport} from "../src/FrameTxSupport.sol";
import {SlhDsaVerifier} from "../src/SlhDsaSha2_128s.sol";
import {AccountVector} from "./AccountVector.sol";

/// Only exposes fixed helper addresses so ordinary Foundry can mock native
/// opcode results. Validation and cryptographic verification remain production code.
contract QuantumAccountHarness is QuantumAccount {
    constructor(bytes32 key, address verifier_, address registry, uint256 stake, uint32 delay)
        payable
        QuantumAccount(key, verifier_, registry, stake, delay)
    {}

    function helpers() external view returns (address, address, address, address, address) {
        return (_TX_PARAM_HELPER, _FRAME_PARAM_HELPER, _SIG_PARAM_HELPER, _SIG_DATA_COPY_HELPER, _APPROVE_HELPER);
    }
}

contract AccountTestStakingRegistry {
    mapping(address => uint256) public stakes;
    mapping(address => uint32) public delays;

    function addStake(uint32 delay) external payable {
        stakes[msg.sender] += msg.value;
        delays[msg.sender] = delay;
    }
}

contract AccountTestRejectingRegistry {
    error StakeRejected();

    function addStake(uint32) external payable {
        revert StakeRejected();
    }
}

contract QuantumAccountTest is Test {
    QuantumAccountHarness internal account;
    SlhDsaVerifier internal verifier;
    address internal txHelper;
    address internal frameHelper;
    address internal sigHelper;
    address internal sigDataHelper;
    address internal approveHelper;

    address internal constant ENTRY_POINT = address(0xaa);
    uint256 internal constant SIGNATURE_LENGTH = 7856;

    event PublicKeyRotated(bytes32 indexed previousKey, bytes32 indexed newKey);

    function setUp() public {
        verifier = new SlhDsaVerifier();
        account = new QuantumAccountHarness(AccountVector.PUBLIC_KEY, address(verifier), address(0), 0, 0);
        (txHelper, frameHelper, sigHelper, sigDataHelper, approveHelper) = account.helpers();
    }

    function test_fixtureMatchesAccountSigningDomain() public view {
        assertTrue(
            verifier.verify(
                abi.encodePacked(AccountVector.PUBLIC_KEY),
                abi.encodePacked(AccountVector.DIGEST),
                account.SIGNING_CONTEXT(),
                AccountVector.signature()
            )
        );
        assertEq(account.publicKey(), AccountVector.PUBLIC_KEY);
        assertEq(address(account.VERIFIER()), address(verifier));
    }

    function test_validSelfPaymentApprovesExactScope() public {
        _mockValidFrame(3);
        vm.expectCall(approveHelper, abi.encode(uint256(3)));
        _validate();
    }

    function test_validSponsoredExecutionApprovesExactScope() public {
        _mockValidFrame(2);
        vm.expectCall(approveHelper, abi.encode(uint256(2)));
        _validate();
    }

    function test_rejectUnauthorizedCallerBeforeNativeReads() public {
        vm.expectRevert(QuantumAccount.UnauthorizedCaller.selector);
        account.validateFrame();
    }

    function test_ordinaryEvmFailsClosedWithoutNativeMocks() public {
        vm.expectRevert(abi.encodeWithSelector(FrameTxSupport.NativeOpcodeFailed.selector, uint8(0xb0)));
        vm.prank(ENTRY_POINT);
        account.validateFrame{gas: 200_000}();
    }

    function test_rejectWrongTransactionType() public {
        _mockValidFrame(3);
        _tx(0, 2);
        _expectValidationFailure(QuantumAccount.InvalidFrameContext.selector);
    }

    function test_rejectWrongSender() public {
        _mockValidFrame(3);
        _tx(2, uint256(uint160(address(0xbeef))));
        _expectValidationFailure(QuantumAccount.InvalidFrameContext.selector);
    }

    function test_rejectWrongCurrentFrameTarget() public {
        _mockValidFrame(3);
        _frame(0, 0, uint256(uint160(address(0xbeef))));
        _expectValidationFailure(QuantumAccount.InvalidFrameContext.selector);
    }

    function test_rejectExecutionFrameMode() public {
        _mockValidFrame(3);
        _frame(0, 2, 2);
        _expectValidationFailure(QuantumAccount.InvalidFrameContext.selector);
    }

    function test_rejectDefaultFrameMode() public {
        _mockValidFrame(3);
        _frame(0, 2, 0);
        _expectValidationFailure(QuantumAccount.InvalidFrameContext.selector);
    }

    function test_readsActualCurrentFrameRatherThanFrameZero() public {
        _mockValidFrame(3);
        _tx(0x0a, 4);
        _frame(4, 0, uint256(uint160(address(account))));
        _frame(4, 2, 1);
        _frame(4, 3, 2);
        _frame(0, 0, uint256(uint160(address(0xbeef))));
        vm.expectCall(approveHelper, abi.encode(uint256(2)));
        _validate();
    }

    function testFuzz_rejectApprovalFlagsOtherThanExecutionScopes(uint256 scope) public {
        vm.assume(scope != 2 && scope != 3);
        _mockValidFrame(3);
        _frame(0, 3, scope);
        _expectValidationFailure(QuantumAccount.InvalidApprovalScope.selector);
    }

    function test_rejectMissingSignatureEntry() public {
        _mockValidFrame(3);
        _tx(0x0b, 0);
        _expectValidationFailure(QuantumAccount.InvalidSignatureEntry.selector);
    }

    function test_rejectProtocolSignatureScheme() public {
        _mockValidFrame(3);
        _sig(1, 1);
        _expectValidationFailure(QuantumAccount.InvalidSignatureEntry.selector);
    }

    function test_rejectExplicitSignatureMessage() public {
        _mockValidFrame(3);
        _sig(2, uint256(AccountVector.DIGEST));
        _expectValidationFailure(QuantumAccount.InvalidSignatureEntry.selector);
    }

    function testFuzz_rejectWrongDeclaredSignatureLength(uint256 length) public {
        vm.assume(length != SIGNATURE_LENGTH);
        _mockValidFrame(3);
        _sig(3, length);
        _expectValidationFailure(QuantumAccount.InvalidSignatureLength.selector);
    }

    function test_rejectChangedTransactionDigest() public {
        _mockValidFrame(3);
        _tx(8, uint256(AccountVector.DIGEST) ^ 1);
        _expectValidationFailure(QuantumAccount.InvalidSignature.selector);
    }

    function test_rejectChangedSignature() public {
        _mockValidFrame(3);
        bytes memory signature = AccountVector.signature();
        signature[0] ^= 0x01;
        vm.mockCall(sigDataHelper, abi.encode(uint256(0), SIGNATURE_LENGTH, uint256(0)), signature);
        _expectValidationFailure(QuantumAccount.InvalidSignature.selector);
    }

    function test_rejectChangedStoredKey() public {
        _mockValidFrame(3);
        vm.prank(address(account));
        account.rotateKey(AccountVector.PUBLIC_KEY ^ bytes32(uint256(1)));
        _expectValidationFailure(QuantumAccount.InvalidSignature.selector);
    }

    function test_verifierRevertFailsClosed() public {
        _mockValidFrame(3);
        bytes memory failure = abi.encodeWithSignature("VerifierUnavailable()");
        vm.mockCallRevert(address(verifier), abi.encodeWithSelector(SlhDsaVerifier.verify.selector), failure);
        vm.expectRevert(failure);
        _validate();
    }

    function test_malformedVerifierReturnDataFailsClosed() public {
        _mockValidFrame(3);
        bytes memory input = abi.encodeWithSelector(SlhDsaVerifier.verify.selector);
        vm.mockCall(address(verifier), input, "");
        vm.expectRevert();
        _validate();

        // A full ABI word still cannot encode a boolean other than 0 or 1.
        vm.mockCall(address(verifier), input, abi.encode(uint256(2)));
        vm.expectRevert();
        _validate();
    }

    function test_rejectTxParamHelperFailure() public {
        _mockValidFrame(3);
        vm.mockCallRevert(txHelper, abi.encode(uint256(0)), hex"1234");
        vm.expectRevert(abi.encodeWithSelector(FrameTxSupport.NativeOpcodeFailed.selector, uint8(0xb0)));
        _validate();
    }

    function test_rejectFrameParamHelperFailure() public {
        _mockValidFrame(3);
        vm.mockCallRevert(frameHelper, abi.encode(uint256(0), uint256(0)), hex"1234");
        vm.expectRevert(abi.encodeWithSelector(FrameTxSupport.NativeOpcodeFailed.selector, uint8(0xb3)));
        _validate();
    }

    function test_rejectSignatureParamHelperFailure() public {
        _mockValidFrame(3);
        vm.mockCallRevert(sigHelper, abi.encode(uint256(0), uint256(1)), hex"1234");
        vm.expectRevert(abi.encodeWithSelector(FrameTxSupport.NativeOpcodeFailed.selector, uint8(0xb4)));
        _validate();
    }

    function test_rejectMalformedWordFromNativeHelper() public {
        _mockValidFrame(3);
        vm.mockCall(txHelper, abi.encode(uint256(0)), hex"06");
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameTxSupport.InvalidNativeReturnLength.selector, uint8(0xb0), uint256(32), uint256(1)
            )
        );
        _validate();
    }

    function test_rejectSignatureCopyHelperFailure() public {
        _mockValidFrame(3);
        vm.mockCallRevert(sigDataHelper, abi.encode(uint256(0), SIGNATURE_LENGTH, uint256(0)), hex"1234");
        vm.expectRevert(abi.encodeWithSelector(FrameTxSupport.NativeOpcodeFailed.selector, uint8(0xb5)));
        _validate();
    }

    function test_rejectTruncatedNativeSignatureOutput() public {
        _mockValidFrame(3);
        vm.mockCall(sigDataHelper, abi.encode(uint256(0), SIGNATURE_LENGTH, uint256(0)), new bytes(7855));
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameTxSupport.InvalidNativeReturnLength.selector, uint8(0xb5), SIGNATURE_LENGTH, uint256(7855)
            )
        );
        _validate();
    }

    function test_rejectPaddedNativeSignatureOutput() public {
        _mockValidFrame(3);
        vm.mockCall(sigDataHelper, abi.encode(uint256(0), SIGNATURE_LENGTH, uint256(0)), new bytes(7857));
        vm.expectRevert(
            abi.encodeWithSelector(
                FrameTxSupport.InvalidNativeReturnLength.selector, uint8(0xb5), SIGNATURE_LENGTH, uint256(7857)
            )
        );
        _validate();
    }

    function test_rejectApproveHelperFailure() public {
        _mockValidFrame(3);
        vm.mockCallRevert(approveHelper, abi.encode(uint256(3)), hex"1234");
        vm.expectRevert(abi.encodeWithSelector(FrameTxSupport.NativeOpcodeFailed.selector, uint8(0xaa)));
        _validate();
    }

    function test_acceptsEthWithoutFrameContext() public {
        vm.deal(address(this), 2 ether);
        (bool success,) = address(account).call{value: 1 ether}("");
        assertTrue(success);
        assertEq(address(account).balance, 1 ether);
    }

    function test_keyRotationEmitsAndReplacesCurrentKey() public {
        bytes32 newKey = bytes32(uint256(0xbeef));
        vm.expectEmit(true, true, false, false, address(account));
        emit PublicKeyRotated(AccountVector.PUBLIC_KEY, newKey);
        vm.prank(address(account));
        account.rotateKey(newKey);
        assertEq(account.publicKey(), newKey);
    }

    function test_oldKeySignatureFailsAfterRotation() public {
        _mockValidFrame(3);
        _validate();
        vm.prank(address(account));
        account.rotateKey(bytes32(uint256(0xbeef)));
        _expectValidationFailure(QuantumAccount.InvalidSignature.selector);
    }

    function test_externalCallerCannotRotateKey() public {
        vm.expectRevert(QuantumAccount.UnauthorizedCaller.selector);
        account.rotateKey(bytes32(uint256(0xbeef)));
        assertEq(account.publicKey(), AccountVector.PUBLIC_KEY);
    }

    function test_entryPointCannotDirectlyRotateKey() public {
        vm.prank(ENTRY_POINT);
        vm.expectRevert(QuantumAccount.UnauthorizedCaller.selector);
        account.rotateKey(bytes32(uint256(0xbeef)));
    }

    function test_rejectZeroReplacementKey() public {
        vm.prank(address(account));
        vm.expectRevert(QuantumAccount.InvalidPublicKey.selector);
        account.rotateKey(bytes32(0));
    }

    function test_rejectZeroInitialKey() public {
        vm.expectRevert(QuantumAccount.InvalidPublicKey.selector);
        new QuantumAccount(bytes32(0), address(verifier), address(0), 0, 0);
    }

    function test_rejectZeroVerifier() public {
        vm.expectRevert(QuantumAccount.InvalidVerifier.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(0), address(0), 0, 0);
    }

    function test_rejectVerifierWithoutCode() public {
        vm.expectRevert(QuantumAccount.InvalidVerifier.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(0xbeef), address(0), 0, 0);
    }

    function test_constructorStakesTheAccountAndLeavesSpendableEth() public {
        AccountTestStakingRegistry registry = new AccountTestStakingRegistry();
        vm.deal(address(this), 2 ether);
        QuantumAccount staked = new QuantumAccount{value: 2 ether}(
            AccountVector.PUBLIC_KEY, address(verifier), address(registry), 1 ether, 1 days
        );
        assertEq(registry.stakes(address(staked)), 1 ether);
        assertEq(registry.stakes(address(this)), 0);
        assertEq(registry.delays(address(staked)), 1 days);
        assertEq(address(registry).balance, 1 ether);
        assertEq(address(staked).balance, 1 ether);
    }

    function test_constructorStakeFailureRollsBackFunds() public {
        AccountTestRejectingRegistry registry = new AccountTestRejectingRegistry();
        vm.deal(address(this), 2 ether);
        vm.expectRevert(AccountTestRejectingRegistry.StakeRejected.selector);
        new QuantumAccount{value: 2 ether}(
            AccountVector.PUBLIC_KEY, address(verifier), address(registry), 1 ether, 1 days
        );
        assertEq(address(this).balance, 2 ether);
        assertEq(address(registry).balance, 0);
    }

    function test_rejectRegistryWhenStakeIsZero() public {
        AccountTestStakingRegistry registry = new AccountTestStakingRegistry();
        vm.expectRevert(QuantumAccount.InvalidStakeConfiguration.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(verifier), address(registry), 0, 0);
    }

    function test_rejectUnstakeDelayWhenStakeIsZero() public {
        vm.expectRevert(QuantumAccount.InvalidStakeConfiguration.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(verifier), address(0), 0, 1 days);
    }

    function test_rejectStakeRegistryWithoutCode() public {
        vm.expectRevert(QuantumAccount.InvalidStakeConfiguration.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(verifier), address(0xbeef), 1 ether, 1 days);
    }

    function test_rejectStakeDelayBelowOneDay() public {
        AccountTestStakingRegistry registry = new AccountTestStakingRegistry();
        vm.expectRevert(QuantumAccount.InvalidStakeConfiguration.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(verifier), address(registry), 1 ether, 1 days - 1);
    }

    function test_rejectInsufficientStakeFunding() public {
        AccountTestStakingRegistry registry = new AccountTestStakingRegistry();
        vm.expectRevert(QuantumAccount.InsufficientDeploymentValue.selector);
        new QuantumAccount(AccountVector.PUBLIC_KEY, address(verifier), address(registry), 1 ether, 1 days);
    }

    function _mockValidFrame(uint256 scope) internal {
        _tx(0, 6);
        _tx(2, uint256(uint160(address(account))));
        _tx(0x0a, 0);
        _tx(0x0b, 1);
        _tx(8, uint256(AccountVector.DIGEST));
        _frame(0, 0, uint256(uint160(address(account))));
        _frame(0, 2, 1);
        _frame(0, 3, scope);
        _sig(1, 0);
        _sig(2, 0);
        _sig(3, SIGNATURE_LENGTH);
        vm.mockCall(sigDataHelper, abi.encode(uint256(0), SIGNATURE_LENGTH, uint256(0)), AccountVector.signature());
        vm.mockCall(approveHelper, abi.encode(uint256(2)), "");
        vm.mockCall(approveHelper, abi.encode(uint256(3)), "");
    }

    function _tx(uint256 param, uint256 value) internal {
        vm.mockCall(txHelper, abi.encode(param), abi.encode(value));
    }

    function _frame(uint256 index, uint256 param, uint256 value) internal {
        vm.mockCall(frameHelper, abi.encode(index, param), abi.encode(value));
    }

    function _sig(uint256 param, uint256 value) internal {
        vm.mockCall(sigHelper, abi.encode(uint256(0), param), abi.encode(value));
    }

    function _validate() internal {
        vm.prank(ENTRY_POINT);
        account.validateFrame();
    }

    function _expectValidationFailure(bytes4 selector) internal {
        vm.expectRevert(selector);
        _validate();
    }
}
