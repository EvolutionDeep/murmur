// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ContinuityRegistry.sol";

/// @notice Unit tests for ContinuityRegistry — murmur's Proof of Continuous Agency on-chain anchor.
///
///   Run from packages/trader-worker/contracts:
///     forge test --match-path "*ContinuityRegistry*" -vvv
///
///   Coverage:
///     · access control (only committer)
///     · epoch chaining (prevEpochSeal linkage)
///     · seal ordering constraints
///     · isUnbroken boundary conditions
///     · adminAction event field alignment
///     · ZeroHash guards on openEpoch and sealEpoch
contract ContinuityRegistryTest is Test {
    ContinuityRegistry internal reg;
    address internal committer;
    address internal rando;

    // Deterministic test constants
    bytes32 internal constant CODE_0 = bytes32(uint256(0xC0DE));
    bytes32 internal constant CODE_1 = bytes32(uint256(0xC1DE));
    bytes32 internal constant GEN_0  = bytes32(uint256(0x6E0));
    bytes32 internal constant GEN_1  = bytes32(uint256(0x6E1));
    bytes32 internal constant SEAL_0 = bytes32(uint256(0x5EA10));
    bytes32 internal constant SEAL_1 = bytes32(uint256(0x5EA11));
    bytes32 internal constant MERKLE_0 = bytes32(uint256(0xAE4C1E0));
    bytes32 internal constant MERKLE_1 = bytes32(uint256(0xAE4C1E1));

    function setUp() public {
        committer = makeAddr("committer");
        rando = makeAddr("rando");
        reg = new ContinuityRegistry(committer);
    }

    // ═══════════════════════════════ constructor ═══════════════════════════════

    function test_constructor_sets_committer() public view {
        assertEq(reg.committer(), committer);
        assertEq(reg.epochCount(), 0);
    }

    function test_constructor_reverts_on_zero_address() public {
        vm.expectRevert("zero committer");
        new ContinuityRegistry(address(0));
    }

    // ═══════════════════════════════ openEpoch: access ═══════════════════════════════

    function test_openEpoch_only_committer() public {
        vm.prank(rando);
        vm.expectRevert(ContinuityRegistry.NotCommitter.selector);
        reg.openEpoch(CODE_0, GEN_0);
    }

    // ═══════════════════════════════ openEpoch: ZeroHash guard ═══════════════════════════════

    function test_openEpoch_reverts_on_zero_codeCommitment() public {
        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.ZeroHash.selector);
        reg.openEpoch(bytes32(0), GEN_0);
    }

    function test_openEpoch_reverts_on_zero_genesisHead() public {
        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.ZeroHash.selector);
        reg.openEpoch(CODE_0, bytes32(0));
    }

    function test_openEpoch_reverts_on_both_zero() public {
        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.ZeroHash.selector);
        reg.openEpoch(bytes32(0), bytes32(0));
    }

    // ═══════════════════════════════ openEpoch: semantics ═══════════════════════════════

    function test_openEpoch_assigns_sequential_index() public {
        vm.startPrank(committer);
        uint256 idx0 = reg.openEpoch(CODE_0, GEN_0);
        assertEq(idx0, 0);
        assertEq(reg.epochCount(), 1);
        vm.stopPrank();
    }

    function test_openEpoch_epoch0_prevEpochSeal_is_zero() public {
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);

        (,,,,,,, bytes32 prevSeal) = reg.epochs(0);
        assertEq(prevSeal, bytes32(0));
    }

    function test_openEpoch_epoch1_prevEpochSeal_equals_epoch0_sealedHead() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.sealEpoch(0, SEAL_0, 100, MERKLE_0);
        uint256 idx1 = reg.openEpoch(CODE_1, GEN_1);
        vm.stopPrank();

        assertEq(idx1, 1);
        (,,,,,,, bytes32 prevSeal) = reg.epochs(1);
        assertEq(prevSeal, SEAL_0);
    }

    function test_openEpoch_stores_correct_fields() public {
        vm.warp(1000);
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);

        (bytes32 code, bytes32 gen, bytes32 sHead, uint64 startTs, uint64 endTs, uint64 ticks, bytes32 merkle, bytes32 prevSeal) = reg.epochs(0);
        assertEq(code, CODE_0);
        assertEq(gen, GEN_0);
        assertEq(sHead, bytes32(0));
        assertEq(startTs, 1000);
        assertEq(endTs, 0);
        assertEq(ticks, 0);
        assertEq(merkle, bytes32(0));
        assertEq(prevSeal, bytes32(0));
    }

    function test_openEpoch_emits_event() public {
        vm.warp(5000);
        vm.expectEmit(true, false, false, true);
        emit ContinuityRegistry.EpochOpened(0, CODE_0, GEN_0, 5000);
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);
    }

    // ═══════════════════════════════ sealEpoch: access ═══════════════════════════════

    function test_sealEpoch_only_committer() public {
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);

        vm.prank(rando);
        vm.expectRevert(ContinuityRegistry.NotCommitter.selector);
        reg.sealEpoch(0, SEAL_0, 50, MERKLE_0);
    }

    // ═══════════════════════════════ sealEpoch: ZeroHash guard ═══════════════════════════════

    function test_sealEpoch_reverts_on_zero_sealedHead() public {
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);

        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.ZeroHash.selector);
        reg.sealEpoch(0, bytes32(0), 50, MERKLE_0);
    }

    function test_sealEpoch_reverts_on_zero_merkleRoot() public {
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);

        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.ZeroHash.selector);
        reg.sealEpoch(0, SEAL_0, 50, bytes32(0));
    }

    // ═══════════════════════════════ sealEpoch: ordering ═══════════════════════════════

    function test_sealEpoch_reverts_on_unopened_epoch() public {
        // No epochs opened at all — index 0 does not exist.
        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.EpochNotOpen.selector);
        reg.sealEpoch(0, SEAL_0, 50, MERKLE_0);
    }

    function test_sealEpoch_reverts_on_out_of_range_index() public {
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);

        // Index 5 was never opened.
        vm.prank(committer);
        vm.expectRevert(ContinuityRegistry.EpochNotOpen.selector);
        reg.sealEpoch(5, SEAL_0, 50, MERKLE_0);
    }

    function test_sealEpoch_reverts_on_duplicate_seal() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.sealEpoch(0, SEAL_0, 50, MERKLE_0);

        vm.expectRevert(ContinuityRegistry.AlreadySealed.selector);
        reg.sealEpoch(0, SEAL_1, 60, MERKLE_1);
        vm.stopPrank();
    }

    function test_sealEpoch_reverts_BadEpochIndex_when_not_latest() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.openEpoch(CODE_1, GEN_1);

        // epochCount == 2, so only index 1 (the latest) can be sealed.
        vm.expectRevert(ContinuityRegistry.BadEpochIndex.selector);
        reg.sealEpoch(0, SEAL_0, 50, MERKLE_0);
        vm.stopPrank();
    }

    function test_sealEpoch_in_order_succeeds() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.openEpoch(CODE_1, GEN_1);

        // Seal the latest (index 1) — valid.
        reg.sealEpoch(1, SEAL_1, 80, MERKLE_1);

        (,,bytes32 sHead1, ,uint64 endTs1, uint64 ticks1, bytes32 merkle1,) = reg.epochs(1);
        assertEq(sHead1, SEAL_1);
        assertGt(endTs1, 0);
        assertEq(ticks1, 80);
        assertEq(merkle1, MERKLE_1);
        vm.stopPrank();
    }

    function test_sealEpoch_emits_event() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        vm.warp(9999);
        vm.expectEmit(true, false, false, true);
        emit ContinuityRegistry.EpochSealed(0, SEAL_0, 42, MERKLE_0, 9999);
        reg.sealEpoch(0, SEAL_0, 42, MERKLE_0);
        vm.stopPrank();
    }

    // ═══════════════════════════════ currentEpoch ═══════════════════════════════

    function test_currentEpoch_reverts_when_no_epochs() public {
        vm.expectRevert(ContinuityRegistry.BadEpochIndex.selector);
        reg.currentEpoch();
    }

    function test_currentEpoch_returns_latest_index() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        assertEq(reg.currentEpoch(), 0);
        reg.openEpoch(CODE_1, GEN_1);
        assertEq(reg.currentEpoch(), 1);
        vm.stopPrank();
    }

    // ═══════════════════════════════ isUnbroken ═══════════════════════════════

    function test_isUnbroken_true_on_complete_chain() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.sealEpoch(0, SEAL_0, 100, MERKLE_0);
        reg.openEpoch(CODE_1, GEN_1);
        reg.sealEpoch(1, SEAL_1, 200, MERKLE_1);
        vm.stopPrank();

        assertTrue(reg.isUnbroken(0, 0));
        assertTrue(reg.isUnbroken(0, 1));
        assertTrue(reg.isUnbroken(1, 1));
    }

    function test_isUnbroken_false_when_from_greater_than_to() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.sealEpoch(0, SEAL_0, 100, MERKLE_0);
        reg.openEpoch(CODE_1, GEN_1);
        reg.sealEpoch(1, SEAL_1, 200, MERKLE_1);
        vm.stopPrank();

        assertFalse(reg.isUnbroken(1, 0));
        assertFalse(reg.isUnbroken(5, 3));
    }

    function test_isUnbroken_false_when_to_exceeds_epochCount() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.sealEpoch(0, SEAL_0, 100, MERKLE_0);
        vm.stopPrank();

        assertFalse(reg.isUnbroken(0, 1));
        assertFalse(reg.isUnbroken(0, 99));
    }

    function test_isUnbroken_false_when_epoch_not_sealed() public {
        vm.prank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        // Epoch 0 is opened but NOT sealed — sealedHead == 0.
        assertFalse(reg.isUnbroken(0, 0));
    }

    function test_isUnbroken_true_for_single_sealed_epoch_zero() public {
        vm.startPrank(committer);
        reg.openEpoch(CODE_0, GEN_0);
        reg.sealEpoch(0, SEAL_0, 50, MERKLE_0);
        vm.stopPrank();

        assertTrue(reg.isUnbroken(0, 0));
    }

    // ═══════════════════════════════ adminAction ═══════════════════════════════

    function test_adminAction_only_committer() public {
        vm.prank(rando);
        vm.expectRevert(ContinuityRegistry.NotCommitter.selector);
        reg.adminAction(1, bytes32(uint256(0xABCD)));
    }

    function test_adminAction_emits_correct_event() public {
        uint8 kind = 3; // PARAM_OVERRIDE
        bytes32 payload = bytes32(uint256(0xDEAD));
        vm.warp(7777);

        vm.expectEmit(true, false, false, true);
        emit ContinuityRegistry.AdminAction(kind, committer, payload, 7777);

        vm.prank(committer);
        reg.adminAction(kind, payload);
    }

    function test_adminAction_all_kinds_emit() public {
        vm.startPrank(committer);
        for (uint8 k = 1; k <= 7; k++) {
            bytes32 h = keccak256(abi.encodePacked(k));
            vm.expectEmit(true, false, false, true);
            emit ContinuityRegistry.AdminAction(k, committer, h, uint64(block.timestamp));
            reg.adminAction(k, h);
        }
        vm.stopPrank();
    }

    // ═══════════════════════════════ integration: multi-epoch chain ═══════════════════════════════

    function test_multi_epoch_chain_continuity() public {
        // Open and seal 5 epochs, verifying chain linkage at each step.
        bytes32 prevSeal = bytes32(0);
        vm.startPrank(committer);
        for (uint256 i = 0; i < 5; i++) {
            bytes32 code = keccak256(abi.encodePacked("code", i));
            bytes32 gen = keccak256(abi.encodePacked("gen", i));
            reg.openEpoch(code, gen);

            // Verify prevEpochSeal linkage.
            (,,,,,,, bytes32 stored) = reg.epochs(i);
            assertEq(stored, prevSeal);

            bytes32 seal = keccak256(abi.encodePacked("seal", i));
            bytes32 merkle = keccak256(abi.encodePacked("merkle", i));
            reg.sealEpoch(i, seal, uint64(i * 100 + 1), merkle);
            prevSeal = seal;

            // isUnbroken should hold for the entire range so far.
            assertTrue(reg.isUnbroken(0, i));
        }
        vm.stopPrank();

        assertEq(reg.epochCount(), 5);
    }
}
