// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "forge-std/StdInvariant.sol";
import "../NeuralManifestRegistry.sol";

/// @notice Unit + invariant tests for murmur's on-chain BRAIN-MANIFEST commitment log.
///
///   Run from packages/trader-worker/contracts:
///     forge install foundry-rs/forge-std   # once
///     forge test -vv
///
///   The properties that matter for a trustless "prove the brain" verifier:
///     · only the committer can record a manifest;
///     · a given manifestHash can never be committed twice (the anchor is immutable once set);
///     · the zero hash is rejected (a commitment must identify a real body);
///     · latestHash tracks the most recent commit and commitCount counts them, so the history is
///       fully reconstructible from the event log alone.
contract NeuralManifestRegistryTest is Test {
    NeuralManifestRegistry internal reg;
    address internal committer;
    address internal rando;

    bytes32 internal constant M1 = bytes32(uint256(0x1111));
    bytes32 internal constant M2 = bytes32(uint256(0x2222));

    function setUp() public {
        committer = makeAddr("committer");
        rando = makeAddr("rando");
        reg = new NeuralManifestRegistry(committer);
    }

    // ------------------------------- construction -------------------------------

    function test_constructor_sets_committer_and_empty_state() public view {
        assertEq(reg.committer(), committer);
        assertEq(reg.latestHash(), bytes32(0));
        assertEq(reg.commitCount(), 0);
    }

    function test_constructor_reverts_on_zero_committer() public {
        vm.expectRevert("zero committer");
        new NeuralManifestRegistry(address(0));
    }

    // ------------------------------- commit -------------------------------

    function test_commit_stores_manifest_and_tracks_latest() public {
        vm.prank(committer);
        reg.commit(M1, 1, 24);

        assertEq(reg.latestHash(), M1);
        assertEq(reg.commitCount(), 1);
        assertTrue(reg.isCommitted(M1));

        (bytes32 h, uint32 schema, uint32 pop, uint64 ts) = reg.manifests(M1);
        assertEq(h, M1);
        assertEq(schema, 1);
        assertEq(pop, 24);
        assertGt(ts, 0);
    }

    function test_commit_multiple_tracks_last_and_counts() public {
        vm.startPrank(committer);
        reg.commit(M1, 1, 24);
        reg.commit(M2, 1, 24);
        vm.stopPrank();

        assertEq(reg.latestHash(), M2);
        assertEq(reg.commitCount(), 2);
        assertTrue(reg.isCommitted(M1));
        assertTrue(reg.isCommitted(M2));
    }

    function test_commit_only_committer() public {
        vm.prank(rando);
        vm.expectRevert(NeuralManifestRegistry.NotCommitter.selector);
        reg.commit(M1, 1, 24);
    }

    function test_commit_reverts_on_zero_hash() public {
        vm.prank(committer);
        vm.expectRevert(NeuralManifestRegistry.ZeroHash.selector);
        reg.commit(bytes32(0), 1, 24);
    }

    function test_commit_reverts_on_double_commit() public {
        vm.prank(committer);
        reg.commit(M1, 1, 24);
        // A manifestHash is an immutable point-in-time identity; re-committing it is refused so the
        // on-chain anchor can never be silently rewritten.
        vm.prank(committer);
        vm.expectRevert(NeuralManifestRegistry.AlreadyCommitted.selector);
        reg.commit(M1, 1, 24);
        assertEq(reg.commitCount(), 1); // unchanged
    }

    function test_commit_emits_structured_event() public {
        vm.expectEmit(true, false, false, true);
        emit NeuralManifestRegistry.ManifestCommitted(M1, 1, 24, committer, block.timestamp);
        vm.prank(committer);
        reg.commit(M1, 1, 24);
    }

    function test_isCommitted_false_for_unknown_hash() public view {
        assertFalse(reg.isCommitted(bytes32(uint256(0xdead))));
    }
}

// ============================== invariant (fuzzed) ==============================

/// @notice A bounded actor that only ever commits UNIQUE, valid manifests as the committer.
contract ManifestHandler is Test {
    NeuralManifestRegistry public reg;
    address public committer;
    bytes32[] public hashes;   // the ordered set we have committed
    uint256 public commits;

    constructor(NeuralManifestRegistry _reg, address _committer) {
        reg = _reg;
        committer = _committer;
    }

    /// Commit one more unique manifest hash (never collides, so it never reverts on AlreadyCommitted).
    function commitNext(uint32 schema, uint32 pop, bytes32 seed) public {
        bytes32 h = keccak256(abi.encodePacked("manifest", seed, commits));
        vm.prank(committer);
        reg.commit(h, schema, pop);
        hashes.push(h);
        commits++;
    }

    function hashCount() public view returns (uint256) { return hashes.length; }
    function hashAt(uint256 i) public view returns (bytes32) { return hashes[i]; }
}

contract NeuralManifestRegistryInvariantTest is StdInvariant, Test {
    NeuralManifestRegistry internal reg;
    ManifestHandler internal handler;
    address internal committer = makeAddr("committer");

    function setUp() public {
        reg = new NeuralManifestRegistry(committer);
        handler = new ManifestHandler(reg, committer);
        targetContract(address(handler));
        bytes4[] memory sels = new bytes4[](1);
        sels[0] = ManifestHandler.commitNext.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sels}));
    }

    /// latestHash is always the most recent manifest the handler committed.
    function invariant_latest_is_last_commit() public view {
        if (handler.hashCount() > 0) {
            assertEq(reg.latestHash(), handler.hashAt(handler.hashCount() - 1));
        } else {
            assertEq(reg.latestHash(), bytes32(0));
        }
    }

    /// commitCount mirrors exactly the number of successful handler commits.
    function invariant_commit_count_matches() public view {
        assertEq(reg.commitCount(), handler.commits());
    }

    /// Every committed manifest is registered and queryable — the anchor is durable.
    function invariant_all_manifests_committed() public view {
        uint256 n = handler.hashCount();
        for (uint256 i = 0; i < n; i++) {
            assertTrue(reg.isCommitted(handler.hashAt(i)));
        }
    }
}
