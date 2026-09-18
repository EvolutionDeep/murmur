// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/Invariant.sol";
import "../NeuralReceiptRegistry.sol";

/// @notice Unit + invariant tests for murmur's on-chain neural-receipt commitment log.
///
///   Run from packages/trader-worker/contracts:
///     forge install foundry-rs/forge-std   # once
///     forge test -vv
///
///   The invariants that matter for a trustless verifier:
///     · only the committer can append or seed;
///     · chainHead advances ONLY to a receipt whose prevHead equalled the previous head (continuity);
///     · a receipt can never be committed twice;
///     · commitCount equals the number of successful commits, and the head is always the last one.
contract NeuralReceiptRegistryTest is Test {
    NeuralReceiptRegistry internal reg;
    address internal committer = address(0xC0FFEE);
    address internal rando = address(0xBAD);

    bytes32 internal constant G = bytes32(uint256(0x9e));   // a seeded genesis head
    bytes32 internal constant R1 = bytes32(uint256(0x1111));
    bytes32 internal constant R2 = bytes32(uint256(0x2222));
    bytes32 internal constant TX1 = bytes32(uint256(0xaa));
    bytes32 internal constant TX2 = bytes32(uint256(0xbb));

    function setUp() public {
        committer = makeAddr("committer");
        rando = makeAddr("rando");
        reg = new NeuralReceiptRegistry(committer);
    }

    // ------------------------------- construction -------------------------------

    function test_constructor_sets_committer_and_empty_head() public view {
        assertEq(reg.committer(), committer);
        assertEq(reg.chainHead(), bytes32(0));
        assertEq(reg.commitCount(), 0);
    }

    function test_constructor_reverts_on_zero_committer() public {
        vm.expectRevert("zero committer");
        new NeuralReceiptRegistry(address(0));
    }

    // ------------------------------- seedGenesis -------------------------------

    function test_seedGenesis_adopts_head_once() public {
        vm.prank(committer);
        reg.seedGenesis(G);
        assertEq(reg.chainHead(), G);
        // Seeding is NOT a commit: commitCount stays 0, but the head is now locked against re-seeding.
        assertEq(reg.commitCount(), 0);
        assertFalse(reg.isCommitted(G));
    }

    function test_seedGenesis_only_committer() public {
        vm.prank(rando);
        vm.expectRevert(NeuralReceiptRegistry.NotCommitter.selector);
        reg.seedGenesis(G);
    }

    function test_seedGenesis_locked_after_commit() public {
        vm.startPrank(committer);
        reg.commit(R1, bytes32(0), 1, 3, TX1);
        vm.expectRevert(NeuralReceiptRegistry.GenesisLocked.selector);
        reg.seedGenesis(G);
        vm.stopPrank();
    }

    function test_seedGenesis_locked_after_seed() public {
        vm.startPrank(committer);
        reg.seedGenesis(G);
        vm.expectRevert(NeuralReceiptRegistry.GenesisLocked.selector);
        reg.seedGenesis(R1);
        vm.stopPrank();
    }

    // ------------------------------- commit -------------------------------

    function test_commit_advances_head_and_stores_link() public {
        vm.prank(committer);
        reg.commit(R1, bytes32(0), 7, 4, TX1);

        assertEq(reg.chainHead(), R1);
        assertEq(reg.commitCount(), 1);
        assertTrue(reg.isCommitted(R1));

        (bytes32 prev, uint64 tick, uint32 cons, bytes32 tx, uint64 ts) = reg.commits(R1);
        assertEq(prev, bytes32(0));
        assertEq(tick, 7);
        assertEq(cons, 4);
        assertEq(tx, TX1);
        assertGt(ts, 0);
    }

    function test_commit_chains_from_seeded_genesis() public {
        vm.startPrank(committer);
        reg.seedGenesis(G);
        reg.commit(R1, G, 1, 1, TX1);   // prevHead == seeded head ⇒ accepted
        assertEq(reg.chainHead(), R1);
        reg.commit(R2, R1, 2, 1, TX2);
        assertEq(reg.chainHead(), R2);
        assertEq(reg.commitCount(), 2);
        vm.stopPrank();
    }

    function test_commit_reverts_on_bad_prevHead() public {
        vm.prank(committer);
        reg.commit(R1, bytes32(0), 1, 1, TX1);
        // A commit that does NOT chain onto the current head must be refused — this is the invariant
        // that makes the ordered chain reconstructible from events alone.
        vm.prank(committer);
        vm.expectRevert(NeuralReceiptRegistry.BadPrevHead.selector);
        reg.commit(R2, G, 2, 1, TX2);   // wrong predecessor
        assertEq(reg.chainHead(), R1);   // head unchanged
        assertEq(reg.commitCount(), 1);
    }

    function test_commit_reverts_on_double_commit() public {
        vm.prank(committer);
        reg.commit(R1, bytes32(0), 1, 1, TX1);
        // Re-committing the same receipt (even with the now-correct-looking prev) is refused.
        vm.prank(committer);
        vm.expectRevert(NeuralReceiptRegistry.AlreadyCommitted.selector);
        reg.commit(R1, R1, 1, 1, TX1);
    }

    function test_commit_only_committer() public {
        vm.prank(rando);
        vm.expectRevert(NeuralReceiptRegistry.NotCommitter.selector);
        reg.commit(R1, bytes32(0), 1, 1, TX1);
    }

    function test_commit_emits_structured_event() public {
        vm.expectEmit(true, true, false, true);
        emit NeuralReceiptRegistry.ReceiptCommitted(R1, bytes32(0), 5, 2, TX1, committer, block.timestamp);
        vm.prank(committer);
        reg.commit(R1, bytes32(0), 5, 2, TX1);
    }
}

