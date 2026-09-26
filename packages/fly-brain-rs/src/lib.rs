//! fly-brain-rs — a bit-exact Rust port of murmur's TypeScript fly-brain (`packages/fly-brain/src`:
//! connectome, LIF network, FlyBrain, genome operators, brain manifest).
//!
//! "Bit-exact" means: given the same `ConnectomeOptions`, the same injections and the same tick
//! sequence, every neuron parameter, synapse weight, f32 state variable, spike flag, noise-source
//! state and `readMotor` read-out is identical — by bit pattern — to what the TypeScript produces
//! under Node 22. The parity suite (`tests/parity.rs`) asserts this against traces generated from
//! the TypeScript by `tests/gen/gen_fixtures.ts` (and `tests/gen/gen_fuzz.ts`) with no tolerance.
//!
//! Achieving that required reproducing not the mathematics but the *arithmetic*: JS `Number`
//! evaluation with `Float32Array` stores (`lif.rs`), the two PRNGs on wrapping u32 (`prng.rs`),
//! V8's `Math.round` (`jsmath.rs`), and — the part that is not obvious — the exact transcendental
//! implementations V8 evaluates `Math.log/cos/exp/tanh` with, including the fused multiply-adds
//! the compiler emitted when building Node for AArch64 (`v8math.rs`). See README.md.
//!
//! No `unsafe`, no platform libm, no I/O. Dependencies: `serde`, `serde_json` (for the genome
//! and archive JSON shapes). Builds for `wasm32-unknown-unknown`.

#![forbid(unsafe_code)]
// `next()` / `from_str()` mirror the TS names (`rand()`, channel lookup) on purpose.
#![allow(clippy::should_implement_trait, clippy::new_without_default)]

pub mod brain;
pub mod connectome;
pub mod genome;
pub mod jsmath;
pub mod lif;
pub mod manifest;
pub mod prng;
pub mod v8math;

pub use brain::{BrainArchive, FlyBrain, MotorOutput};
pub use connectome::{
    build_connectome, Connectome, ConnectomeOptions, MotorChannel, NeuronKind, SensoryChannel,
    DEFAULT_CONNECTOME_OPTIONS, MOTOR_CHANNELS, SENSORY_CHANNELS,
};
pub use genome::{
    build_from_genome, canonical_genome, crossover_genome, estimate_connectome_size, genome_from_options,
    genome_to_connectome_options, mutate_genome, Genome, DENSITY_BOUNDS, GENOME_SCHEMA_VERSION,
};
pub use lif::{LifNetwork, LifNetworkJson};
pub use manifest::{connectome_structural_spec, ConnectomeStructuralSpec};
