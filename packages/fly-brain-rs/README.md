# fly-brain-rs — a bit-exact Rust port of `@fly/fly-brain`

A Rust port of the neural core in [`packages/fly-brain`](../fly-brain) — `buildConnectome`,
`LifNetwork`, `FlyBrain` (inject / tick / readMotor / serialize), the genome operators and
`connectomeStructuralSpec` — whose acceptance criterion is **bit-exact parity** with the
TypeScript as executed by Node 22: not "close", the same bits.

It exists for offline replay and research (re-running a fly's history from its seed and stimulus
log, population-scale experiments, fixtures for other tooling) and as a base for a future Wasm
build. It is not wired into the Worker and changes nothing in the TypeScript.

```
# from the repository root
npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fixtures.ts   # ~10 s: traces from the TS reference
cd packages/fly-brain-rs && cargo test --release                # replays them in Rust, no tolerance
```

Without the first step the tests run against the small committed set in `tests/fixtures/small`
(< 1 MB); the full set is ~15 MB and gitignored.

## What "bit-exact" covers

Given the same `ConnectomeOptions`, the same `inject()` calls and the same `tick()` sequence, the
port reproduces — by bit pattern — every neuron parameter (`tau`, `vThresh`, …), every synapse
`(pre, post, w)`, every `Float32Array` state variable (`V`, `Isyn`, `Iext`, `adaptation`,
`lastSpikeT`, `firingRate`), the spike flags, the xorshift32 noise state, `readMotor` /
`readAllMotor`, `mutateGenome` / `crossoverGenome` / `canonicalGenome` /
`estimateConnectomeSize`, and the manifest's structural spec including `edgeHash`.

`tests/parity.rs` asserts this against traces from the TypeScript (`tests/gen/gen_fixtures.ts`):

| fixture | what |
|---|---|
| `prng.json` | mulberry32 (both copies) and FlyBrain's xorshift32, 64 draws × 5 seeds, float + raw u32 |
| `mathfns.json` | `Math.log/cos/exp/tanh/sqrt/sin` on ~25k inputs as hex bit patterns, incl. argument-reduction and overflow edges |
| `connectome_<seed>.json` × 3 | every neuron and synapse at the default sizing, `byKind`/`byChannel`, structural spec |
| `dynamics_<seed>.json` × 3 | 2000 ticks under a fixed 5-channel drive; a sha256 of the full state after **every** step, plus the full f32 state, spike flags, noise state and `readMotor` at 47 snapshots |
| `genome_ops.json` | 6 parent pairs × (mutate, crossover, ±1 seeds), canonical JSON, size estimates, a 40-step mutation chain |

Comparison is by `to_bits()` for f32/f64 and exact equality for integers. There are no
tolerances anywhere. The per-step hashes mean a divergence is reported at the exact step, and
the snapshots then name the element and bit.

### Fuzz parity (opt-in, heavier)

`tests/gen/gen_fuzz.ts` samples **230 genomes** — 200 uniform within `GENOME_BOUNDS`, 20 at the
production 10x sizing (1800/4000/4000/400/120), 10 at the bounds' corners (down to 33 neurons /
179 synapses and up to 14,500 neurons / 9.1 M synapses) — and runs each for 1,000 steps under a
per-genome random stimulus stream (random channel subsets, intensities up to 5, some silent
steps), recording a state hash every 100 steps and the motor read-outs at the end; plus three
genomes for 10,000 steps with checkpoints every 1,000; plus three `serialize()` →
`deserialize()` round-trips continued for 500 more steps. The fixture is ~600 KB (hashes plus the three serialized archives).

```
npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fuzz.ts     # ~10–20 min single-core
cd packages/fly-brain-rs && cargo test --release -- --include-ignored
```

Result on the reference machine (Apple silicon, Node v22.22.0 arm64): 230/230 genomes (33 to
14,500 neurons, 179 to 9,134,228 synapses), 2,330/2,330 checkpoints, 264,500 brain-steps,
393 M spikes, 684k injections — all bit-exact; the three serialize round-trips match both the
restored and the uninterrupted continuation.

## What had to be matched exactly

* **`Float32Array` semantics.** The TypeScript keeps neuron state in `Float32Array` but evaluates
  every expression in f64; only the store rounds. `lif.rs` widens each operand in the TS
  association order and narrows once per assignment. Synapse iteration is the CSR order of a
  stable sort by post neuron.
* **PRNGs.** mulberry32 (both copies) and xorshift32 are u32 wrapping arithmetic (`Math.imul` ≡
  wrapping mul, `>>> 0` / `| 0` ≡ bit reinterpretation).
* **`Math.round`** is V8's `ceil(x) - (ceil(x) - 0.5 > x)`, not Rust's half-away-from-zero.
* **Transcendentals.** Neither Rust's platform libm nor the `libm` crate is bit-identical to V8:
  they disagree on ~1–2 % of inputs for `log`, `cos`, `tanh`. `src/v8math.rs` therefore ports
  V8's own fdlibm sources (`src/base/ieee754.cc`) for `exp`, `log`, `expm1`, `tanh`, `cos`, `sin`
  including the full `__ieee754_rem_pio2` / `__kernel_rem_pio2` reduction — **and** the fused
  multiply-adds clang emitted when compiling them (next section). Every `mul_add` site carries a
  comment quoting the C expression it fuses.
