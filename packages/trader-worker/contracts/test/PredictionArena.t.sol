// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../PredictionArena.sol";

/// @notice A bare standard ERC-20 standing in for MURMUR (18-dec). The arena calls it through low-level
///         `_safe*` wrappers, so a plain bool-returning token is exactly what we must be correct against.
contract MockMURMUR {
    string public name = "MurMur";
    string public symbol = "MURMUR";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 a) external { balanceOf[to] += a; totalSupply += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) {
        balanceOf[msg.sender] -= a; balanceOf[to] += a; return true;
    }
    function transferFrom(address f, address to, uint256 a) external returns (bool) {
        uint256 al = allowance[f][msg.sender];
        if (al != type(uint256).max) { require(al >= a, "allowance"); allowance[f][msg.sender] = al - a; }
        balanceOf[f] -= a; balanceOf[to] += a; return true;
    }
}

/// @notice Unit + fuzz tests for murmur's human-vs-swarm prediction arena.
///
///   Run from packages/trader-worker/contracts:
///     forge install foundry-rs/forge-std   # once
///     forge test -vv
///
///   The properties that matter for a pool that holds real MURMUR:
///     · only the resolver can open/resolve; the outcome is DERIVED in-contract from committed numbers;
///     · betting is gated to the open, pre-deadline window and to one direction per bettor;
///     · parimutuel is strictly zero-sum (Σpayout == Σstake) whenever both sides are backed;
///     · FLAT / one-sided / stale rounds refund every stake (no house to absorb an unmatched pool);
///     · a payout can be claimed exactly once, and only by someone who bet.
contract PredictionArenaTest is Test {
    PredictionArena internal arena;
    MockMURMUR internal mur;
    address internal resolver = makeAddr("resolver");
    address internal rando = makeAddr("rando");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    uint64 internal constant GRACE = 3 days;
    int64 internal constant BAND = 8000;      // 0.008 r6 — matches PREDICT_FLAT_BAND default
    uint256 internal t0 = 1_000_000;

    function setUp() public {
        vm.warp(t0);
        mur = new MockMURMUR();
        arena = new PredictionArena(address(mur), resolver, GRACE);
        address[] memory actors = _actors();
        for (uint256 i = 0; i < actors.length; i++) { mur.mint(actors[i], 1_000_000 ether); }
    }

    function _actors() internal view returns (address[] memory v) {
        v = new address[](3); v[0] = alice; v[1] = bob; v[2] = rando;
    }

    // ------------------------------- helpers -------------------------------

    function _open(uint256 id, int64 entry, uint64 deadline) internal {
        vm.prank(resolver);
        arena.openRound(id, entry, BAND, deadline);
    }

    function _approveBet(address who, uint256 id, uint8 side, uint256 amt) internal {
        vm.startPrank(who);
        mur.approve(address(arena), type(uint256).max);
        arena.bet(id, side, amt);
        vm.stopPrank();
    }

    // ------------------------------- construction -------------------------------

    function test_constructor_sets_immutables() public view {
        assertEq(arena.token(), address(mur));
        assertEq(arena.resolver(), resolver);
        assertEq(arena.staleGrace(), GRACE);
        assertEq(arena.roundCount(), 0);
    }

    function test_constructor_zero_grace_defaults_to_three_days() public {
        PredictionArena a2 = new PredictionArena(address(mur), resolver, 0);
        assertEq(a2.staleGrace(), 3 days);
    }

    function test_constructor_reverts_on_zero_addresses() public {
        vm.expectRevert("zero token");
        new PredictionArena(address(0), resolver, GRACE);
        vm.expectRevert("zero resolver");
        new PredictionArena(address(mur), address(0), GRACE);
    }

    // ------------------------------- openRound -------------------------------

    function test_openRound_commits_baseline_and_counts() public {
        _open(1, 500_000, uint64(t0 + 100));
        assertEq(arena.roundCount(), 1);
        (bool opened, bool resolved, uint8 outcome, int64 entry, int64 exitT, int64 band,
         uint64 deadline, uint64 openedAt, uint64 resolvedAt, uint256 up, uint256 down, uint256 n)
            = arena.roundInfo(1);
        assertTrue(opened); assertFalse(resolved);
        assertEq(outcome, 0); assertEq(entry, 500_000); assertEq(exitT, 0); assertEq(band, BAND);
        assertEq(deadline, uint64(t0 + 100)); assertEq(openedAt, uint64(t0)); assertEq(resolvedAt, 0);
        assertEq(up, 0); assertEq(down, 0); assertEq(n, 0);
    }

    function test_openRound_only_resolver() public {
        vm.prank(rando);
        vm.expectRevert(PredictionArena.NotResolver.selector);
        arena.openRound(1, 500_000, BAND, uint64(t0 + 100));
    }

    function test_openRound_rejects_past_deadline() public {
        vm.prank(resolver);
        vm.expectRevert(PredictionArena.BadDeadline.selector);
        arena.openRound(1, 500_000, BAND, uint64(t0));   // == now ⇒ not in the future
    }

    function test_openRound_rejects_reuse() public {
        _open(1, 500_000, uint64(t0 + 100));
        vm.prank(resolver);
        vm.expectRevert(PredictionArena.AlreadyOpened.selector);
        arena.openRound(1, 600_000, BAND, uint64(t0 + 200));
    }

    // ------------------------------- bet -------------------------------

    function test_bet_escrows_and_accumulates_same_side() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);
        _approveBet(alice, 1, 1, 5 ether);
        assertEq(mur.balanceOf(address(arena)), 15 ether);
        (uint8 side, uint256 amt, bool claimed) = arena.bets(1, alice);
        assertEq(side, 1); assertEq(amt, 15 ether); assertFalse(claimed);
        (,,,,,,,,,uint256 up, uint256 down, uint256 n) = arena.roundInfo(1);
        assertEq(up, 15 ether); assertEq(down, 0); assertEq(n, 1);   // alice counted once
    }

    function test_bet_rejects_opposite_side() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);
        vm.startPrank(alice);
        vm.expectRevert(PredictionArena.SideTaken.selector);
        arena.bet(1, 2, 1 ether);
        vm.stopPrank();
    }

    function test_bet_gates() public {
        // not opened
        vm.startPrank(alice); mur.approve(address(arena), type(uint256).max);
        vm.expectRevert(PredictionArena.NotOpened.selector);
        arena.bet(9, 1, 1 ether);
        vm.stopPrank();

        _open(1, 500_000, uint64(t0 + 100));
        vm.startPrank(alice);
        vm.expectRevert(PredictionArena.BadSide.selector);   arena.bet(1, 3, 1 ether);
        vm.expectRevert(PredictionArena.ZeroAmount.selector); arena.bet(1, 1, 0);
        vm.stopPrank();

        vm.warp(t0 + 101);   // past the betting deadline
        vm.startPrank(alice);
        vm.expectRevert(PredictionArena.BettingClosed.selector);
        arena.bet(1, 1, 1 ether);
        vm.stopPrank();
    }

    // ------------------------------- resolve + outcome math -------------------------------

    function test_resolve_derives_outcome_from_committed_numbers() public {
        _open(1, 500_000, uint64(t0 + 100));
        vm.warp(t0 + 101);
        vm.prank(resolver); arena.resolve(1, 520_000);           // Δ +20000 > 8000 ⇒ UP
        (,bool resolved, uint8 outcome,, int64 exitT,,,,,,,) = arena.roundInfo(1);
        assertTrue(resolved); assertEq(outcome, 1); assertEq(exitT, 520_000);

        _open(2, 500_000, uint64(t0 + 200));
        vm.warp(t0 + 201);
        vm.prank(resolver); arena.resolve(2, 480_000);           // Δ −20000 < −8000 ⇒ DOWN
        (,,uint8 o2,,,,,,,,,) = arena.roundInfo(2); assertEq(o2, 2);

        _open(3, 500_000, uint64(t0 + 300));
        vm.warp(t0 + 301);
        vm.prank(resolver); arena.resolve(3, 505_000);           // Δ +5000 ≤ 8000 ⇒ FLAT
        (,,uint8 o3,,,,,,,,,) = arena.roundInfo(3); assertEq(o3, 3);
    }

    function test_resolve_only_after_deadline_and_once() public {
        _open(1, 500_000, uint64(t0 + 100));
        vm.prank(resolver);
        vm.expectRevert(PredictionArena.BettingClosed.selector);
        arena.resolve(1, 520_000);            // betting still open (t0 < deadline)
        vm.warp(t0 + 101);
        vm.startPrank(resolver);
        arena.resolve(1, 520_000);
        vm.expectRevert(PredictionArena.AlreadyResolved.selector);
        arena.resolve(1, 400_000);
        vm.stopPrank();
    }

    function test_resolve_only_resolver() public {
        _open(1, 500_000, uint64(t0 + 100));
        vm.warp(t0 + 101);
        vm.prank(rando);
        vm.expectRevert(PredictionArena.NotResolver.selector);
        arena.resolve(1, 520_000);
    }

    // ------------------------------- claim / parimutuel -------------------------------

    function testFuzz_parimutuel_is_zero_sum(uint96 upRaw, uint96 downRaw) public {
        uint256 up = uint256(upRaw) % 100_000 ether + 1 ether;
        uint256 down = uint256(downRaw) % 100_000 ether + 1 ether;
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, up);       // UP
        _approveBet(bob, 1, 2, down);       // DOWN
        vm.warp(t0 + 101);
        vm.prank(resolver); arena.resolve(1, 520_000);   // UP wins

        uint256 balBefore = mur.totalSupply();           // supply is fixed; track arena escrow instead
        uint256 escrowBefore = mur.balanceOf(address(arena));
        assertEq(escrowBefore, up + down);

        vm.prank(alice); arena.claim(1);
        vm.prank(bob); arena.claim(1);

        // alice (winner) got her stake + the whole losing pool; bob (loser) got 0.
        assertEq(mur.balanceOf(alice), 1_000_000 ether + down);   // started 1M, −up stake, +up+down payout
        assertEq(mur.balanceOf(bob), 1_000_000 ether - down);     // started 1M, −down stake, +0
        assertEq(mur.balanceOf(address(arena)), 0);               // fully drained ⇒ Σpayout == Σstake
        assertEq(mur.totalSupply(), balBefore);                   // nothing minted/burned
    }

    function testFuzz_flat_refunds_everyone(uint96 upRaw, uint96 downRaw) public {
        uint256 up = uint256(upRaw) % 100_000 ether + 1 ether;
        uint256 down = uint256(downRaw) % 100_000 ether + 1 ether;
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, up);
        _approveBet(bob, 1, 2, down);
        vm.warp(t0 + 101);
        vm.prank(resolver); arena.resolve(1, 500_000);   // Δ 0 ⇒ FLAT
        vm.prank(alice); arena.claim(1);
        vm.prank(bob); arena.claim(1);
        assertEq(mur.balanceOf(alice), 1_000_000 ether);   // full refund
        assertEq(mur.balanceOf(bob), 1_000_000 ether);
        assertEq(mur.balanceOf(address(arena)), 0);
    }

    function test_one_sided_book_refunds_when_it_wins() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);   // only UP backed
        _approveBet(bob, 1, 1, 5 ether);
        vm.warp(t0 + 101);
        vm.prank(resolver); arena.resolve(1, 520_000);   // UP wins, but losePool == 0 ⇒ refund
        vm.prank(alice); arena.claim(1);
        vm.prank(bob); arena.claim(1);
        assertEq(mur.balanceOf(alice), 1_000_000 ether);
        assertEq(mur.balanceOf(bob), 1_000_000 ether);
        assertEq(mur.balanceOf(address(arena)), 0);
    }

    function test_loser_gets_zero_and_claim_is_once() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);
        _approveBet(bob, 1, 2, 4 ether);
        vm.warp(t0 + 101);
        vm.prank(resolver); arena.resolve(1, 520_000);   // UP wins
        vm.prank(bob); arena.claim(1);                    // loser ⇒ 0 payout, but marks claimed
        assertEq(mur.balanceOf(bob), 1_000_000 ether - 4 ether);
        vm.prank(bob);
        vm.expectRevert(PredictionArena.AlreadyClaimed.selector);
        arena.claim(1);
        // a non-bettor cannot claim
        vm.prank(rando);
        vm.expectRevert(PredictionArena.NoBet.selector);
        arena.claim(1);
    }

    function test_payoutFor_matches_claim() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 30 ether);
        _approveBet(bob, 1, 2, 10 ether);
        vm.warp(t0 + 101);
        vm.prank(resolver); arena.resolve(1, 520_000);
        (uint256 stake, uint256 payout, bool claimable) = arena.payoutFor(1, alice);
        assertEq(stake, 30 ether); assertEq(payout, 30 ether + 10 ether); assertTrue(claimable);
        (uint256 s2, uint256 p2, bool c2) = arena.payoutFor(1, bob);
        assertEq(s2, 10 ether); assertEq(p2, 0); assertTrue(c2);   // loser: claimable, pays 0
    }

    // ------------------------------- stale safety valve -------------------------------

    function test_expireStale_refunds_after_grace_only() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);
        // before grace ⇒ cannot expire
        vm.warp(t0 + 101);
        vm.prank(rando);
        vm.expectRevert(PredictionArena.NotStale.selector);
        arena.expireStale(1);
        // after deadline + grace ⇒ anyone can expire ⇒ full refund
        vm.warp(t0 + 101 + GRACE);
        vm.prank(rando);
        arena.expireStale(1);
        (,,uint8 outcome,,,,,,,,,) = arena.roundInfo(1);
        assertEq(outcome, 4);   // OUTCOME_REFUND
        vm.prank(alice); arena.claim(1);
        assertEq(mur.balanceOf(alice), 1_000_000 ether);
        assertEq(mur.balanceOf(address(arena)), 0);
    }

    function test_cannot_bet_or_resolve_after_expire() public {
        _open(1, 500_000, uint64(t0 + 100));
        vm.warp(t0 + 101 + GRACE);
        vm.prank(rando); arena.expireStale(1);
        vm.prank(resolver);
        vm.expectRevert(PredictionArena.AlreadyResolved.selector);
        arena.resolve(1, 520_000);
    }

    // ------------------------------- claimMany + views -------------------------------

    function test_claimMany_skips_unclaimable_and_pays_rest() public {
        _open(1, 500_000, uint64(t0 + 100));
        _open(2, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);
        _approveBet(bob, 1, 2, 10 ether);
        _approveBet(alice, 2, 2, 10 ether);
        _approveBet(bob, 2, 1, 10 ether);
        vm.warp(t0 + 101);
        vm.startPrank(resolver);
        arena.resolve(1, 520_000);   // UP wins: alice wins r1, loses r2
        arena.resolve(2, 480_000);   // DOWN wins: alice wins r2, loses r1
        vm.stopPrank();

        uint256[] memory ids = new uint256[](3);
        ids[0] = 1; ids[1] = 2; ids[2] = 99;   // 99 never opened ⇒ skipped
        vm.prank(alice);
        arena.claimMany(ids);
        // alice: −10 −10 staked, +20 (r1 win: stake 10 + pool 10) +20 (r2 win) ⇒ net +20 over 1M−20
        assertEq(mur.balanceOf(alice), 1_000_000 ether + 20 ether);
    }

    function test_escrow_and_bettorAt() public {
        _open(1, 500_000, uint64(t0 + 100));
        _approveBet(alice, 1, 1, 10 ether);
        _approveBet(bob, 1, 2, 5 ether);
        assertEq(arena.escrow(), 15 ether);
        assertEq(arena.bettorAt(1, 0), alice);
        assertEq(arena.bettorAt(1, 1), bob);
    }
}
