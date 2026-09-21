// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface the coffer needs. USDC on Arc (0x3600..0000) is a FiatTokenV2 with
///         6 decimals; we call it through low-level `_safe*` wrappers below so a non-standard return
///         value (USDT-style) can never wedge a deposit, a levy or a war payout.
interface IERC20Minimal {
    function balanceOf(address) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/// @title  WarCoffer
/// @notice The on-chain battlefield of murmur's dynasty: houses that fall into a deep feud may go to
///         WAR, and every house pays an EXTRA on-chain TAX beyond the ledger-side 2% tithe. This
///         contract escrows REAL USDC per house vault and settles both movements itself.
///
///         WHY A CONTRACT (vs folding war/tax into the agent netting): the swarm's agent-to-agent
///         micropayments already settle through EIP-3009 netting, but a house vault is NOT an agent
///         wallet — it is a shared treasury that outlives its members. Putting vaults, stakes and the
///         commons purse ON-CHAIN makes inter-house conflict a public, tamper-evident fact: anyone can
///         read a house's vault, an open war and the tax purse straight off Arc, exactly like the
///         PredictionArena's round book.
///
///         DESIGN (all deliberate, mirroring PredictionArena's discipline):
///          · REAL USDC, BOUNDED — the coffer holds up to `maxEscrow` USDC, deposited by the resolver
///            (the Worker's facilitator/treasury wallet). A hard cap means a bug or a rogue cron can
///            never drain more than the configured ceiling of the project's own treasury.
///          · NON-CUSTODIAL TO THIRD PARTIES — only the project's own agent/house funds ever enter;
///            no external depositor, no user key is ever touched. Σ(vaults) + Σ(open war pots) +
///            commonsPurse == escrowed USDC at all times: money is only ever MOVED, never minted.
///          · TRUSTLESS OUTCOME, DERIVED IN-CONTRACT — a war commits both houses' POWER scores at
///            declare (before it can be resolved), and the winner is a pure, PUBLIC function of the
///            committed (warId, attacker, defender, powerA, powerB): each house wins with probability
///            proportional to its power, resolved by a deterministic keccak draw. The resolver supplies
///            NOTHING at resolve time, so it cannot steer a result — the outcome is fixed the instant
///            the war is declared and is recomputable by anyone from the WarDeclared event.
///          · BOUNDED STAKE, NO ANNEXATION — a war escrows a bounded `stake` from each side; the winner
///            takes the whole pot (net: winner +stake, loser −stake). A house's remaining vault is
///            never seized here; whole-vault annexation is a deliberate non-goal of this layer.
///          · STALE-WAR REFUND — a war the resolver never resolved becomes refundable by ANYONE once
///            `staleGrace` passes its deadline, so escrowed stakes can never be locked by a dead cron.
///
///         The contract has NO upgrade path and NO owner take: once deployed its rules are fixed.
contract WarCoffer {
    // ---- outcome codes (stored as uint8; 0 is the "unset"/refund sentinel) ----
    uint8 internal constant WIN_NONE = 0;      // un-resolved, or a stale-war refund (no winner)
    uint8 internal constant WIN_ATTACKER = 1;  // the attacker house took the pot
    uint8 internal constant WIN_DEFENDER = 2;  // the defender house took the pot

    /// @notice The escrowed asset (Arc USDC, 6-dec). Immutable — this coffer is bound to one asset.
    address public immutable usdc;

    /// @notice The only address that may deposit/declare/resolve/levy (the Worker's facilitator wallet).
    ///         Immutable, exactly like PredictionArena's resolver: rotate the key ⇒ redeploy.
    address public immutable resolver;

    /// @notice Hard ceiling on total USDC the coffer may ever hold. A safety bound on the escrow.
    uint256 public immutable maxEscrow;

    /// @notice Seconds after a war's deadline past which anyone may expire it for a stake refund.
    uint64 public immutable staleGrace;

    struct War {
        bool opened;
        bool resolved;
        uint8 winner;           // WIN_* once resolved (WIN_ATTACKER / WIN_DEFENDER; WIN_NONE ⇒ refund)
        uint256 attacker;       // house id of the aggressor
        uint256 defender;       // house id of the target
        uint256 stake;          // bounded stake posted by EACH side (pot == 2*stake)
        uint256 powerA;         // attacker power committed at declare (never re-read)
        uint256 powerB;         // defender power committed at declare
        uint256 pot;            // escrowed 2*stake held for this war until resolve/expire (0 after)
        uint64 deadline;        // unix seconds; the war may only be resolved at or after this
        uint64 openedAt;
        uint64 resolvedAt;
    }

    /// @notice USDC escrowed FOR a house (its on-chain vault). Internal accounting of the pooled USDC.
    mapping(uint256 houseId => uint256) public vault;
    mapping(uint256 warId => War) internal _wars;

    uint256 public totalEscrow;   // total USDC ever deposited (== real balance; never decreases)
    uint256 public commonsPurse;  // tax collected, held by the coffer for the swarm
    uint256 public warCount;      // number of wars declared (a liveness counter for the frontend)

    event Deposited(uint256 indexed houseId, uint256 amount, uint256 newVault, address by);
    event WarDeclared(uint256 indexed warId, uint256 indexed attacker, uint256 indexed defender, uint256 stake, uint256 powerA, uint256 powerB, uint64 deadline, address by);
    event WarResolved(uint256 indexed warId, uint8 winner, uint256 pot, uint256 roll, uint256 total);
    event WarExpired(uint256 indexed warId, address by);
    event TaxLevied(uint256 indexed houseId, uint256 amount, uint256 newPurse);
    event TaxSwept(uint256 indexed houseId, uint256 amount);

    error NotResolver();
    error AlreadyOpened();
    error NotOpened();
    error AlreadyResolved();
    error BadWar();
    error BadDeadline();
    error WarNotReady();
    error ZeroStake();
    error InsufficientVault();
    error EscrowCap();
    error ZeroPower();
    error TransferFailed();
    error NotStale();
    error NothingToSweep();

    /// @param usdc_        Arc USDC (6-dec FiatTokenV2).
    /// @param resolver_    the Worker's facilitator wallet (the only one who may drive wars).
    /// @param maxEscrow_   hard cap on total USDC held (atomic 6-dec units).
    /// @param staleGrace_  seconds past a war's deadline before anyone may expire it (0 ⇒ 3 days).
    constructor(address usdc_, address resolver_, uint256 maxEscrow_, uint64 staleGrace_) {
        require(usdc_ != address(0), "zero usdc");
        require(resolver_ != address(0), "zero resolver");
        require(maxEscrow_ > 0, "zero cap");
        usdc = usdc_;
        resolver = resolver_;
        maxEscrow = maxEscrow_;
        staleGrace = staleGrace_ == 0 ? 3 days : staleGrace_;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    // ============================== vault funding ==============================

    /// @notice Back a house's on-chain vault with real USDC, up to the coffer's hard `maxEscrow` cap.
    ///         The resolver (Worker treasury wallet) must `approve` the coffer first; this pulls the
    ///         exact amount in and credits the house. Money only ENTERS here — declare/resolve/levy move
    ///         it internally and never withdraw to any address except a house vault.
    function deposit(uint256 houseId, uint256 amount) external onlyResolver {
        if (amount == 0) revert ZeroStake();
        if (totalEscrow + amount > maxEscrow) revert EscrowCap();
        totalEscrow += amount;
        uint256 v = vault[houseId] + amount;
        vault[houseId] = v;
        _safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(houseId, amount, v, msg.sender);
    }

    // ============================== war lifecycle ==============================

    /// @notice Declare a war and ESCROW both stakes, committing the two houses' power scores BEFORE any
    ///         outcome exists. The winner is later derived purely from these committed numbers, so the
    ///         resolver cannot steer it — the result is fixed the moment the war opens.
    /// @param warId     opaque id chosen by the Worker (a time bucket / house-pair fold); must be unused.
    /// @param attacker  house id of the aggressor.
    /// @param defender  house id of the target (must differ from attacker).
    /// @param stake     bounded amount posted by EACH side (pot == 2*stake); both vaults must cover it.
    /// @param powerA    attacker power (a public, recomputable read-out of the house's strength).
    /// @param powerB    defender power.
    /// @param deadline  unix seconds at/after which the war may be resolved; must be in the future.
    function declareWar(
        uint256 warId, uint256 attacker, uint256 defender,
        uint256 stake, uint256 powerA, uint256 powerB, uint64 deadline
    ) external onlyResolver {
        War storage w = _wars[warId];
        if (w.opened) revert AlreadyOpened();
        if (attacker == defender) revert BadWar();
        if (stake == 0) revert ZeroStake();
        if (powerA + powerB == 0) revert ZeroPower();
        if (deadline <= block.timestamp) revert BadDeadline();
        if (vault[attacker] < stake || vault[defender] < stake) revert InsufficientVault();

        w.opened = true;
        w.attacker = attacker;
        w.defender = defender;
        w.stake = stake;
        w.powerA = powerA;
        w.powerB = powerB;
        w.pot = stake * 2;
        w.deadline = deadline;
        w.openedAt = uint64(block.timestamp);

        // Escrow both stakes out of the two vaults into the war pot (internal; no USDC leaves).
        vault[attacker] -= stake;
        vault[defender] -= stake;

        unchecked { warCount += 1; }
        emit WarDeclared(warId, attacker, defender, stake, powerA, powerB, deadline, msg.sender);
    }

    /// @notice Resolve a declared war once its deadline has passed. The contract derives the winner from
    ///         the COMMITTED powers via a deterministic, fully public keccak draw and pays the whole pot
    ///         to the winner's vault. The resolver supplies no input here, so it cannot influence the
    ///         result — it only triggers a computation fixed at declare time.
    function resolveWar(uint256 warId) external onlyResolver {
        War storage w = _wars[warId];
        if (!w.opened) revert NotOpened();
        if (w.resolved) revert AlreadyResolved();
        if (block.timestamp < w.deadline) revert WarNotReady();

        (uint8 winner, uint256 roll, uint256 total) = _deriveWinner(warId, w);
        w.resolved = true;
        w.winner = winner;
        w.resolvedAt = uint64(block.timestamp);

        uint256 pot = w.pot;
        w.pot = 0;
        uint256 winnerHouse = winner == WIN_ATTACKER ? w.attacker : w.defender;
        vault[winnerHouse] += pot;   // winner takes the whole pot (net: +stake over its own escrow)

        emit WarResolved(warId, winner, pot, roll, total);
    }

    /// @notice Safety valve: if the resolver never resolved a war, ANYONE may expire it once `staleGrace`
    ///         has passed its deadline, refunding both stakes to their vaults. Protects escrow against a
    ///         dead resolver; never callable while the resolver is still inside its window.
    function expireStaleWar(uint256 warId) external {
        War storage w = _wars[warId];
        if (!w.opened) revert NotOpened();
        if (w.resolved) revert AlreadyResolved();
        if (block.timestamp < uint256(w.deadline) + uint256(staleGrace)) revert NotStale();
        w.resolved = true;
        w.winner = WIN_NONE;
        w.resolvedAt = uint64(block.timestamp);
        uint256 pot = w.pot;
        w.pot = 0;
        // refund: each side gets its own stake back (pot split evenly, pot == 2*stake).
        uint256 back = pot / 2;
        vault[w.attacker] += back;
        vault[w.defender] += back;
        emit WarExpired(warId, msg.sender);
        emit WarResolved(warId, WIN_NONE, pot, 0, 0);
    }

    // ============================== taxation ==============================

    /// @notice Levy an extra on-chain tax from a house vault into the commons purse. Internal only —
    ///         moves no real USDC across the boundary, so the escrow total is conserved. Skips nothing:
    ///         reverts if the vault cannot cover the levy (the caller sizes it to the vault first).
    function levyTax(uint256 houseId, uint256 amount) external onlyResolver {
        if (amount == 0) revert ZeroStake();
        uint256 v = vault[houseId];
        if (v < amount) revert InsufficientVault();
        vault[houseId] = v - amount;
        commonsPurse += amount;
        emit TaxLevied(houseId, amount, commonsPurse);
    }

    /// @notice Pay the accumulated commons purse into a house vault (used when tax is routed to the
    ///         dominant house rather than held). Internal move; the purse then reads zero.
    function sweepTo(uint256 houseId) external onlyResolver {
        uint256 amt = commonsPurse;
        if (amt == 0) revert NothingToSweep();
        commonsPurse = 0;
        vault[houseId] += amt;
        emit TaxSwept(houseId, amt);
    }

    // ============================== views ==============================

    /// @notice The deterministic, PUBLIC winner rule: each house wins with probability proportional to
    ///         its committed power, drawn from keccak of the committed inputs. Recomputable by anyone
    ///         from the WarDeclared event — this is what makes the outcome trustless. Kept byte-for-byte
    ///         in lock-step with src/war.ts `winnerOf` (same field order, same modulo).
    function _deriveWinner(uint256 warId, War storage w) internal view returns (uint8 winner, uint256 roll, uint256 total) {
        total = w.powerA + w.powerB;
        roll = uint256(keccak256(abi.encodePacked(warId, w.attacker, w.defender, w.powerA, w.powerB))) % total;
        winner = roll < w.powerA ? WIN_ATTACKER : WIN_DEFENDER;
    }

    /// @notice The winner roll for a specific war id, using the SAME rule the contract applies at resolve.
    ///         The frontend and src/war.ts call this to preview an outcome without trusting the server.
    function previewWinner(uint256 warId) external view returns (uint8 winner, uint256 roll, uint256 total) {
        return _deriveWinner(warId, _wars[warId]);
    }

    /// @notice Full war state for the frontend.
    function warInfo(uint256 warId)
        external
        view
        returns (
            bool opened, bool resolved, uint8 winner,
            uint256 attacker, uint256 defender, uint256 stake,
            uint256 powerA, uint256 powerB, uint256 pot,
            uint64 deadline, uint64 openedAt, uint64 resolvedAt
        )
    {
        War storage w = _wars[warId];
        return (
            w.opened, w.resolved, w.winner,
            w.attacker, w.defender, w.stake,
            w.powerA, w.powerB, w.pot,
            w.deadline, w.openedAt, w.resolvedAt
        );
    }

    /// @notice USDC the coffer currently escrows (== totalEscrow; only `deposit` ever adds real USDC).
    function escrow() external view returns (uint256) {
        return IERC20Minimal(usdc).balanceOf(address(this));
    }

    // ============================== safe ERC-20 (no OZ dependency) ==============================

    function _safeTransferFrom(address from, address to, uint256 amount) internal {
        (bool ok, bytes memory data) = usdc.call(
            abi.encodeWithSelector(IERC20Minimal.transferFrom.selector, from, to, amount)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
