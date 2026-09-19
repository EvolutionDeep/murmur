// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title  ConnectomeLineage
/// @notice On-chain LINEAGE registry for murmur's connectome BREEDING market — the "tradeable,
///         breedable brains with on-chain ancestry" layer.
///
///         A connectome's complete heritable identity is its GENOME: the effective generator
///         parameters (seed + per-layer counts + density) that deterministically rebuild it
///         (packages/fly-brain/src/genome.ts). genomeHash = sha256(canonical(genome)). Breeding applies
///         pure operators (point-mutation / uniform-crossover) to parent genomes; the offspring genome,
///         its parents' hashes, the operator and the generation are committed HERE so ancestry is a
///         public, tamper-evident fact — not a server-side claim.
///
///         LINEAGE INTEGRITY is enforced in-contract:
///           • genesis  (op=0): no parents, generation 0 — registers a base-population brain.
///           • mutate   (op=1): exactly one parent, already committed; generation = parent.gen + 1.
///           • cross    (op=2): both parents already committed; generation = max(genA,genB) + 1.
///         A genome hash can be committed only once, and only the committer (the murmur facilitator /
///         gas wallet) may commit. Because parents must already exist on-chain, a forged "child" of a
///         brain that was never committed cannot be recorded, and generations can never skip.
///
///         Trustless verification (no murmur server required): read a committed (genomeHash, parents,
///         op, generation) off Arc, fetch the genome body (worker /lineage/:hash), recompute
///         sha256(canonical(genome)) — it must equal genomeHash — then rebuild the connectome from the
///         genome and re-derive its structural spec (specFromGenome) to confirm the published brain is
///         exactly what that genome deterministically generates.
///
///         The contract holds NO funds and has NO upgrade path — it is a pure commitment log. Royalties
///         and breeding fees settle off-chain over x402 to the recorded `breeder` address; this contract
///         only makes "who bred whom, from whom" publicly verifiable.
contract ConnectomeLineage {
    uint8 public constant OP_GENESIS = 0;
    uint8 public constant OP_MUTATE = 1;
    uint8 public constant OP_CROSS = 2;

    /// @notice One committed connectome genome + its ancestry.
    struct Lineage {
        bytes32 genomeHash;  // sha256(canonical(Genome))
        bytes32 parentA;     // bytes32(0) for genesis
        bytes32 parentB;     // bytes32(0) unless op == OP_CROSS
        uint8   op;          // OP_GENESIS | OP_MUTATE | OP_CROSS
        uint32  generation;  // 0 for genesis; max(parents.gen)+1 otherwise
        address breeder;     // address credited with breeding this genome (royalty payee off-chain)
        uint64  ts;          // block.timestamp at commit (0 => not committed)
    }

    /// @notice The only address allowed to commit (the murmur facilitator / gas wallet).
    address public immutable committer;

    /// @notice The most recently committed genome hash (bytes32(0) before the first commit).
    bytes32 public latestHash;

    /// @notice Number of genomes recorded (genesis + bred).
    uint256 public commitCount;

    /// @notice genomeHash => its lineage. `ts == 0` means "not committed".
    mapping(bytes32 => Lineage) public lineages;

    /// @notice parent genomeHash => number of committed children (a cheap on-chain fertility counter).
    mapping(bytes32 => uint32) public childCount;

    /// @notice Emitted for every committed genome; enough to rebuild the whole family tree off-chain.
    event LineageCommitted(
        bytes32 indexed genomeHash,
        bytes32 indexed parentA,
        bytes32 parentB,
        uint8 op,
        uint32 generation,
        address breeder,
        uint256 ts
    );

    error NotCommitter();
    error AlreadyCommitted();
    error ZeroHash();
    error ZeroBreeder();
    error BadOp();
    error ParentNotCommitted();
    error BadGenesis();
    error BadGeneration();

    constructor(address committer_) {
        require(committer_ != address(0), "zero committer");
        committer = committer_;
    }

    /// @notice Record a connectome genome + its ancestry on-chain.
    /// @param genomeHash  sha256 of the canonical Genome body.
    /// @param parentA     first parent's committed genomeHash (bytes32(0) for genesis).
    /// @param parentB     second parent's committed genomeHash (only for OP_CROSS; else bytes32(0)).
    /// @param op          OP_GENESIS | OP_MUTATE | OP_CROSS.
    /// @param generation  0 for genesis; max(parents' generation)+1 otherwise.
    /// @param breeder     address credited with breeding this genome.
    function commit(
        bytes32 genomeHash,
        bytes32 parentA,
        bytes32 parentB,
        uint8 op,
        uint32 generation,
        address breeder
    ) external {
        if (msg.sender != committer) revert NotCommitter();
        if (genomeHash == bytes32(0)) revert ZeroHash();
        if (lineages[genomeHash].ts != 0) revert AlreadyCommitted();
        if (breeder == address(0)) revert ZeroBreeder();

        if (op == OP_GENESIS) {
            if (parentA != bytes32(0) || parentB != bytes32(0) || generation != 0) revert BadGenesis();
        } else if (op == OP_MUTATE) {
            if (parentA == bytes32(0) || parentB != bytes32(0)) revert BadOp();
            if (lineages[parentA].ts == 0) revert ParentNotCommitted();
            if (generation != lineages[parentA].generation + 1) revert BadGeneration();
        } else if (op == OP_CROSS) {
            if (parentA == bytes32(0) || parentB == bytes32(0)) revert BadOp();
            if (lineages[parentA].ts == 0 || lineages[parentB].ts == 0) revert ParentNotCommitted();
            uint32 maxGen = lineages[parentA].generation > lineages[parentB].generation
                ? lineages[parentA].generation
                : lineages[parentB].generation;
            if (generation != maxGen + 1) revert BadGeneration();
        } else {
            revert BadOp();
        }

        lineages[genomeHash] = Lineage(genomeHash, parentA, parentB, op, generation, breeder, uint64(block.timestamp));
        latestHash = genomeHash;
        unchecked {
            commitCount += 1;
            if (parentA != bytes32(0)) childCount[parentA] += 1;
            if (parentB != bytes32(0)) childCount[parentB] += 1;
        }
        emit LineageCommitted(genomeHash, parentA, parentB, op, generation, breeder, block.timestamp);
    }

    /// @notice True when `genomeHash` has been committed.
    function isCommitted(bytes32 genomeHash) external view returns (bool) {
        return lineages[genomeHash].ts != 0;
    }

    /// @notice The generation of a committed genome (0 for genesis); reverts-safe via ts check off-chain.
    function generationOf(bytes32 genomeHash) external view returns (uint32) {
        return lineages[genomeHash].generation;
    }

    /// @notice The address credited with breeding a committed genome.
    function breederOf(bytes32 genomeHash) external view returns (address) {
        return lineages[genomeHash].breeder;
    }
}