* **`serialize()` / `deserialize()`.** `FlyBrain::serialize` / `deserialize` follow the reference's
  rules exactly (version gate, size gate, `noiseState`), including the detail that `fromJSON`
  does not restore the spike flags or the previous-step spike buffer — a restored brain
  propagates no synaptic input on its first tick. The archive text is not byte-identical (JS and
  serde_json switch to exponent notation at different magnitudes) but the values are, and the
  parity test checks both directions.

## Platform note (worth knowing even if you never run the Rust)

The transcendental outputs of the TypeScript itself are **build-specific at the last bit**.
Node's V8 is compiled by clang with its default `-ffp-contract=on`, which fuses `a*b + c` inside
one expression into a single FMA *when the target ISA has one*. AArch64 always does; baseline
x86-64 does not. Measured by regenerating the fixtures with the official x86-64 Node v22.22.0
build (under Rosetta) and diffing against the arm64 ones on the same machine:

| | arm64 vs x86-64 Node |
|---|---|
| `Math.exp`, `Math.sqrt` | identical (5,013 + 4,000 samples) |
| `Math.log` | 70 / 4,000 differ by 1 ULP |
| `Math.cos` | 24 / 4,000 differ by 1 ULP |
| `Math.tanh` | 2 / 6,012 differ by 1 ULP |
| connectome f64 weights | 17–28 of ~9,370 per seed differ by 1 ULP |
| connectome weights **after the f32 store** | 0 differ |
| `dynamics_*.json`, structural spec (`edgeHash`, `weightMilli`) | byte-identical |

So the *dynamics* — what the flies do — are reproducible across both builds, because
`LifNetwork` stores weights as f32 and the 1-ULP f64 differences never survive the rounding, and
`manifest.ts` already quantises weights to 1e-3 for the digest. Only code that compares raw f64
`Synapse.w` or `Math.log/cos` results across machines would notice.

This port targets the arm64 (FMA) build: the parity suite passes 100 % against arm64 fixtures and,
against the x86-64 fixtures, fails exactly the `log`/`cos`/`tanh` samples and f64 weights listed
above while every dynamics and genome test still passes. Removing the `mul_add`s would flip that
(see the header of `src/v8math.rs`).

## Performance

Same workload, same machine, measured while the machine was under heavy unrelated load (load
average ≈ 40 on 10 cores), so treat the absolute numbers as pessimistic and the ratio as the
signal. Final `firingRate` checksums were identical between the two.

| sizing | TypeScript (Node 22) | Rust (release) |
|---|---|---|
| default 1x, 1,080 neurons / 9,376 synapses, 498 steps — idle machine | 11.0 ms/fly (`bench-capacity.ts`) | 1.96 ms/fly (3.9 µs/step) |
| default 1x, 498 steps — under load (load avg ≈ 40) | 34.2 ms/fly (68.7 µs/step) | 7.7 ms/fly (15.6 µs/step) |
| production 10x, 10,800 neurons / 830,397 synapses, 498 steps | 2,024 ms (4.06 ms/step) | 430 ms (0.86 ms/step) |
| 10x connectome build | 202 ms | 56 ms |

The per-step work is fused into two passes (synaptic, per-neuron) and the synaptic pass touches
only the synapses whose pre neuron spiked, walking each post's CSR range in ascending order so the
f64 accumulation order — hence every rounding — is the TypeScript's. Unloaded, expect roughly
2–3× lower absolute times on the same hardware.

## Wasm

`cargo build --release --target wasm32-unknown-unknown` compiles (the crate has no I/O and no
platform libm). Not yet executed or bound to JS — `f64::mul_add` lowers to a software FMA on
wasm32 (correct, slower), which only matters for the transcendentals in connectome construction,
not the per-step loop. Bindings are a possible follow-up.

## Layout

```
src/prng.rs        mulberry32, xorshift32
src/jsmath.rs      Math.round/min/max/sign/imul, ToInt32, Number→string
src/v8math.rs      V8/fdlibm exp, log, expm1, tanh, cos, sin — with clang's FMA contraction
src/connectome.rs  buildConnectome
src/lif.rs         LifNetwork (+ toJSON / fromJSON)
src/brain.rs       FlyBrain (inject / tick / advance / readMotor / readAllMotor / serialize / deserialize)
src/genome.rs      Genome, mutate, crossover, canonical JSON, estimateConnectomeSize
src/manifest.rs    connectomeStructuralSpec
tests/parity.rs    the parity suite
tests/gen/         gen_fixtures.ts (--small for the committed set), gen_fuzz.ts
tests/fixtures/    small/ committed; the rest generated
```

`#![forbid(unsafe_code)]`; dependencies are `serde` + `serde_json` (genome / archive JSON), plus
`sha2` for tests. Formatted with the crate's `rustfmt.toml`; clippy-clean with `-D warnings`.

## Regenerating fixtures

```
npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fixtures.ts            # full set → tests/fixtures
npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fixtures.ts --small    # committed set → tests/fixtures/small
npx --yes tsx packages/fly-brain-rs/tests/gen/gen_fuzz.ts                # fuzz set (opt-in tests)
FLY_BRAIN_RS_FIXTURES=/some/dir cargo test --release                     # run against another set
```

Fixtures must be regenerated whenever `packages/fly-brain/src` changes a numeric path; the parity
suite is the change detector.

## License

MIT, like the rest of murmur. The engine design, calibration and all comments on *why* belong to
the TypeScript original in `packages/fly-brain`; this is a transcription.
