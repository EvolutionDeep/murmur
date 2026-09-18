// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  NeuralReceiptRegistry
/// @notice On-chain anchor for murmur's neural-provenance chain.
///
///         Every real USDC net transfer murmur broadcasts carries, as its EIP-3009 `nonce`, the
///         sha256 of a "neural receipt" bundling the frozen connectome read-outs of every trade
///         folded into it (see packages/trader-worker/src/provenance.ts). That nonce binding already
///         lives on-chain inside the transfer calldata / AuthorizationUsed event — but the receipt
///         HASH CHAIN itself (which receipt follows which) used to exist only in the worker's own
///         storage, i.e. verifiers had to trust the operator's /proofs endpoint for ordering.
///
///         This contract moves the chain head on-chain. Right after each transfer mines, the
///         facilitator calls commit(receiptHash, prevHead, tickIndex, constituents, txHash) where
///         prevHead MUST equal the contract's current chainHead. The contract rejects any commit
///         that breaks continuity, so the ordered hash chain is now reconstructible purely from
///         Arc RPC events — no murmur server required. Combined with reading the transfer's mined
///         nonce (== receiptHash), a verifier can confirm end-to-end, trustlessly, that a given
///         on-chain transfer is a link in the neural-receipt chain.
///
///         The contract holds NO funds and has NO upgrade path: it is a pure commitment log.
contract NeuralReceiptRegistry {
    /// @notice A single committed link of the neural-receipt chain.
    struct Commit {
        bytes32 prevHead;     // chainHead immediately before this receipt (continuity anchor)
        uint64  tickIndex;    // simulation tick that produced the receipt
        uint32  constituents; // number of folded trades whose neural drives are pinned in the receipt
        bytes32 txHash;       // the EIP-3009 transfer tx whose nonce == receiptHash
        uint64  ts;           // block.timestamp at commit (0 => not committed)
    }

    /// @notice The only address allowed to commit (the murmur facilitator / gas wallet).
    address public immutable committer;

    /// @notice Head of the on-chain receipt hash chain (bytes32(0) before the first commit/seed).
    bytes32 public chainHead;

    /// @notice Number of commits recorded (genesis seed does not count).
    uint256 public commitCount;

    /// @notice receiptHash => its commit link. `ts == 0` means "not committed".
    mapping(bytes32 => Commit) public commits;

    /// @notice Emitted for every committed receipt link; enough to rebuild the whole chain off-chain.
    event ReceiptCommitted(
        bytes32 indexed receiptHash,
        bytes32 indexed prevHead,
        uint64 tickIndex,
        uint32 constituents,
        bytes32 txHash,
        address by,
        uint256 ts
    );

    /// @notice Emitted once when the pre-existing (off-chain) chain head is adopted at deployment.
    event GenesisSeeded(bytes32 indexed head, address by, uint256 ts);

    error NotCommitter();
    error BadPrevHead();
    error AlreadyCommitted();
    error GenesisLocked();

    constructor(address committer_) {
        require(committer_ != address(0), "zero committer");
        committer = committer_;
    }

    /// @notice Adopt the receipt hash head that already existed off-chain before this contract was
    ///         deployed, so the first on-chain commit can chain onto it. Callable once, only by the
    ///         committer, and only before any commit.
    function seedGenesis(bytes32 head) external {
        if (msg.sender != committer) revert NotCommitter();
        if (commitCount != 0 || chainHead != bytes32(0)) revert GenesisLocked();
        chainHead = head;
        emit GenesisSeeded(head, msg.sender, block.timestamp);
    }

    /// @notice Append one receipt link to the on-chain chain.
    /// @param receiptHash  sha256 of the canonical neural receipt (== the transfer's EIP-3009 nonce).
    /// @param prevHead     chainHead immediately before this receipt; must equal current chainHead.
    /// @param tickIndex    simulation tick that produced the receipt.
    /// @param constituents folded trades pinned inside the receipt.
    /// @param txHash       the mined EIP-3009 transfer tx whose nonce == receiptHash.
    function commit(
        bytes32 receiptHash,
        bytes32 prevHead,
        uint64 tickIndex,
        uint32 constituents,
        bytes32 txHash
    ) external {
        if (msg.sender != committer) revert NotCommitter();
        if (prevHead != chainHead) revert BadPrevHead();
        if (commits[receiptHash].ts != 0) revert AlreadyCommitted();
        commits[receiptHash] = Commit(prevHead, tickIndex, constituents, txHash, uint64(block.timestamp));
        chainHead = receiptHash;
        unchecked { commitCount += 1; }
        emit ReceiptCommitted(receiptHash, prevHead, tickIndex, constituents, txHash, msg.sender, block.timestamp);
    }

    /// @notice True when `receiptHash` is a committed link of the on-chain chain.
    function isCommitted(bytes32 receiptHash) external view returns (bool) {
        return commits[receiptHash].ts != 0;
    }
}
