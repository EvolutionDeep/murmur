// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../ConnectomeLineage.sol";

/// @notice Unit + invariant tests for ConnectomeLineage (the breeding-market ancestry log).
contract ConnectomeLineageTest is Test {
    ConnectomeLineage reg;
    address committer = address(0xBEEF);
    address breeder = address(0xCAFE);
    address stranger = address(0xDEAD);

    // Mirror the contract's public op constants as local literals. Calling reg.OP_GENESIS() inline inside a
    // pranked commit()'s argument list is itself an external staticcall that CONSUMES the prank (and any armed
    // expectRevert) before commit() runs — the classic Foundry gotcha that made every commit here execute as the
    // test contract (=> NotCommitter). testOpConstants() pins these mirrors to the live on-chain values.
    uint8 constant OP_GENESIS = 0;
    uint8 constant OP_MUTATE = 1;
    uint8 constant OP_CROSS = 2;

    bytes32 constant GEN_A = bytes32(uint256(0xA1));
    bytes32 constant GEN_B = bytes32(uint256(0xB2));
    bytes32 constant CHILD_MUT = bytes32(uint256(0xC3));
    bytes32 constant CHILD_CROSS = bytes32(uint256(0xC4));

    function setUp() public {
        reg = new ConnectomeLineage(committer);
    }

    /// @notice The local op mirrors must equal the contract's public constants, so the literals used in the
    ///         pranked commit() calls below can never drift from the deployed values.
    function testOpConstants() public view {
        assertEq(reg.OP_GENESIS(), OP_GENESIS);
        assertEq(reg.OP_MUTATE(), OP_MUTATE);
        assertEq(reg.OP_CROSS(), OP_CROSS);
    }

    function _genesis(bytes32 h) internal {
        vm.prank(committer);
        reg.commit(h, bytes32(0), bytes32(0), OP_GENESIS, 0, breeder);
    }

    function testGenesisCommit() public {
        _genesis(GEN_A);
        assertTrue(reg.isCommitted(GEN_A));
        assertEq(reg.generationOf(GEN_A), 0);
        assertEq(reg.breederOf(GEN_A), breeder);
        assertEq(reg.latestHash(), GEN_A);
        assertEq(reg.commitCount(), 1);
    }

    function testMutateLineageIntegrity() public {
        _genesis(GEN_A);
        vm.prank(committer);
        reg.commit(CHILD_MUT, GEN_A, bytes32(0), OP_MUTATE, 1, breeder);
        assertEq(reg.generationOf(CHILD_MUT), 1);
        assertEq(reg.childCount(GEN_A), 1);
        (bytes32 h, bytes32 pa, bytes32 pb, uint8 op, uint32 gen, address br, ) = reg.lineages(CHILD_MUT);
        assertEq(h, CHILD_MUT);
        assertEq(pa, GEN_A);
        assertEq(pb, bytes32(0));
        assertEq(op, OP_MUTATE);
        assertEq(gen, 1);
        assertEq(br, breeder);
    }

    function testCrossLineageUsesMaxParentGenPlusOne() public {
        _genesis(GEN_A);
        _genesis(GEN_B);
        // a gen-1 child of A, then cross it with gen-0 B => gen 2
        vm.prank(committer);
        reg.commit(CHILD_MUT, GEN_A, bytes32(0), OP_MUTATE, 1, breeder);
        vm.prank(committer);
        reg.commit(CHILD_CROSS, CHILD_MUT, GEN_B, OP_CROSS, 2, breeder);
        assertEq(reg.generationOf(CHILD_CROSS), 2);
        assertEq(reg.childCount(CHILD_MUT), 1);
        assertEq(reg.childCount(GEN_B), 1);
    }

    function testRevertNotCommitter() public {
        vm.prank(stranger);
        vm.expectRevert(ConnectomeLineage.NotCommitter.selector);
        reg.commit(GEN_A, bytes32(0), bytes32(0), OP_GENESIS, 0, breeder);
    }

    function testRevertDuplicate() public {
        _genesis(GEN_A);
        vm.prank(committer);
        vm.expectRevert(ConnectomeLineage.AlreadyCommitted.selector);
        reg.commit(GEN_A, bytes32(0), bytes32(0), OP_GENESIS, 0, breeder);
    }

    function testRevertParentNotCommitted() public {
        vm.prank(committer);
        vm.expectRevert(ConnectomeLineage.ParentNotCommitted.selector);
        reg.commit(CHILD_MUT, GEN_A, bytes32(0), OP_MUTATE, 1, breeder);
    }

    function testRevertSkippedGeneration() public {
        _genesis(GEN_A);
        vm.prank(committer);
        vm.expectRevert(ConnectomeLineage.BadGeneration.selector);
        reg.commit(CHILD_MUT, GEN_A, bytes32(0), OP_MUTATE, 5, breeder); // must be gen 1
    }

    function testRevertBadGenesis() public {
        vm.prank(committer);
        vm.expectRevert(ConnectomeLineage.BadGenesis.selector);
        reg.commit(GEN_A, GEN_B, bytes32(0), OP_GENESIS, 0, breeder); // genesis must have no parents
    }

    function testRevertCrossMissingSecondParent() public {
        _genesis(GEN_A);
        vm.prank(committer);
        vm.expectRevert(ConnectomeLineage.BadOp.selector);
        reg.commit(CHILD_CROSS, GEN_A, bytes32(0), OP_CROSS, 1, breeder); // cross needs two parents
    }

    function testRevertZeroBreeder() public {
        vm.prank(committer);
        vm.expectRevert(ConnectomeLineage.ZeroBreeder.selector);
        reg.commit(GEN_A, bytes32(0), bytes32(0), OP_GENESIS, 0, address(0));
    }

    /// @dev Invariant: generations are contiguous — a committed child's gen is always max(parents)+1.
    function testFuzzGenerationContiguity(uint32 genA, uint32 genB) public {
        vm.assume(genA < 1000 && genB < 1000);
        // seed two parents at arbitrary generations by chaining genesis->mutate
        bytes32 a = bytes32(uint256(0x1000) + genA);
        bytes32 b = bytes32(uint256(0x2000) + genB);
        _chain(a, genA);
        _chain(b, genB);
        bytes32 child = bytes32(uint256(0x3000) + genA + genB);
        uint32 expect = (genA > genB ? genA : genB) + 1;
        vm.prank(committer);
        reg.commit(child, a, b, OP_CROSS, expect, breeder);
        assertEq(reg.generationOf(child), expect);
    }

    function _chain(bytes32 leaf, uint32 gen) internal {
        bytes32 prev = bytes32(0);
        for (uint32 g = 0; g <= gen; g++) {
            bytes32 h = g == gen ? leaf : bytes32(uint256(keccak256(abi.encode(leaf, g))));
            vm.prank(committer);
            if (g == 0) reg.commit(h, bytes32(0), bytes32(0), OP_GENESIS, 0, breeder);
            else reg.commit(h, prev, bytes32(0), OP_MUTATE, g, breeder);
            prev = h;
        }
    }
}
