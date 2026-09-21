// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "forge-std/Test.sol";
import "../WarCoffer.sol";

/// @notice A bare standard ERC-20 standing in for Arc USDC (6-dec). The coffer calls it through
///         low-level `_safe*` wrappers, so a plain bool-returning token is exactly what we test against.
contract MockUSDC {
    string public name = "USDC";
    string public symbol = "USDC";
    uint8 public decimals = 6;
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

/// @notice Unit + property tests for murmur's on-chain WarCoffer (house vaults, bounded wars, tax).
///
///   Run from packages/trader-worker/contracts:  forge test -vv
///
///   The properties that matter for a coffer holding real USDC:
///     · only the resolver can deposit/declare/resolve/levy/sweep; expire-stale is permissionless;
///     · the escrow total NEVER changes across declare/resolve/levy/sweep (money only moves internally);
///     · the war winner is a PUBLIC deterministic function of the committed inputs (preview == resolve);
///     · a bounded stake only: the winner's vault grows by exactly the loser's stake, never the whole vault;
///     · Σ(vaults) + Σ(open pots) + commonsPurse == totalEscrow at every step;
///     · an un-resolved war refunds both stakes after the grace, so escrow can never be locked.
contract WarCofferTest is Test {
    WarCoffer internal coffer;
    MockUSDC internal usd;
    address internal resolver = makeAddr("resolver");
    address internal rando = makeAddr("rando");

    uint64 internal constant GRACE = 3 days;
    uint256 internal constant CAP = 100_000e6;      // 100k USDC hard escrow cap
    uint256 internal constant HA = 1;               // house id of the attacker
    uint256 internal constant HD = 2;               // house id of the defender
    uint256 internal t0 = 1_000_000;

    function setUp() public {
        vm.warp(t0);
        usd = new MockUSDC();
        coffer = new WarCoffer(address(usd), resolver, CAP, GRACE);
        vm.startPrank(resolver);
        usd.mint(resolver, 1_000_000e6);
        usd.approve(address(coffer), type(uint256).max);
        vm.stopPrank();
    }

    // ------------------------------- helpers -------------------------------

    function _deposit(uint256 house, uint256 amt) internal {
        vm.prank(resolver);
        coffer.deposit(house, amt);
    }

    function _declare(uint256 warId, uint256 stake, uint256 pa, uint256 pb, uint64 deadline) internal {
        vm.prank(resolver);
        coffer.declareWar(warId, HA, HD, stake, pa, pb, deadline);
    }

    /// @dev Independent re-derivation of the documented winner rule; must match the contract exactly.
    function _expected(uint256 warId, uint256 pa, uint256 pb)
        internal pure returns (uint8 winner, uint256 roll, uint256 total)
    {
        total = pa + pb;
        roll = uint256(keccak256(abi.encodePacked(warId, HA, HD, pa, pb))) % total;
        winner = roll < pa ? 1 : 2;   // 1 = WIN_ATTACKER, 2 = WIN_DEFENDER
    }

    // ------------------------------- construction -------------------------------

    function test_constructor_sets_immutables() public view {
        assertEq(coffer.usdc(), address(usd));
        assertEq(coffer.resolver(), resolver);
        assertEq(coffer.maxEscrow(), CAP);
        assertEq(coffer.staleGrace(), GRACE);
        assertEq(coffer.warCount(), 0);
        assertEq(coffer.totalEscrow(), 0);
    }

    function test_constructor_zero_grace_defaults_to_three_days() public {
        WarCoffer c2 = new WarCoffer(address(usd), resolver, CAP, 0);
        assertEq(c2.staleGrace(), 3 days);
    }

    function test_constructor_reverts_on_bad_args() public {
        vm.expectRevert("zero usdc");
        new WarCoffer(address(0), resolver, CAP, GRACE);
        vm.expectRevert("zero resolver");
        new WarCoffer(address(usd), address(0), CAP, GRACE);
        vm.expectRevert("zero cap");
        new WarCoffer(address(usd), resolver, 0, GRACE);
    }

    // ------------------------------- deposit -------------------------------

    function test_deposit_credits_vault_and_pulls_usdc() public {
        _deposit(HA, 500e6);
        assertEq(coffer.vault(HA), 500e6);
        assertEq(coffer.totalEscrow(), 500e6);
        assertEq(coffer.escrow(), 500e6);
        assertEq(usd.balanceOf(address(coffer)), 500e6);
    }

    function test_deposit_only_resolver() public {
        vm.prank(rando);
        vm.expectRevert(WarCoffer.NotResolver.selector);
        coffer.deposit(HA, 1e6);
    }

    function test_deposit_respects_hard_cap() public {
        _deposit(HA, CAP);
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.EscrowCap.selector);
        coffer.deposit(HD, 1);
    }

    // ------------------------------- declareWar -------------------------------

    function test_declare_escrows_both_stakes_into_pot() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(7, 200e6, 3, 1, uint64(t0 + 100));
        // both vaults drop by the stake; the pot holds 2*stake; escrow total unchanged
        assertEq(coffer.vault(HA), 800e6);
        assertEq(coffer.vault(HD), 800e6);
        (,,,,,,,, uint256 pot,,,) = coffer.warInfo(7);
        assertEq(pot, 400e6);
        assertEq(coffer.totalEscrow(), 2000e6);
        assertEq(coffer.warCount(), 1);
    }

    function test_declare_guards() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        vm.startPrank(resolver);
        vm.expectRevert(WarCoffer.BadWar.selector);
        coffer.declareWar(1, HA, HA, 100e6, 3, 1, uint64(t0 + 100));
        vm.expectRevert(WarCoffer.ZeroStake.selector);
        coffer.declareWar(2, HA, HD, 0, 3, 1, uint64(t0 + 100));
        vm.expectRevert(WarCoffer.ZeroPower.selector);
        coffer.declareWar(3, HA, HD, 100e6, 0, 0, uint64(t0 + 100));
        vm.expectRevert(WarCoffer.BadDeadline.selector);
        coffer.declareWar(4, HA, HD, 100e6, 3, 1, uint64(t0));
        vm.expectRevert(WarCoffer.InsufficientVault.selector);
        coffer.declareWar(5, HA, HD, 5000e6, 3, 1, uint64(t0 + 100));
        vm.stopPrank();
    }

    function test_declare_only_resolver_and_no_reuse() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        vm.prank(rando);
        vm.expectRevert(WarCoffer.NotResolver.selector);
        coffer.declareWar(7, HA, HD, 100e6, 3, 1, uint64(t0 + 100));
        _declare(7, 100e6, 3, 1, uint64(t0 + 100));
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.AlreadyOpened.selector);
        coffer.declareWar(7, HA, HD, 100e6, 3, 1, uint64(t0 + 200));
    }

    // ------------------------------- resolveWar -------------------------------

    function test_preview_matches_documented_rule() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(7, 200e6, 3, 1, uint64(t0 + 100));
        (uint8 w1, uint256 r1, uint256 t1) = coffer.previewWinner(7);
        (uint8 w2, uint256 r2, uint256 t2) = _expected(7, 3, 1);
        assertEq(w1, w2); assertEq(r1, r2); assertEq(t1, t2);
    }

    function test_resolve_pays_pot_to_winner_and_conserves() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(7, 200e6, 3, 1, uint64(t0 + 100));
        (uint8 winner,,) = coffer.previewWinner(7);

        vm.warp(t0 + 101);
        vm.prank(resolver);
        coffer.resolveWar(7);

        uint256 va = coffer.vault(HA);
        uint256 vd = coffer.vault(HD);
        if (winner == 1) {
            assertEq(va, 1200e6);   // 800 escrow-back + 400 pot
            assertEq(vd, 800e6);
        } else {
            assertEq(va, 800e6);
            assertEq(vd, 1200e6);
        }
        // conservation: total held unchanged, pot drained, escrow unchanged
        assertEq(va + vd, 2000e6);
        assertEq(coffer.totalEscrow(), 2000e6);
        assertEq(coffer.escrow(), 2000e6);
        (, bool resolved, uint8 wStored,,,,,,,,,) = coffer.warInfo(7);
        assertTrue(resolved); assertEq(wStored, winner);
    }

    function test_resolve_only_after_deadline_once_and_resolver() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(7, 200e6, 3, 1, uint64(t0 + 100));
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.WarNotReady.selector);
        coffer.resolveWar(7);                       // before deadline
        vm.warp(t0 + 101);
        vm.prank(rando);
        vm.expectRevert(WarCoffer.NotResolver.selector);
        coffer.resolveWar(7);                       // not resolver
        vm.prank(resolver);
        coffer.resolveWar(7);
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.AlreadyResolved.selector);
        coffer.resolveWar(7);                       // only once
    }

    // ------------------------------- taxation -------------------------------

    function test_levyTax_moves_vault_to_purse_and_conserves() public {
        _deposit(HA, 1000e6);
        vm.prank(resolver);
        coffer.levyTax(HA, 150e6);
        assertEq(coffer.vault(HA), 850e6);
        assertEq(coffer.commonsPurse(), 150e6);
        assertEq(coffer.escrow(), 1000e6);           // no real USDC moved
        assertEq(coffer.totalEscrow(), 1000e6);
    }

    function test_levyTax_guards() public {
        _deposit(HA, 100e6);
        vm.prank(rando);
        vm.expectRevert(WarCoffer.NotResolver.selector);
        coffer.levyTax(HA, 1e6);
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.ZeroStake.selector);
        coffer.levyTax(HA, 0);
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.InsufficientVault.selector);
        coffer.levyTax(HA, 101e6);
    }

    function test_sweepTo_pays_purse_into_a_vault() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 10e6);
        vm.startPrank(resolver);
        coffer.levyTax(HA, 200e6);
        coffer.sweepTo(HD);
        vm.stopPrank();
        assertEq(coffer.commonsPurse(), 0);
        assertEq(coffer.vault(HD), 210e6);
        assertEq(coffer.escrow(), 1010e6);           // conserved
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.NothingToSweep.selector);
        coffer.sweepTo(HD);
    }

    // ------------------------------- stale safety valve -------------------------------

    function test_expireStaleWar_refunds_after_grace_only() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(7, 200e6, 3, 1, uint64(t0 + 100));
        // before grace ⇒ cannot expire
        vm.warp(t0 + 101);
        vm.prank(rando);
        vm.expectRevert(WarCoffer.NotStale.selector);
        coffer.expireStaleWar(7);
        // after deadline + grace ⇒ anyone may expire ⇒ both stakes refunded
        vm.warp(t0 + 101 + GRACE);
        vm.prank(rando);
        coffer.expireStaleWar(7);
        assertEq(coffer.vault(HA), 1000e6);
        assertEq(coffer.vault(HD), 1000e6);
        (,, uint8 winner,,,,,,,,,) = coffer.warInfo(7);
        assertEq(winner, 0);                         // WIN_NONE (refund)
        assertEq(coffer.escrow(), 2000e6);           // conserved
    }

    function test_cannot_resolve_after_expire() public {
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(7, 200e6, 3, 1, uint64(t0 + 100));
        vm.warp(t0 + 101 + GRACE);
        vm.prank(rando); coffer.expireStaleWar(7);
        vm.prank(resolver);
        vm.expectRevert(WarCoffer.AlreadyResolved.selector);
        coffer.resolveWar(7);
    }

    // ------------------------------- conservation invariant (fuzz) -------------------------------

    function testFuzz_conservation_across_war(uint96 stakeRaw, uint96 paRaw, uint96 pbRaw) public {
        uint256 stake = uint256(stakeRaw) % 400e6 + 1;
        uint256 pa = uint256(paRaw) % 1_000_000 + 1;
        uint256 pb = uint256(pbRaw) % 1_000_000 + 1;
        _deposit(HA, 1000e6);
        _deposit(HD, 1000e6);
        _declare(11, stake, pa, pb, uint64(t0 + 100));
        assertEq(coffer.vault(HA) + coffer.vault(HD) + 2 * stake, 2000e6);   // pot escrowed

        vm.warp(t0 + 101);
        vm.prank(resolver);
        coffer.resolveWar(11);
        // after resolve the pot is fully inside the winner's vault; total unchanged
        assertEq(coffer.vault(HA) + coffer.vault(HD), 2000e6);
        assertEq(coffer.escrow(), 2000e6);
    }
}
