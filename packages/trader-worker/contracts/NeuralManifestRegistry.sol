// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  NeuralManifestRegistry
/// @notice On-chain anchor for murmur's BRAIN MANIFEST — the "prove the brain, trustlessly" commitment.
///
///         provenance.ts already binds every real USDC transfer to the neural read-out that caused it
///         (sha256(receipt) == the EIP-3009 nonce, mirrored by NeuralReceiptRegistry). This contract
///         anchors the layer BELOW that: the identity of the connectomes themselves.
///
///         A `BrainManifest` (see packages/trader-worker/src/manifest.ts) commits to the generator
///         parameters, the per-fly seeds (seed[i] = (base + i*7919) >>> 0), the LIF dynamics constants,
///         the decoder config, and a quantised STRUCTURAL SPEC of every fly's connectome. The worker
///         computes manifestHash = sha256(canonical(manifest)) and the committer records that ONE hash
///         here. The contract holds NO funds and has NO upgrade path — it is a pure commitment log.
///
///         Trustless verification (no murmur server required):
///           1. Read a committed manifestHash off Arc (this contract's events / manifests()).
///           2. Fetch the manifest body (worker /manifest or its IPFS CID) and recompute
///              sha256(canonical(body)) — it must equal the committed hash ⇒ the body is untampered.
///           3. Rebuild every connectome from the committed (seed, opts) and re-derive each structural
///              spec (replayVerifyManifest) — they must match ⇒ the published brains are EXACTLY what
///              those seeds deterministically generate. No hidden wiring, no LLM, reproducible by anyone.
///
///         Manifests are independent point-in-time identities (a config/sizing change yields a new one),
///         so — unlike the receipt chain — they do NOT hash-chain; `latestHash` + `commitCount` + the
///         event log (fully reconstructible from RPC) record the history.
contract NeuralManifestRegistry {
    /// @notice One committed brain-manifest identity.
    struct Manifest {
        bytes32 manifestHash;   // sha256(canonical(BrainManifest))
        uint32  schemaVersion;  // BrainManifest.v (MANIFEST_SCHEMA_VERSION)
        uint32  population;     // number of flies the manifest commits to
        uint64  ts;             // block.timestamp at commit (0 => not committed)
    }

    /// @notice The only address allowed to commit (the murmur facilitator / gas wallet).
    address public immutable committer;

    /// @notice The most recently committed manifest hash (bytes32(0) before the first commit).
    bytes32 public latestHash;

    /// @notice Number of manifests recorded.
    uint256 public commitCount;

    /// @notice manifestHash => its commitment. `ts == 0` means "not committed".
    mapping(bytes32 => Manifest) public manifests;

    /// @notice Emitted for every committed manifest; enough to rebuild the history off-chain.
    event ManifestCommitted(
        bytes32 indexed manifestHash,
        uint32 schemaVersion,
        uint32 population,
        address by,
        uint256 ts
    );

    error NotCommitter();
    error AlreadyCommitted();
    error ZeroHash();

    constructor(address committer_) {
        require(committer_ != address(0), "zero committer");
        committer = committer_;
    }

    /// @notice Record a brain-manifest identity on-chain.
    /// @param manifestHash  sha256 of the canonical BrainManifest body.
    /// @param schemaVersion the manifest's schema version (BrainManifest.v).
    /// @param population    number of flies the manifest commits to (informational; the body is authority).
    function commit(bytes32 manifestHash, uint32 schemaVersion, uint32 population) external {
        if (msg.sender != committer) revert NotCommitter();
        if (manifestHash == bytes32(0)) revert ZeroHash();
        if (manifests[manifestHash].ts != 0) revert AlreadyCommitted();
        manifests[manifestHash] = Manifest(manifestHash, schemaVersion, population, uint64(block.timestamp));
        latestHash = manifestHash;
        unchecked { commitCount += 1; }
        emit ManifestCommitted(manifestHash, schemaVersion, population, msg.sender, block.timestamp);
    }

    /// @notice True when `manifestHash` has been committed.
    function isCommitted(bytes32 manifestHash) external view returns (bool) {
        return manifests[manifestHash].ts != 0;
    }
}
