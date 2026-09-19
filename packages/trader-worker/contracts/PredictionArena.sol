// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface the arena needs. MURMUR (0x8faa…4a5d on Arc) is a standard 18-dec
///         token; we call it through low-level `_safe*` wrappers below so a non-standard return value
///         (USDT-style) can never wedge a bet or a payout.
interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  PredictionArena
/// @notice The human side of murmur's on-chain neural prediction market — "you vs the swarm".
///
///         murmur's 24 fly agents already bet real USDC every cron on whether the Arc-derived market
///         temperature rises or falls, resolved parimutuel with no house (see src/prediction.ts). This
///         contract opens the SAME game to human holders, denominated in the project's own MURMUR token,
///         so a holder participates in the economy through the token rather than through the operator.
///
///         DESIGN (all four choices are deliberate):
///          · MURMUR-denominated — empowers the token; a human pool never touches the swarm's real USDC.
///          · NON-CUSTODIAL — bets are escrowed in THIS contract and paid back out by it. The murmur
///            Worker never holds a bettor's funds and holds no bettor key (mirrors Arc Pulse's stance).
///          · PARALLEL, ZERO-SUM, NO HOUSE — humans bet against each other on the same temperature move;
///            winners split the losers' MURMUR pro-rata, Σpayouts == Σstakes. A FLAT round (or a
///            one-sided book) refunds everyone. The swarm is the rival on the leaderboard, never the
///            counterparty, so it is never on the hook for a human payout.
///          · AUTHORIZED-RESOLVER ORACLE, OUTCOME COMPUTED IN-CONTRACT — the resolver (the Worker's
///            facilitator wallet, the same identity that commits to NeuralReceiptRegistry) publishes the
///            round's entry temperature and flat band at OPEN time, before anyone can bet on the exit,
///            and later supplies only the exit temperature. The contract itself derives UP/DOWN/FLAT from
///            those committed numbers, so the resolver cannot fudge an outcome — it can only report the
///            same temperature the public /predictions feed already shows (independently recomputable
///            from Arc whole-chain activity). A stale round nobody resolves is refundable by anyone after
///            a grace period, so user funds can never be locked by a dead resolver.
///
///         The contract has NO upgrade path and NO owner take: once deployed its rules are fixed.
contract PredictionArena {
    // ---- outcome / side codes (stored as uint8; 0 is always the "unset" sentinel) ----
    uint8 internal constant SIDE_NONE = 0;
    uint8 internal constant SIDE_UP = 1;
    uint8 internal constant SIDE_DOWN = 2;

    uint8 internal constant OUTCOME_PENDING = 0;   // opened, not yet resolved
    uint8 internal constant OUTCOME_UP = 1;
    uint8 internal constant OUTCOME_DOWN = 2;
    uint8 internal constant OUTCOME_FLAT = 3;       // |Δ| ≤ flatBand ⇒ full refund
    uint8 internal constant OUTCOME_REFUND = 4;     // stale round expired un-resolved ⇒ full refund

    /// @notice The staked token (MURMUR). Immutable — this arena is bound to one asset for life.
    address public immutable token;

    /// @notice The only address that may open/resolve rounds (the Worker's facilitator/gas wallet).
    ///         Immutable, exactly like NeuralReceiptRegistry's committer: rotate the key ⇒ redeploy.
    address public immutable resolver;

    /// @notice Seconds after a round's betting deadline past which anyone may expire it for a full
    ///         refund if the resolver never resolved it. A user-fund safety valve, not the normal path.
    uint64 public immutable staleGrace;

    struct Round {
        bool opened;
        bool resolved;
        uint8 outcome;          // OUTCOME_* once resolved
        int64 entryTemp;        // market temperature at open, scaled 1e6 (r6), committed before betting
        int64 flatBand;         // |Δ| ≤ this ⇒ FLAT, committed at open (r6)
        uint64 betDeadline;     // unix seconds; no bet is accepted after this
        uint64 openedAt;
        uint64 resolvedAt;
        int64 exitTemp;         // temperature at resolution (r6)
        uint256 poolUp;         // MURMUR escrowed on UP   (token atomic units, 18-dec)
        uint256 poolDown;       // MURMUR escrowed on DOWN
        address[] bettors;      // enumeration for the off-chain human leaderboard
    }

    struct Bet {
        uint8 side;             // SIDE_UP / SIDE_DOWN (SIDE_NONE ⇒ no bet)
        uint256 amount;         // total MURMUR staked this round (accumulates on same-side re-bets)
        bool claimed;           // payout/refund already taken
    }

    mapping(uint256 => Round) internal _rounds;
    mapping(uint256 => mapping(address => Bet)) public bets;
    mapping(uint256 => mapping(address => bool)) internal _hasBet;

    uint256 public roundCount;   // number of rounds opened (a liveness counter for the frontend)

    event RoundOpened(uint256 indexed roundId, int64 entryTemp, int64 flatBand, uint64 betDeadline, address by);
    event BetPlaced(uint256 indexed roundId, address indexed bettor, uint8 side, uint256 amount, uint256 totalForBettor);
    event RoundResolved(uint256 indexed roundId, uint8 outcome, int64 exitTemp, int64 delta, uint256 poolUp, uint256 poolDown);
    event RoundExpired(uint256 indexed roundId, address by);
    event Claimed(uint256 indexed roundId, address indexed bettor, uint8 outcome, uint256 stake, uint256 payout);

    error NotResolver();
    error AlreadyOpened();
    error NotOpened();
    error AlreadyResolved();
    error BadDeadline();
    error BettingClosed();
    error BadSide();
    error ZeroAmount();
    error SideTaken();
    error NoBet();
    error AlreadyClaimed();
    error NotStale();
    error TransferFailed();

    constructor(address token_, address resolver_, uint64 staleGrace_) {
        require(token_ != address(0), "zero token");
        require(resolver_ != address(0), "zero resolver");
        token = token_;
        resolver = resolver_;
        staleGrace = staleGrace_ == 0 ? 3 days : staleGrace_;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    // ============================== resolver-driven lifecycle ==============================

    /// @notice Open a round and COMMIT its baseline before anyone can bet on the exit. The resolver
    ///         supplies the entry temperature and flat band (both r6) and the betting deadline; the
    ///         outcome is later derived from these committed numbers, so they cannot be chosen to favour
    ///         a result known at resolve time.
    /// @param roundId      opaque id chosen by the Worker (a time bucket / counter); must be unused.
    /// @param entryTempR6  market temperature at open, × 1e6 (0..1 ⇒ 0..1_000_000).
    /// @param flatBandR6   |Δtemperature| ≤ this ⇒ FLAT, × 1e6 (e.g. 0.008 ⇒ 8000).
    /// @param betDeadline  unix seconds after which betting closes; must be in the future.
    function openRound(uint256 roundId, int64 entryTempR6, int64 flatBandR6, uint64 betDeadline)
        external
        onlyResolver
    {
        Round storage r = _rounds[roundId];
        if (r.opened) revert AlreadyOpened();
        if (betDeadline <= block.timestamp) revert BadDeadline();
        require(flatBandR6 >= 0, "neg band");
        r.opened = true;
        r.entryTemp = entryTempR6;
        r.flatBand = flatBandR6;
        r.betDeadline = betDeadline;
        r.openedAt = uint64(block.timestamp);
        unchecked { roundCount += 1; }
        emit RoundOpened(roundId, entryTempR6, flatBandR6, betDeadline, msg.sender);
    }

    /// @notice Resolve a round: the resolver supplies ONLY the exit temperature; the contract computes
    ///         UP/DOWN/FLAT from the committed entry + flat band. Callable once, only after betting
    ///         closed. Payouts are pull-based (see claim) so one resolve never loops over every bettor.
    function resolve(uint256 roundId, int64 exitTempR6) external onlyResolver {
        Round storage r = _rounds[roundId];
        if (!r.opened) revert NotOpened();
        if (r.resolved) revert AlreadyResolved();
        if (block.timestamp < r.betDeadline) revert BettingClosed();   // resolve only after betting shut
        int64 delta = exitTempR6 - r.entryTemp;
        uint8 outcome = delta > r.flatBand
            ? OUTCOME_UP
            : delta < -r.flatBand
                ? OUTCOME_DOWN
                : OUTCOME_FLAT;
        r.resolved = true;
        r.outcome = outcome;
        r.exitTemp = exitTempR6;
        r.resolvedAt = uint64(block.timestamp);
        emit RoundResolved(roundId, outcome, exitTempR6, delta, r.poolUp, r.poolDown);
    }

    /// @notice Safety valve: if the resolver never resolved a round, ANYONE may expire it for a full
    ///         refund once `staleGrace` has passed since its betting deadline. Protects bettors' MURMUR
    ///         against a dead resolver; never callable while the resolver is still inside its window.
    function expireStale(uint256 roundId) external {
        Round storage r = _rounds[roundId];
        if (!r.opened) revert NotOpened();
        if (r.resolved) revert AlreadyResolved();
        if (block.timestamp < uint256(r.betDeadline) + uint256(staleGrace)) revert NotStale();
        r.resolved = true;
        r.outcome = OUTCOME_REFUND;
        r.resolvedAt = uint64(block.timestamp);
        emit RoundExpired(roundId, msg.sender);
        emit RoundResolved(roundId, OUTCOME_REFUND, r.entryTemp, 0, r.poolUp, r.poolDown);
    }

    // ============================== bettor actions ==============================

    /// @notice Stake MURMUR on UP or DOWN for an open round whose betting window is still live. Requires
    ///         a prior `token.approve(arena, amount)`. Re-betting the SAME side tops up the position;
    ///         taking the opposite side in one round is rejected (a bettor holds one direction per round).
    function bet(uint256 roundId, uint8 side, uint256 amount) external {
        Round storage r = _rounds[roundId];
        if (!r.opened) revert NotOpened();
        if (r.resolved) revert AlreadyResolved();
        if (block.timestamp > r.betDeadline) revert BettingClosed();
        if (side != SIDE_UP && side != SIDE_DOWN) revert BadSide();
        if (amount == 0) revert ZeroAmount();

        Bet storage b = bets[roundId][msg.sender];
        if (b.side != SIDE_NONE && b.side != side) revert SideTaken();

        // effects before the external call (checks-effects-interactions)
        if (b.side == SIDE_NONE) {
            b.side = side;
            r.bettors.push(msg.sender);
            _hasBet[roundId][msg.sender] = true;
        }
        b.amount += amount;
        if (side == SIDE_UP) r.poolUp += amount;
        else r.poolDown += amount;

        _safeTransferFrom(msg.sender, address(this), amount);
        emit BetPlaced(roundId, msg.sender, side, amount, b.amount);
    }

    /// @notice Pull a resolved round's payout (or refund). Winners get stake + a pro-rata share of the
    ///         losing pool (integer floor; sub-wei dust is left in the contract — never taken by anyone).
    ///         FLAT / expired / one-sided rounds refund the full stake. One claim per bettor per round.
    function claim(uint256 roundId) public {
        Round storage r = _rounds[roundId];
        if (!r.resolved) revert AlreadyResolved();   // (not resolved yet ⇒ nothing to claim)
        Bet storage b = bets[roundId][msg.sender];
        if (b.side == SIDE_NONE) revert NoBet();
        if (b.claimed) revert AlreadyClaimed();

        uint256 payout = _payout(r, b);
        b.claimed = true;                            // effects before interaction
        emit Claimed(roundId, msg.sender, r.outcome, b.amount, payout);
        if (payout > 0) _safeTransfer(msg.sender, payout);
    }

    /// @notice Claim several resolved rounds in one tx (convenience for the frontend "claim all").
    function claimMany(uint256[] calldata roundIds) external {
        for (uint256 i = 0; i < roundIds.length; i++) {
            Round storage r = _rounds[roundIds[i]];
            Bet storage b = bets[roundIds[i]][msg.sender];
            if (!r.resolved || b.side == SIDE_NONE || b.claimed) continue;   // skip anything unclaimable
            uint256 payout = _payout(r, b);
            b.claimed = true;
            emit Claimed(roundIds[i], msg.sender, r.outcome, b.amount, payout);
            if (payout > 0) _safeTransfer(msg.sender, payout);
        }
    }

    // ============================== views ==============================

    /// @dev Parimutuel payout for a bet on a resolved round (0 for a loser; full stake for FLAT/refund).
    function _payout(Round storage r, Bet storage b) internal view returns (uint256) {
        uint8 o = r.outcome;
        if (o == OUTCOME_FLAT || o == OUTCOME_REFUND) return b.amount;         // refund
        bool won = (o == OUTCOME_UP && b.side == SIDE_UP) || (o == OUTCOME_DOWN && b.side == SIDE_DOWN);
        if (!won) return 0;
        uint256 winPool = o == OUTCOME_UP ? r.poolUp : r.poolDown;
        uint256 losePool = o == OUTCOME_UP ? r.poolDown : r.poolUp;
        if (winPool == 0) return b.amount;                                     // degenerate: refund
        // stake back + pro-rata share of the losing pool (floor; remainder dust stays in-contract)
        return b.amount + (b.amount * losePool) / winPool;
    }

    /// @notice The payout `who` would receive for `roundId` right now (0 if unresolved / no bet / lost).
    function payoutFor(uint256 roundId, address who) external view returns (uint256 stake, uint256 payout, bool claimable) {
        Bet storage b = bets[roundId][who];
        Round storage r = _rounds[roundId];
        stake = b.amount;
        if (b.side == SIDE_NONE) return (0, 0, false);
        if (!r.resolved) return (b.amount, 0, false);
        if (b.claimed) return (b.amount, 0, false);
        return (b.amount, _payout(r, b), true);
    }

    /// @notice Full round state for the frontend (pools, temps, outcome, timing).
    function roundInfo(uint256 roundId)
        external
        view
        returns (
            bool opened, bool resolved, uint8 outcome,
            int64 entryTemp, int64 exitTemp, int64 flatBand,
            uint64 betDeadline, uint64 openedAt, uint64 resolvedAt,
            uint256 poolUp, uint256 poolDown, uint256 bettorCount
        )
    {
        Round storage r = _rounds[roundId];
        return (
            r.opened, r.resolved, r.outcome,
            r.entryTemp, r.exitTemp, r.flatBand,
            r.betDeadline, r.openedAt, r.resolvedAt,
            r.poolUp, r.poolDown, r.bettors.length
        );
    }

    /// @notice The i-th bettor of a round (for off-chain leaderboard enumeration).
    function bettorAt(uint256 roundId, uint256 i) external view returns (address) {
        return _rounds[roundId].bettors[i];
    }

    /// @notice MURMUR the arena currently escrows (sum of all un-claimed stakes + payout dust).
    function escrow() external view returns (uint256) {
        return IERC20Minimal(token).balanceOf(address(this));
    }

    // ============================== safe ERC-20 (no OZ dependency) ==============================

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransfer(address to, uint256 amount) internal {
        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(IERC20Minimal.transfer.selector, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
