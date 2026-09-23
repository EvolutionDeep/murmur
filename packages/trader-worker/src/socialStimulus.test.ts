// ① NEURAL FEEDBACK BUS tests — the pure climate→stimulus mapping + the config gate that keeps it inert.
//
// socialStimuli() writes straight into the live neural input that drives REAL trades, so the two things that
// MUST be pinned are exactly the war.ts / arena.ts discipline:
//   1. ZERO REGRESSION WHEN OFF / EMPTY — a null climate (cold cron) or a zero ceiling must emit NOTHING, so
//      the cron's stimulus array is byte-for-byte today's pendingStimuli. The config switch defaults OFF.
//   2. BOUNDED + DETERMINISTIC — every emitted intensity is in [0, maxIntensity], light and dark are NEVER
//      both present (one net brightness axis), at most three events are produced, and the same inputs always
//      yield the same floats (no RNG, no clock) so the felt climate is reproducible on every engine.
// On top of those invariants we pin the MAPPING: each civilizational condition lands on the biologically-correct
// visitor channel (golden/boom → light+food, dark/freeze → dark, plague/famine/oligarchy → threat).

import test from "node:test";
import assert from "node:assert/strict";

import {
  socialStimuli,
  type CivilizationState,
  type CivPhase,
  type SocShock,
  type SocialStimulusConfig,
} from "./socialStimulus.js";
import { loadConfig, type Env } from "./config.js";

// ---------- helpers ----------

const CAP: SocialStimulusConfig = { maxIntensity: 0.5 };

function civ(phase: CivPhase, level: number, shock: SocShock = null): CivilizationState {
  return { civPhase: phase, civLevel: level, eraShock: shock };
}

/** The single event of a channel type, or null. */
function pick(events: { type: string; intensity: number }[], type: string) {
  return events.find((e) => e.type === type) ?? null;
}

