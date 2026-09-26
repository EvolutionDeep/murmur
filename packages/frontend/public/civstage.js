// civstage.js — 任务32「文明演化系统一期」：civStage 选择器（纯读出膜层）
// 由 app.js 单体拆分后的 ESM 树新增模块。事件驱动、零每帧成本：仅在数据到达
// （polling.js 的 poll / pollChron）时评估一次，签名去重后一次性写 body dataset
// 并通知 3D 场景做 ≤2s 过渡。绝不触碰经济 / 模拟 / 基因组，纯读出。
//
// 数据源（均已在仓库核实，见任务报告）：
//   state.chronMeta.civLevel    0..100 史官对蜂群"运势"的有界 reckoning（chronicler.ts eraInfo）
//   state.chronMeta.civPhase    golden|dark|ascendant|declining（一期不参与选档，二/三期接口预留）
//   state.chronMeta.era         慢速纪元序号（regime 驱动，1 起）
//   state.chronMeta.eraRegime   HOT|CALM|COLD（纪元 held 的市场温度政体）
//   state.chronMeta.generation  史官独立世代钟（快速、单调递增）
//   sim.size                    活体种群数（前端物理本地积分，/population 不含 x/y）
//   state.econXxx               已到达前端的膜层载荷（"已解锁膜层数"的确定性代理）
import { state, sim, clamp } from './shared.js';

// 膜层载荷键：任一非 null 即视为该膜层已在前端解锁（纯读出，与 worker 开关一致）
const MEMBRANE_KEYS = [
  'econMarket', 'econCulture', 'econReligion', 'econCommons', 'econWar', 'econTech',
  'econCities', 'econApprentice', 'econArchive', 'econWorkshop', 'econBourse',
  'econCourt', 'econGames', 'econGuilds', 'econLexicon', 'econRumor', 'econTreaty',
  'econWorks', 'econGuardians',
];

// ---- stage 阈值表（确定性纯函数）----------------------------------------------------
// 文明指数 index = 0.35·civLevel + 0.20·era + 0.15·generation + 0.15·种群 + 0.15·膜层数
// （各子分先归一到 0..1）。index 落在哪个带 ⇒ 对应 0..5 档：
//   index < 0.18 ⇒ 0 部落晨雾   < 0.34 ⇒ 1 城邦青铜   < 0.50 ⇒ 2 王国黄金
//   < 0.66 ⇒ 3 帝国紫           < 0.82 ⇒ 4 启蒙白     ≥ 0.82 ⇒ 5 transcend 辉光
const STAGE_BANDS = [0.18, 0.34, 0.50, 0.66, 0.82];
export const CIV_STAGE_MAX = 5;

function membraneCount() {
  let n = 0;
  for (let i = 0; i < MEMBRANE_KEYS.length; i++) if (state[MEMBRANE_KEYS[i]]) n++;
  return n;
}

/** 纯函数：由 civLevel/era/generation/种群/膜层数算出 0..5 档（无副作用，可单测）。
 *  civLevel 不可达（旧 worker 返回 null）时按任务书降级：以 era 序号作 fortune 代理。 */
export function computeCivStage(civLevel, era, generation, pop, membranes) {
  const eraN = clamp(((Number.isFinite(era) ? era : 1) - 1) / 8);
  const civN = Number.isFinite(civLevel) ? clamp(civLevel / 100) : eraN;   // 降级路径
  const genN = clamp((Number.isFinite(generation) ? generation : 0) / 24);
  const popN = clamp((Number.isFinite(pop) ? pop : 0) / 60);
  const memN = clamp((Number.isFinite(membranes) ? membranes : 0) / 12);
  const index = 0.35 * civN + 0.20 * eraN + 0.15 * genN + 0.15 * popN + 0.15 * memN;
  let stage = 0;
  while (stage < STAGE_BANDS.length && index >= STAGE_BANDS[stage]) stage++;
  return stage;   // 0..5
}

let _stage = 0;
let _regime = 'calm';
let _appliedSig = '';       // 签名去重：stage|regime 变化才触发一次性应用
let _override = null;       // 调试覆盖（window.__murmurCivStage.set），null ⇒ 自动

function applyStage(stage, regime, sig) {
  _appliedSig = sig;
  _stage = stage; _regime = regime;
  const b = (typeof document !== 'undefined') ? document.body : null;
  if (b) { b.dataset.civStage = String(stage); b.dataset.regime = regime; }
  // 2D fallback / 未初始化守卫：threeScene 可能为 null（WebGL 失败）或尚无 setCivStage
  const ts = state.threeScene;
  if (ts && typeof ts.setCivStage === 'function') {
    try { ts.setCivStage(stage); } catch (_) { /* 守卫吞掉：氛围层绝不阻断场景 */ }
  }
}

/** 评估并（仅在签名变化时）应用。由 polling.js 在数据到达后调用；零每帧成本。 */
export function evaluateCivStage() {
  const m = state.chronMeta;
  const stage = (_override != null)
    ? _override
    : computeCivStage(m ? m.civLevel : null, m ? m.era : null, m ? m.generation : null, sim.size, membraneCount());
  const rawRegime = (m && m.eraRegime) ? String(m.eraRegime).toLowerCase() : 'calm';
  const regime = (rawRegime === 'hot' || rawRegime === 'cold') ? rawRegime : 'calm';
  const sig = stage + '|' + regime;
  if (sig === _appliedSig) return;   // 去重：无变化不应用（不写 DOM、不惊动 3D）
  applyStage(stage, regime, sig);
}

// ---- 调试 / 验证钩子（任务书要求）----
export function getCivStage() { return _stage; }
export function getCivRegime() { return _regime; }
/** set(n)：强制覆盖到 n 档并立即应用；set(null) 恢复自动评估。供 headless 验证与日后排查。 */
export function setCivStageDebug(n) {
  _override = (n == null) ? null : Math.max(0, Math.min(CIV_STAGE_MAX, n | 0));
  _appliedSig = '';                  // 强制下一次 evaluate 必应用（即使档位巧合相同也重刷）
  evaluateCivStage();
  return _stage;
}

if (typeof window !== 'undefined') {
  window.__murmurCivStage = { get: getCivStage, set: setCivStageDebug, regime: getCivRegime };
}
