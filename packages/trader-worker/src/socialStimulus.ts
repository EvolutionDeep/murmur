// ① THE NEURAL FEEDBACK BUS — let the swarm FEEL the age it lives in.
//
// Until now the civilizational read-out membranes (culture ⑤ / epochs ⑦ / war ⑨ / territory ⑩ / tech ⑬ /
// cities ⑭) only ever NARRATED the society into the chronicle: the historian reckons a bounded fortune
// (`civLevel` 0..100) and names its ages (golden / dark / ascendant / declining, plus the shock era that
// forced the current age), but NOTHING folded that reckoning back into the connectome. The flies were told
// about their civilisation; they never felt it. This module closes that loop the SAFE way.
//
// WHAT IT DOES. It turns the historian's OWN `eraInfo()` — a pure, persisted, single-sourced distillation of
// the whole society (its civLevel step already folds in the real volume trend, equity, feuds, credit runs and
// burial waves; its eraShock already names famine / plague / boom / freeze / oligarchy) — into a BOUNDED set
// of the FOUR visitor stimulus channels the connectome can ALREADY feel (food / threat / light / dark), exactly
// like a visitor's "poke the swarm". A golden age brightens the visual field and tastes of plenty; a dark age
// dims it; a plague or a famine is a sustained aversive stress; a boom is appetitive.
//
// WHAT IT DELIBERATELY DOES NOT DO (the production red lines):
//   • It adds NO sensory channel. It reuses the four existing stimulus_* channels, so the connectome's
//     structural spec — and therefore manifestHash — NEVER rotates. (A new channel would be a nuclear event:
//     it would change every committed brain identity and force a same-batch two-sided deploy.)
//   • It touches NO genome, NO connectome wiring, NO ledger, NO settlement. It only appends bounded
//     StimulusEvents to the array the cron already injects, so it rides the EXACT visitor-stimulus path
//     (advanceFlies → encodeStimulus → injectCurrent) with zero change to fly-brain / population / swarm.
//   • It is PURE and DETERMINISTIC: an integer civLevel + two enums in ⇒ bounded floats out. No RNG, no
//     clock, no LLM, no I/O — so it is unit-testable in isolation and byte-identical on every JS engine,
//     exactly like war.ts / invention.ts / cities.ts.
//   • It is GATED by SOCIAL_STIMULUS_ENABLED (default OFF, dark-deploy). An OFF cron appends NOTHING, so the
//     injected stimulus array is byte-for-byte today's pendingStimuli.
//
// WHY eraInfo() IS THE RIGHT (AND ONLY) INPUT. The market pulse already carries the FAST thermal signal
// (temperature → thermosensation, momentum → optic flow, …). The civilizational climate is the SLOW signal —
// the age the swarm lives in, which turns over generations, not ticks. eraInfo() is precisely that slow
// reckoning, and because the historian already distils every acute social signal INTO civLevel/eraShock, the
// bus needs a single input and never duplicates (or contradicts) the chronicle. One source, one truth.

import type { StimulusEvent } from "@fly/fly-brain";
// TYPE-ONLY import (fully erased at runtime, so this module keeps ZERO runtime dependency on the chronicler
// and stays a pure, isolated unit). Binding SocShock to the historian's own ShockKind means the two unions can
// never silently diverge: if a new shock age is ever added, this module fails to compile until its felt
// mapping is decided — a deliberate guard, not an accident.
import type { ShockKind } from "./chronicler.js";

/** The historian's civilizational phase (eraInfo().civPhase). */
export type CivPhase = "golden" | "dark" | "ascendant" | "declining";

/** The shock that forced the current era (eraInfo().eraShock); null ⇒ a calm, regime-driven age. */
export type SocShock = ShockKind | null;

/**
 * The civilizational state the bus reads — a narrow SUBSET of chronicler.eraInfo(), limited to the three
 * fields that define the swarm's felt climate. Deliberately structural rather than the whole eraInfo object so
 * the mapping is unit-testable without a Chronicler and can never accidentally depend on a volatile field
 * (headHash / seq / eraName / generation).
 */
export interface CivilizationState {
  civPhase: CivPhase;
  /** The historian's bounded fortune reckoning, 0..100 (already an integer out of eraInfo()). */
  civLevel: number;
  eraShock: SocShock;
}

export interface SocialStimulusConfig {
  /**
   * Hard ceiling on ANY one emitted channel's intensity, 0..1. It is a MASTER SCALE: every channel below is
   * computed in 0..1 "climate units" then multiplied by this, so one operator knob dials the whole felt
   * climate and it can never overwhelm the market pulse. 0 ⇒ the bus emits nothing (a second, finer kill).
   */
  maxIntensity: number;
}

// --- THE MAPPING'S FIXED SHAPE (NOT env-tunable) ---
// These constants are the calibration, frozen in code so a felt climate never depends on when it is read (the
// same discipline as war.ts's housePower weighting). Brightness is a single NET axis in −1..+1: the phase sets
// the sign and the level within the phase interpolates its depth; the shock then nudges it. Only the DOMINANT
// side is emitted, so the swarm is never simultaneously lit and darkened. Threat is the MAX of the shock-derived
// stresses (never a sum ⇒ bounded); food is the prosperity appetitive. Epsilon gates a float that is really zero.