function closeTo(actual: number, expected: number, msg?: string) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${msg ?? ""} expected ~${expected}, got ${actual}`);
}

/** A minimal, valid Env (only the required fields matter for config parsing; the rest default). */
function env(over: Partial<Env> = {}): Env {
  return {
    FLY_STATE: {} as Env["FLY_STATE"],
    CHAIN_ID: "5042002",
    RPC_URL: "https://rpc.testnet.arc.io",
    ...over,
  } as Env;
}

// ================= OFF / EMPTY: zero regression =================

test("a null climate (a cold cron before the historian loads) emits NOTHING", () => {
  assert.deepEqual(socialStimuli(null, CAP), []);
});

test("a zero master ceiling emits NOTHING even for the most extreme age", () => {
  assert.deepEqual(socialStimuli(civ("golden", 100, "BOOM"), { maxIntensity: 0 }), []);
  assert.deepEqual(socialStimuli(civ("dark", 0, "PLAGERA"), { maxIntensity: 0 }), []);
});

test("a NaN ceiling (defence-in-depth) emits NOTHING rather than poisoning the connectome", () => {
  // A malformed SOCIAL_STIMULUS_MAX must never leak a NaN intensity into injectCurrent. config.ts already
  // falls back to 0.5; this pins the module's OWN guard so the brain stays safe even if a NaN slips through.
  assert.deepEqual(socialStimuli(civ("golden", 100, "BOOM"), { maxIntensity: NaN }), []);
  assert.deepEqual(socialStimuli(civ("dark", 0, "PLAGERA"), { maxIntensity: NaN }), []);
});

test("a non-finite civLevel never yields a NaN intensity (the shock overlay still reads coherently)", () => {
  for (const shock of SHOCKS) {
    for (const phase of PHASES) {
      for (const e of socialStimuli(civ(phase, NaN, shock), CAP)) {
        assert.ok(Number.isFinite(e.intensity), `${phase}/${shock}: ${e.type} intensity must be finite`);
      }
    }
  }
});

test("the config switch defaults OFF and the ceiling defaults to 0.5", () => {
  const cfg = loadConfig(env());
  assert.equal(cfg.socialStimulus.enabled, false, "SOCIAL_STIMULUS_ENABLED must default false (dark deploy)");
  closeTo(cfg.socialStimulus.maxIntensity, 0.5, "default ceiling");
});

test("the config switch parses + clamps exactly like the other membrane knobs", () => {
  assert.equal(loadConfig(env({ SOCIAL_STIMULUS_ENABLED: "true" })).socialStimulus.enabled, true);
  assert.equal(loadConfig(env({ SOCIAL_STIMULUS_ENABLED: "TRUE" })).socialStimulus.enabled, true);
  assert.equal(loadConfig(env({ SOCIAL_STIMULUS_ENABLED: "false" })).socialStimulus.enabled, false);
  assert.equal(loadConfig(env({ SOCIAL_STIMULUS_ENABLED: "nonsense" })).socialStimulus.enabled, false);
  // the ceiling clamps into [0,1]; a malformed value falls back to the 0.5 default
  closeTo(loadConfig(env({ SOCIAL_STIMULUS_MAX: "0.8" })).socialStimulus.maxIntensity, 0.8);
  closeTo(loadConfig(env({ SOCIAL_STIMULUS_MAX: "5" })).socialStimulus.maxIntensity, 1, "clamped to 1");
  closeTo(loadConfig(env({ SOCIAL_STIMULUS_MAX: "-3" })).socialStimulus.maxIntensity, 0, "clamped to 0");
  closeTo(loadConfig(env({ SOCIAL_STIMULUS_MAX: "junk" })).socialStimulus.maxIntensity, 0.5, "fallback");
});

// ================= DETERMINISM =================

test("the same climate always yields byte-identical events (no RNG, no clock)", () => {
  const cases: CivilizationState[] = [
    civ("golden", 100, "BOOM"),
    civ("dark", 0, "PLAGERA"),
    civ("declining", 33, "FAMINE"),
    civ("ascendant", 62, null),
    civ("golden", 80, "DYNASTIC"),
  ];
  for (const c of cases) {
    const a = socialStimuli(c, CAP);
    const b = socialStimuli(c, CAP);
    assert.deepEqual(a, b, `deterministic for ${c.civPhase}/${c.civLevel}/${c.eraShock}`);
    // a fresh config object with the same ceiling must not change anything (no hidden state)
    assert.deepEqual(socialStimuli(c, { maxIntensity: 0.5 }), a);
  }
});

// ================= BOUNDED INVARIANTS (swept over every phase × shock × level) =================

const PHASES: CivPhase[] = ["golden", "ascendant", "declining", "dark"];
const SHOCKS: SocShock[] = [null, "BOOM", "FAMINE", "PLAGERA", "GREAT_HUDDLE", "DYNASTIC"];

test("every emitted intensity is bounded by the master ceiling, for every climate", () => {
  for (const phase of PHASES) {
    for (const shock of SHOCKS) {
      for (let level = 0; level <= 100; level += 5) {
        for (const cap of [0.25, 0.5, 1]) {
          const events = socialStimuli(civ(phase, level, shock), { maxIntensity: cap });
          for (const e of events) {
            assert.ok(e.intensity >= 0 && e.intensity <= cap + 1e-12,
              `${phase}/${level}/${shock} cap=${cap}: ${e.type}=${e.intensity} out of [0,${cap}]`);
          }
        }
      }
    }
  }
});

test("light and dark are NEVER both emitted (one net brightness axis)", () => {
  for (const phase of PHASES) {
    for (const shock of SHOCKS) {
      for (let level = 0; level <= 100; level += 1) {
        const events = socialStimuli(civ(phase, level, shock), CAP);
        const hasLight = !!pick(events, "light");
        const hasDark = !!pick(events, "dark");
        assert.ok(!(hasLight && hasDark), `${phase}/${level}/${shock} emitted both light and dark`);
      }
    }
  }
});

test("at most three events, in a stable order (brightness, threat, food), no duplicate channels", () => {
  for (const phase of PHASES) {
    for (const shock of SHOCKS) {
      for (let level = 0; level <= 100; level += 7) {
        const events = socialStimuli(civ(phase, level, shock), CAP);
        assert.ok(events.length <= 3, `${phase}/${level}/${shock} emitted ${events.length} events`);
        const types = events.map((e) => e.type);
        assert.equal(new Set(types).size, types.length, `duplicate channel in ${types.join(",")}`);
        // order: whichever of light/dark comes first, then threat, then food
        const order = types.map((t) => (t === "light" || t === "dark" ? 0 : t === "threat" ? 1 : 2));
        assert.deepEqual(order, [...order].sort((a, b) => a - b), `out of order: ${types.join(",")}`);
      }
    }
  }
});

test("only the four visitor channels are ever used (no new sensory channel ⇒ manifestHash safe)", () => {
  const allowed = new Set(["food", "threat", "light", "dark"]);
  for (const phase of PHASES) {
    for (const shock of SHOCKS) {
      for (const e of socialStimuli(civ(phase, 50, shock), CAP)) {
        assert.ok(allowed.has(e.type), `unexpected channel ${e.type}`);
      }
    }
  }
});

// ================= MAPPING CORRECTNESS =================

test("a golden age at its peak is a bright, plentiful world (light + food, no threat)", () => {
  const events = socialStimuli(civ("golden", 100, null), CAP);
  const light = pick(events, "light");
  const food = pick(events, "food");
  assert.ok(light && !pick(events, "dark"), "golden ⇒ light, never dark");
  assert.ok(!pick(events, "threat"), "a golden age is not threatening");
  closeTo(light!.intensity, 1.0 * 0.5, "peak fortune ⇒ full-scale light");
  closeTo(food!.intensity, 0.2 * 0.5, "a golden age tastes of plenty");
});

test("a dark age at its nadir is a dim world (dark, no light, no food)", () => {
  const events = socialStimuli(civ("dark", 0, null), CAP);
  const dark = pick(events, "dark");
  assert.ok(dark && !pick(events, "light"), "dark ⇒ dark channel only");
  assert.ok(!pick(events, "food"), "a dark age has no prosperity appetitive");
  closeTo(dark!.intensity, 1.0 * 0.5, "deepest misfortune ⇒ full-scale dark");
});

test("brightness is monotonic within a phase (a higher fortune is a brighter age)", () => {
  const lo = pick(socialStimuli(civ("golden", 76, null), CAP), "light")!.intensity;
  const hi = pick(socialStimuli(civ("golden", 100, null), CAP), "light")!.intensity;
  assert.ok(hi > lo, `golden 100 (${hi}) should outshine golden 76 (${lo})`);
  const dHi = pick(socialStimuli(civ("dark", 24, null), CAP), "dark")!.intensity;
  const dLo = pick(socialStimuli(civ("dark", 0, null), CAP), "dark")!.intensity;
  assert.ok(dLo > dHi, `dark 0 (${dLo}) should be darker than dark 24 (${dHi})`);
});

test("BOOM (the Gilding) brightens the age and adds a strong appetitive", () => {
  const plain = socialStimuli(civ("golden", 90, null), CAP);
  const boom = socialStimuli(civ("golden", 90, "BOOM"), CAP);
  assert.ok(pick(boom, "food")!.intensity > pick(plain, "food")!.intensity, "a boom is more appetitive");
  closeTo(pick(boom, "food")!.intensity, (0.2 + 0.55) * 0.5, "golden standing plenty + boom");
  assert.ok(!pick(boom, "threat"), "a boom is not threatening");
});

test("PLAGERA (the Rot) is the strongest aversive and darkens the world", () => {
  const events = socialStimuli(civ("dark", 10, "PLAGERA"), CAP);
  const threat = pick(events, "threat");
  assert.ok(threat && pick(events, "dark"), "a plague-dark age is darkened and stressful");
  closeTo(threat!.intensity, 0.7 * 0.5, "plague is the peak threat");
  // plague must out-threaten famine and oligarchy
  const fam = pick(socialStimuli(civ("declining", 30, "FAMINE"), CAP), "threat")!.intensity;
  const dyn = pick(socialStimuli(civ("golden", 80, "DYNASTIC"), CAP), "threat")!.intensity;
  assert.ok(threat!.intensity > fam && fam > dyn, `plague ${threat!.intensity} > famine ${fam} > yoke ${dyn}`);
});

test("FAMINE (the Famine) is a hunger stress that dims the world", () => {
  const events = socialStimuli(civ("declining", 25, "FAMINE"), CAP);
  assert.ok(pick(events, "threat"), "famine is threatening");
  assert.ok(pick(events, "dark") && !pick(events, "light"), "a famine dims an already-declining age");
  assert.ok(!pick(events, "food"), "a famine is the ABSENCE of plenty — never a food channel");
});

test("GREAT_HUDDLE (the Long Cold) pushes the brightness axis down", () => {
  // an ascendant age is mildly lit; the freeze drags the net brightness toward dark
  const plain = socialStimuli(civ("declining", 40, null), CAP);
  const cold = socialStimuli(civ("declining", 40, "GREAT_HUDDLE"), CAP);
  const plainDark = pick(plain, "dark")!.intensity;
  const coldDark = pick(cold, "dark")!.intensity;
  assert.ok(coldDark > plainDark, `the Long Cold deepens the dark (${coldDark} > ${plainDark})`);
  assert.ok(pick(cold, "threat"), "a freeze carries a mild cold stress");
});

test("DYNASTIC (the Yoke of Houses) adds oppression stress even inside a golden age", () => {
  const events = socialStimuli(civ("golden", 80, "DYNASTIC"), CAP);
  assert.ok(pick(events, "light"), "the age is still golden ⇒ still lit");
  assert.ok(pick(events, "threat"), "…but an oligarchy is felt as a stress");
  assert.ok(pick(events, "food"), "…and still prosperous");
});

test("a calm ascendant age is a faint light and nothing else", () => {
  const events = socialStimuli(civ("ascendant", 60, null), CAP);
  assert.equal(events.length, 1, "no shock, no golden prosperity ⇒ a single faint light");
  assert.equal(events[0].type, "light");
  assert.ok(events[0].intensity < 0.6 * 0.5 + 1e-9 && events[0].intensity > 0, "a mild, bounded light");
});

// ================= MASTER SCALE =================

test("the master ceiling scales the whole climate proportionally", () => {
  const c = civ("golden", 100, "BOOM");
  const half = socialStimuli(c, { maxIntensity: 0.5 });
  const full = socialStimuli(c, { maxIntensity: 1 });
  for (const ch of ["light", "food"]) {
    closeTo(pick(full, ch)!.intensity, 2 * pick(half, ch)!.intensity, `${ch} doubles with the ceiling`);
  }
});
