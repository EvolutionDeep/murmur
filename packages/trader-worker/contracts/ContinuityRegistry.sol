// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  ContinuityRegistry
/// @notice On-chain anchor for murmur's Proof of Continuous Agency (PoCA) protocol.
///
///         PoCA proves that an autonomous agent operated continuously over an extended period:
///         each "epoch" bundles many cron ticks into a Merkle-rooted digest chain, sealed on-chain
///         so that any observer can verify the agent never stopped. Epochs are chained: each one
///         stores the sealed head of its predecessor, forming an unbroken continuity proof that
///         spans the entire operational history.
///
///         The committer (murmur's facilitator wallet) calls openEpoch at the start of each
///         measurement window and sealEpoch once the window closes, committing the Merkle root
///         over all per-cron digests folded into that epoch. A separate adminAction channel logs
///         exceptional events (parameter overrides, DO rebuilds, code changes) that an auditor
///         needs to reason about continuity.
///
///         The contract holds NO funds and has NO upgrade path: it is a pure commitment log.
contract ContinuityRegistry {
    // ─────────────────────────────── types ───────────────────────────────

    /// @notice A single committed epoch of continuous agency.
    struct EpochRecord {
        bytes32 codeCommitment;   // sha256 of declared program identity for this epoch
        bytes32 genesisHead;      // digest-chain head at epoch open
        bytes32 sealedHead;       // digest-chain head at epoch seal
        uint64  startTs;          // block.timestamp at open
        uint64  endTs;            // block.timestamp at seal
        uint64  tickCount;        // cron digests folded into this epoch
        bytes32 merkleRoot;       // Merkle root over per-cron digests
        bytes32 prevEpochSeal;    // sealedHead of previous epoch (chain of epochs)
    }

    // ─────────────────────────────── storage ───────────────────────────────

    /// @notice The only address allowed to commit epochs (the murmur facilitator / gas wallet).
    address public immutable committer;

    /// @notice Total number of epochs opened (next index to be assigned).
    uint256 public epochCount;

    /// @notice epochIndex => its record.
    mapping(uint256 => EpochRecord) public epochs;

    // ─────────────────────────────── events ───────────────────────────────

    /// @notice Emitted when a new measurement epoch is opened.
    event EpochOpened(
        uint256 indexed epochIndex,
        bytes32 codeCommitment,
        bytes32 genesisHead,
        uint64 ts
    );

    /// @notice Emitted when an epoch is sealed with its final digest chain head and Merkle root.
    event EpochSealed(
        uint256 indexed epochIndex,
        bytes32 sealedHead,
        uint64 tickCount,
        bytes32 merkleRoot,
        uint64 ts
    );

    /// @notice Emitted for exceptional administrative actions that affect continuity reasoning.
    /// @dev kind enum: 1=RESET 2=MANUAL_TICK 3=PARAM_OVERRIDE 4=COMMITTER_CHANGE
    ///      5=GENESIS_SEED 6=DO_REBUILD 7=CODE_CHANGE
    event AdminAction(
        uint8 indexed kind,
        address actor,
        bytes32 payloadHash,
        uint64 ts
    );

    // ─────────────────────────────── errors ───────────────────────────────

    error NotCommitter();
    error EpochNotOpen();
    error AlreadySealed();
    error BadEpochIndex();
    error ZeroHash();

    // ─────────────────────────────── constructor ───────────────────────────────

    constructor(address committer_) {
        require(committer_ != address(0), "zero committer");
        committer = committer_;
    }

    // ─────────────────────────────── mutative ───────────────────────────────

    /// @notice Open a new measurement epoch. Assigns the next sequential index and chains onto
    ///         the previous epoch's sealed head.
    /// @param codeCommitment_  sha256 of the declared program identity for this epoch (non-zero).
    /// @param genesisHead_     Digest-chain head at the moment the epoch opens (non-zero).
    /// @return epochIndex      The index assigned to this new epoch.
    function openEpoch(bytes32 codeCommitment_, bytes32 genesisHead_) external returns (uint256 epochIndex) {
        if (msg.sender != committer) revert NotCommitter();
        if (codeCommitment_ == bytes32(0) || genesisHead_ == bytes32(0)) revert ZeroHash();

        epochIndex = epochCount;

        // Chain: prevEpochSeal = the sealed head of the immediately preceding epoch (0 for epoch 0).
        bytes32 prevSeal = (epochIndex == 0) ? bytes32(0) : epochs[epochIndex - 1].sealedHead;

        epochs[epochIndex] = EpochRecord({
            codeCommitment: codeCommitment_,
            genesisHead: genesisHead_,
            sealedHead: bytes32(0),
            startTs: uint64(block.timestamp),
            endTs: 0,
            tickCount: 0,
            merkleRoot: bytes32(0),
            prevEpochSeal: prevSeal
        });

        unchecked { epochCount += 1; }

        emit EpochOpened(epochIndex, codeCommitment_, genesisHead_, uint64(block.timestamp));
    }

    /// @notice Seal the most recently opened epoch with its final state.
    /// @param epochIndex_  Must equal epochCount - 1 (seal in order).
    /// @param sealedHead_  Digest-chain head at seal time (non-zero).
    /// @param tickCount_   Number of cron digests folded into this epoch.
    /// @param merkleRoot_  Merkle root over per-cron digests (non-zero).
    function sealEpoch(uint256 epochIndex_, bytes32 sealedHead_, uint64 tickCount_, bytes32 merkleRoot_) external {
        if (msg.sender != committer) revert NotCommitter();
        if (sealedHead_ == bytes32(0) || merkleRoot_ == bytes32(0)) revert ZeroHash();
        if (epochIndex_ >= epochCount || epochs[epochIndex_].startTs == 0) revert EpochNotOpen();
        if (epochs[epochIndex_].endTs != 0) revert AlreadySealed();
        if (epochIndex_ != epochCount - 1) revert BadEpochIndex();

        EpochRecord storage ep = epochs[epochIndex_];
        ep.sealedHead = sealedHead_;
        ep.endTs = uint64(block.timestamp);
        ep.tickCount = tickCount_;
        ep.merkleRoot = merkleRoot_;

        emit EpochSealed(epochIndex_, sealedHead_, tickCount_, merkleRoot_, uint64(block.timestamp));
    }

    /// @notice Log an administrative action that may affect continuity reasoning.
    /// @dev kind enum: 1=RESET 2=MANUAL_TICK 3=PARAM_OVERRIDE 4=COMMITTER_CHANGE
    ///      5=GENESIS_SEED 6=DO_REBUILD 7=CODE_CHANGE
    /// @param kind_         The action category (1–7).
    /// @param payloadHash_  sha256 of the action payload (arbitrary structured data).
    function adminAction(uint8 kind_, bytes32 payloadHash_) external {
        if (msg.sender != committer) revert NotCommitter();
        emit AdminAction(kind_, msg.sender, payloadHash_, uint64(block.timestamp));
    }

    // ─────────────────────────────── views ───────────────────────────────

    /// @notice Index of the current (most recently opened) epoch. Reverts if no epoch exists.
    function currentEpoch() external view returns (uint256) {
        if (epochCount == 0) revert BadEpochIndex();
        return epochCount - 1;
    }

    /// @notice Verify that the epoch chain is unbroken over the half-open range (from, to].
    /// @dev    True iff from <= to, to < epochCount, and for every epoch i in (from, to]:
    ///         · epochs[i].prevEpochSeal == epochs[i-1].sealedHead
    ///         · epochs[i].sealedHead != bytes32(0)  (epoch is sealed)
    ///         For from == to, trivially true if to < epochCount and epochs[to].sealedHead != 0.
    function isUnbroken(uint256 from, uint256 to) external view returns (bool) {
        if (from > to) return false;
        if (to >= epochCount) return false;

        for (uint256 i = from; i <= to; i++) {
            // Every epoch in the range must be sealed.
            if (epochs[i].sealedHead == bytes32(0)) return false;
            // Chain link check (skip for epoch 0: its prevEpochSeal is bytes32(0) by definition).
            if (i > 0) {
                if (epochs[i].prevEpochSeal != epochs[i - 1].sealedHead) return false;
            }
        }
        return true;
    }
}