// ============================== invariant (fuzzed) ==============================

/// @notice A bounded actor that only ever appends VALID links, so the fuzzer walks a real chain.
contract RegistryHandler is Test {
    NeuralReceiptRegistry public reg;
    address public committer;
    bytes32[] public heads;          // the ordered chain we have built (heads[0] is the first receipt)
    uint256 public commits;

    constructor(NeuralReceiptRegistry _reg, address _committer) {
        reg = _reg;
        committer = _committer;
    }

    /// Append one more valid link, chaining onto the registry's current head.
    function commitNext(uint64 tick, uint32 cons, bytes32 seed) public {
        bytes32 prev = reg.chainHead();
        bytes32 next = keccak256(abi.encodePacked(prev, seed, commits));
        bytes32 tx = keccak256(abi.encodePacked("tx", next));
        vm.prank(committer);
        reg.commit(next, prev, tick, cons, tx);
        heads.push(next);
        commits++;
    }

    function headCount() public view returns (uint256) { return heads.length; }
    function headAt(uint256 i) public view returns (bytes32) { return heads[i]; }
}

contract NeuralReceiptRegistryInvariantTest is InvariantTest {
    NeuralReceiptRegistry internal reg;
    RegistryHandler internal handler;
    address internal committer = makeAddr("committer");

    function setUp() public {
        reg = new NeuralReceiptRegistry(committer);
        handler = new RegistryHandler(reg, committer);
        // Only the handler may be called by the fuzzer; it only issues valid, committer-signed commits.
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = RegistryHandler.commitNext.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// The registry head is always the last receipt the handler appended.
    function invariant_head_is_last_commit() public view {
        if (handler.headCount() > 0) {
            assertEq(reg.chainHead(), handler.headAt(handler.headCount() - 1));
        } else {
            assertEq(reg.chainHead(), bytes32(0));
        }
    }

    /// commitCount mirrors exactly the number of successful handler commits.
    function invariant_commit_count_matches() public view {
        assertEq(reg.commitCount(), handler.commits());
    }

    /// Every appended receipt is registered, and each link's prevHead chains to its predecessor — the
    /// property that lets anyone rebuild the ordered chain from on-chain data alone.
    function invariant_chain_is_contiguous() public view {
        uint256 n = handler.headCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = handler.headAt(i);
            assertTrue(reg.isCommitted(h));
            (bytes32 prev,,,, ) = reg.commits(h);
            bytes32 expectedPrev = (i == 0) ? bytes32(0) : handler.headAt(i - 1);
            assertEq(prev, expectedPrev);
        }
    }
}
