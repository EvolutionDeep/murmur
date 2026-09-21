# Neural simulation (`@fly/fly-brain`)

`packages/fly-brain` is the neural core. It has **no I/O, no chain access and no keys** — it is a pure,
deterministic spiking-network library the Worker drives. Everything a fly "decides" comes from here.

```
src/
  lif.ts            the Leaky Integrate-and-Fire network + spike-frequency adaptation (SFA)
  connectome.ts     buildConnectome(): the wiring grown from a seed (1,080 n default · 10,800 n in production)
  fly-brain.ts      FlyBrain: inject → advance → read motor; snapshot; serialize/deserialize
  motor-decoder.ts  motor firing rates → drives → behaviour (decoded relative to the population)
  stimuli.ts        market pulse + visitor stimulus → sensory-channel currents
  types.ts          shared types (SensoryInput, MotorOutput, FlyBehavior, BehaviorState, …)
```

---

## The connectome (1,080 neurons default · 10,800 in production)

`buildConnectome(opts)` grows a fruit-fly-shaped network deterministically from a seed. Defaults (overridable via
`BRAIN_N_*` / `BRAIN_DENSITY` vars) produce exactly **1,080 neurons**; the production `wrangler.toml` scales every
layer 10× (`1800/4000/4000/400/120`) to **10,800 neurons**:

| Layer | Count | Role |
|---|---|---|
| sensory | 180 | receive the encoded market pulse + stimuli |
| inter L1 | 400 | first integration layer |
| inter L2 | 400 | second layer (two mutually-inhibiting halves feed the wing/abdomen) |
| modulatory | 40 | arousal / gain modulation |
| motor | 60 | 5 channels × 12 — the read-out |

Synapse density defaults to `0.02` (~9,400 synapses at this size). Motor channels:
`leg_left`, `leg_right`, `wing`, `proboscis`, `abdomen`. Sensory channels carry the market pulse
(`thermal_warmth`, `thermal_flux`, `mechanical_turbulence`, `olfactory_density`, `gustatory_richness`), the fly's
own `internal_arousal`, and visitor stimuli (`stimulus_food/threat/light/dark`).

> Because Arc's `prevrandao` is always zero (no on-chain randomness), every source of entropy is seeded from the
> block number + the fly's seed, so a fly's wiring is stable and reproducible.

---

## The LIF network and the winner-take-all latch

`lif.ts` integrates membrane potentials at 1 ms steps, emits spikes, and tracks a per-neuron `firingRate`.
It includes **spike-frequency adaptation (SFA)** — a neuron that fires hard builds an adaptation current that
temporarily raises its threshold.

**Why SFA is load-bearing.** The inter-layer competition is winner-take-all. Without SFA the network **hard-latches**:
one motor leg pins at maximum rate, its antagonist goes silent, and the fly never flips — the swarm freezes. SFA
(tuned `adaptIncrement = 0.05`) lets the winner tire so the population keeps oscillating. `FlyBrain.serialize()`
writes **version 3** archives to mark brains saved under the tuned SFA; `deserialize()` deliberately **discards the
electrical state of pre-v3 archives** (v1 pre-SFA, v2 latched under a too-weak 0.03 SFA) and wakes them fresh while
keeping the simulation clock — SFA then prevents re-latching. The connectome is rebuilt from the seed, so identity
is preserved.

This is also why the **economy is a one-directional read-out** of the neural layer: money never feeds back into the
connectome, so it cannot re-destabilise the WTA dynamics.

---

## From spikes to behaviour

### 1. Read raw drives (`readRawDrives`)

Motor firing rates are normalised (50 Hz = full output) and combined into four drives:

```
arousal  = ½(leg_left + leg_right) + wing     locomotor + wing-beat = overall activity
turn     = leg_left − leg_right               steering asymmetry (−1..1)
cohesion = proboscis                          appetitive approach → seek the swarm centre
rest     = abdomen                            abdominal stillness tone
```

### 2. Normalise against the population (`computeBands`)

Calibration showed the normalised rates are small and **strongly channel-asymmetric** (legs reach ~0.4, proboscis
~0.2, wing/abdomen stay under ~0.06 because both mutually-inhibiting L2 halves partly cancel). A single absolute
threshold is therefore meaningless across channels and across each fly's unique wiring. Instead, each tick we take
robust **10–90 percentiles** across the population and read every fly **relative to its peers** (`REF_BANDS` is the
fallback for standalone/single-fly decoding, e.g. tests).

### 3. Decode (`MotorDecoder.decode`)

```
rendered drive = clamp01( collectiveBase(temperature) + spread · (relativeStanding − ½) )
```

The **temperature** anchors the collective regime; the **relative standing** spreads individuals around it and picks
the minority that breaks rank. State selection (with a short hysteresis to stop tick-to-tick flicker):

| Regime | Base state | Minority that breaks rank |
|---|---|---|
| `HOT` (T ≥ 0.66) | AGITATE | least-active → EXPLORE |
| `COLD` (T ≤ 0.33) | AGGREGATE (huddle) | stillest → REST |
| `CALM` | EXPLORE | most aroused → AGITATE; most cohesive → AGGREGATE |

Defaults (`DEFAULT_DECODER_CONFIG`): `spread 0.45`, `lowQ 0.25`, `highQ 0.75`, `hysteresisSteps 2`. The result is a
`FlyBehavior`: `state` + continuous `arousal / turnBias / cohesion / wingbeat / rest` + a `neuralFingerprint`
(a doubled FNV-1a 32-bit hash of the motor output — **non-cryptographic**, used only for display/identity colour).

---

## Sensory encoding (`stimuli.ts`)

`encodeMarketPulse(pulse)` maps the Arc market pulse onto shared sensory currents (a biological analogy):
temperature → thermosensation, momentum → optic flow, turbulence → mechanosensation (Johnston's organ), density →
olfaction, richness → gustation, and the optional per-fly `arousal` → interoception. `encodeStimulus(event)` maps a
visitor poke to a short 3-second perturbation on its channel. `FlyBrain.inject()` spreads a channel's intensity as
external current across that channel's neurons, on top of a constant spontaneous-noise current so the fly is never
fully silent.

---

## Verifying it runs

```bash
npm run smoke      # npx tsx packages/fly-brain/smoke.ts
```

The smoke test grows a small population, sweeps the temperature COLD → HOT, and asserts the connectome produces
**≥3 distinct behavioural states** and survives a serialize round-trip — no chain, no keys. CI runs it on every
push/PR (see [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)).