const EPS = 1e-9;

/** clamp01 without importing it — keeps this module dependency-free at runtime. */
function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

/** Normalised position of `level` within [lo,hi], clamped to 0..1 (lo==hi ⇒ 0). */
function band(level: number, lo: number, hi: number): number {
  if (hi <= lo) return 0;
  return clamp01((level - lo) / (hi - lo));
}

/**
 * The phase's base brightness in −1..+1, interpolated by how deep the civLevel sits inside that phase's band.
 *   golden    (75..100) → +0.6 .. +1.0   (a brilliant age, brighter the higher the fortune)
 *   ascendant (50..75)  → +0.25 .. +0.6  (a climbing age, mildly lit)
 *   declining (25..50)  → −0.25 .. −0.6  (a slipping age, mildly dimmed)
 *   dark      (0..25)   → −0.6 .. −1.0   (a sunken age, darker the lower the fortune)
 * The phase (not the raw level) picks the sign/range, so a civLevel that has drifted past a band edge while the
 * historian's phase flag lags (e.g. a renaissance pending) still reads coherently — band() clamps it.
 */
function phaseBrightness(phase: CivPhase, level: number): number {
  if (!Number.isFinite(level)) return 0; // a stray non-finite fortune is felt as nothing, never NaN
  const lv = clamp01(level / 100) * 100; // defend a stray out-of-range level
  switch (phase) {
    case "golden":
      return 0.6 + 0.4 * band(lv, 75, 100);
    case "ascendant":
      return 0.25 + 0.35 * band(lv, 50, 75);
    case "declining":
      return -(0.25 + 0.35 * (1 - band(lv, 25, 50)));
    case "dark":
      return -(0.6 + 0.4 * (1 - band(lv, 0, 25)));
    default:
      return 0; // an unknown phase is felt as nothing rather than guessed
  }
}

/**
 * Turn the civilizational climate into the bounded visitor-channel stimuli the swarm feels this cron. PURE +
 * DETERMINISTIC: the same (civPhase, civLevel, eraShock, maxIntensity) always yields the same events, in a
 * stable order (light/dark, then threat, then food). `civ` null (a cold cron before the historian is loaded,
 * or the bus reading nothing yet) ⇒ an empty array ⇒ the cron's stimulus array is untouched.
 *
 * Emitted intensities are each in [0, maxIntensity]; at most THREE events are produced (one of light/dark, plus
 * threat, plus food), and any channel whose climate unit rounds to ~zero is omitted, so a calm ascendant age
 * may emit only a faint light while a plague-dark age emits dark + threat.
 */
export function socialStimuli(
  civ: CivilizationState | null,
  cfg: SocialStimulusConfig,
): StimulusEvent[] {
  if (!civ) return [];
  const cap = clamp01(cfg.maxIntensity);
  // NaN-safe gate: `!(cap > 0)` is true for both 0 and NaN, so a malformed ceiling can NEVER leak a NaN
  // intensity into injectCurrent (which would poison the connectome irreversibly). Defence-in-depth behind
  // config.ts's own finite check.
  if (!(cap > 0)) return [];

  // 1) The slow ambient: the age's brightness, and a golden age's standing prosperity.
  let bright = phaseBrightness(civ.civPhase, civ.civLevel);
  let threat = 0;
  let food = civ.civPhase === "golden" ? 0.2 : 0; // a golden age tastes of plenty even without a boom shock

  // 2) The shock overlay: the age's defining event, sustained while the era holds.
  switch (civ.eraShock) {
    case "BOOM": // "the Gilding" — a volume record while wealth concentrates: bright + appetitive
      bright += 0.25;
      food += 0.55;
      break;
    case "FAMINE": // "the Famine" — a signal-food drought: hunger stress, a dimmed world
      bright -= 0.15;
      threat = Math.max(threat, 0.6);
      break;
    case "PLAGERA": // "the Rot" — burials in waves: the strongest aversive, a darkened world
      bright -= 0.2;
      threat = Math.max(threat, 0.7);
      break;
    case "GREAT_HUDDLE": // "the Long Cold" — the freeze will not lift: withdrawn, dark, mild cold stress
      bright -= 0.35;
      threat = Math.max(threat, 0.2);
      break;
    case "DYNASTIC": // "the Yoke of Houses" — one house grips the capital: oppression, slightly dimmed
      bright -= 0.1;
      threat = Math.max(threat, 0.3);
      break;
    default: // null (a calm regime age) or a future shock: no overlay
      break;
  }

  // 3) Emit the dominant brightness (never both light and dark), then threat, then food — each scaled by the
  //    master ceiling and clamped to it. `from` tags the source for audit; encodeStimulus ignores it, and this
  //    array is NOT the visitor log, so the poke feed is never polluted by the bus.
  const out: StimulusEvent[] = [];
  if (bright > EPS) out.push({ type: "light", intensity: clamp01(bright) * cap, from: "civic-climate" });
  else if (bright < -EPS) out.push({ type: "dark", intensity: clamp01(-bright) * cap, from: "civic-climate" });
  if (threat > EPS) out.push({ type: "threat", intensity: clamp01(threat) * cap, from: "civic-climate" });
  if (food > EPS) out.push({ type: "food", intensity: clamp01(food) * cap, from: "civic-climate" });
  return out;
}
