# HANDOVER — murmur 项目会话交接文档（滚动更新）

> **最后更新**：2026-09-30T10:36Z（任务 #141，docs-only 交接轮次）
> **本文档是下一会话的权威入口。** 所有数字均在上述时刻**只读实测**（git / 仓库文件 / `api.muros.live` / Arc mainnet RPC / `wrangler deployments list`），出处标注在各节。凡与任何旧交接文档、旧记忆、旧聊天口径冲突，**以本文档为准**；凡本文档标注"会话口径·未实测"的，下一会话须自行复核。

### 权威锚点速查（照抄这一屏就能对齐状态）

| 锚点 | 实测值 | 出处 |
|------|--------|------|
| 仓库 HEAD | `71e2aa00de2fc76dc1c2643ebe7f090853a5a774`（`71e2aa0`） | `git rev-parse HEAD` |
| ↳ 本文档自身 | 以 `docs: rolling session handover #141 …` 提交（仅改 `HANDOVER.md`）。**你看到 HEAD 比 `71e2aa0` 多一个 docs commit 属正常**，上表锚点是本文成文时的代码/生产状态 | 本行 |
| 工作分支 | `fresh`（工作树**干净**，无未提交改动） | `git status --short` |
| 分支对齐 | `fresh` == `main` == `new-origin/main` == `new-origin/fresh` 全在 `71e2aa0` | `git log --oneline -15` |
| 远端 | 仅 `new-origin` → `https://github.com/EvolutionDeep/murmur.git` | `git remote -v` |
| Worker Version | `9c5af85c-3466-4196-9568-33fecee1ede5`（100%，2026-09-30T07:59:10Z，`triggered_by=deployment`） | `wrangler deployments list --json` |
| CODE_COMMITMENT | `066121bc5bf09f123af45e9556aa07048afa32f6dd4c1cffda7f09dc22233f92` | `src/codeCommitment.ts` + 线上 `/poca` **双端一致** |
| ↳ inputs | treeHash `e8a1e0ec…6370`、artifactHash `dc84edfc…7544`、fileCount **144**、knobCount **29** | 同上 |
| ↳ GIT_COMMIT | `cc3e8d6`（**信息字段，不参与哈希**，比实际构建落后一个 commit，见 §3.1 陷阱） | `src/codeCommitment.ts:12` |
| PoCA | epochCount **10** / currentEpoch **9** / continuity **unbroken** / mirror.aligned **true** / mirror.failures **4** / digestCount 128 | 线上 `/poca` |
| 纪元 | era **143** "the Yoke of Houses"（regime CALM）、generation **583**、civLevel **42**（declining） | 线上 `/annals` |
| tickIndex | **68,062**（10:36Z 样本；10:31Z 为 67,995） | 线上 `/economy` |
| 编年史 seq | **15,888**（headHash `3e21d3b1…`；~70s 前为 15,872 / `78c8189a…`） | 线上 `/annals` |
| 前端入口 | `main.js?v=162`、`styles.css?v=163` | `index.html:922` / `:11` |
| 前端字典 | `i18n.js?v=114`（18 个引用点）、`i18n-ui.js?v=107`、`i18n-chron.js?v=75` | grep `public/*.js` |
| 线上前端字节 | index.html **84,548 B**、styles.css **359,187 B** — 与本地**逐字节等长**，部署已生效 | `curl.exe -L www.muros.live` |
| netFlushTicks | wrangler.toml `"1440"`（L136） / config.ts `?? "1440"`（L1102） — **两端已同步** | 两文件实测 |
| facilitator 余额 | **132.470701 USDC**（native 132.470702，block 23,525,533，nonce **301,439**） | Arc RPC 只读 |
| 🔴 GAS 燃烧 | **24.81 USDC/天**、**11,417 tx/天**、0.002173 USDC/tx ⇒ 续航 **≈5.3 天**（约 2026-10-05 傍晚 UTC） | 4.007h 窗口实测，见 §3.5 |
| 真钱零和 | Σ 100 个 agent mirror = **143,544,000 atomic = 143.544 USDC**（两样本 276s 间隔**完全不变**） | 线上 `/economy` |
| Gini | **0.6696 → 0.6695**（真实链上口径） | 线上 `/economy` |
| caps | treasuryOutAtomic **0**、commonsPoolAtomic **0**（未触顶） | 线上 `/economy` |
| 测试基线 | 1186/1186、tsc×3 全绿、`check:knobs` 29/29、manifestHash `c0288c45…` 双跑逐位一致 | commit `7464b52` 门禁记录（本会话未重跑，docs-only） |

---

## 0. 如何使用本文档

1. **先读 §2 止血操作**——这是承载真钱的生产系统，任何异常第一步是止血，不是排查。
2. **再读 §3.5 GAS 续航**——这是当前唯一的"倒计时"风险。
3. 开工前用 §8 的只读探针重新采一次样，把本文档的锚点表刷成你的时刻的值（本文档是滚动文档，不是纪念碑）。
4. **硬条款**：`计划获批 ≠ 部署获批`。任何触碰真钱路径 / worker / 链上 / 经济配置的改动，即使用户批准了方案，也必须再取得一次明确的部署批准。

---

## 1. 项目概览

**murmur**（原 Immortal Fruit Flies）是一个**零 LLM** 的自主果蝇文明模拟：每只果蝇由真实果蝇连接组（FlyWire FAFB_783 子图）驱动神经网络，拥有基因组、生命周期、社会关系与经济行为。文明的所有"心智"都来自神经模拟 + 演化，**没有任何大模型调用**。

它同时是一个**承载真实资金的生产系统**：

- 链：**Arc mainnet，chainId 5042**（实测 `eth_chainId = 0x13b2`）。
- 结算：x402 微支付协议 + EIP-3009 `transferWithAuthorization` 真实 USDC 转移（USDC precompile `0x3600000000000000000000000000000000000000`，6 位小数）。
- 背后有**高市值代币 MURMUR**（ERC-20，18 位小数，`0x8faae5592b9acc27a79fca745c6b872adf514a5d`）。
- 站点：前端 **https://www.muros.live**（Cloudflare Pages），API **https://api.muros.live**（Cloudflare Worker，OpenAPI 3.1 契约见 `/openapi.json`，人类文档 `/developers`）。

**因此：任何"看起来无害"的改动都可能动到真钱。生产高价值，逐项核实是纪律而非选项。**

### 核心架构

| 层级 | 职责 |
|------|------|
| Cloudflare Worker（`packages/trader-worker`） | 主运行时；cron `* * * * *` 驱动 tick；x402 结算；22 个膜层的纯读出/因果逻辑 |
| Durable Objects | `FLY_STATE`（FlyStateDO）+ `FLY_SHARD`（FlyShardDO）分片状态存储；**单线程输入队列**（见 §4.4 事故根因） |
| D1 | 历史归档（`/history`、`/shadow`、`/replay/economy` 等 worker-served 路由） |
| KV | `FLYWIRE_ARTIFACT`（连接组子图 artifact 缓存，id `fc21e2dae15b45d09f786bb50250c5c3`） |
| Arc mainnet 合约 | ContinuityRegistry（PoCA 纪元锚）、NeuralReceiptRegistry（收据哈希链）、NeuralManifestRegistry、ConnectomeLineage、PredictionArena、WarCoffer |
| 前端（`packages/frontend`，裸 ESM + Three.js + Canvas 2D） | 3D/2D 主画布、抽屉式 UI、7 语 i18n（含 RTL）、羊皮纸世界地图册 |
| `packages/fly-brain` | 果蝇神经模拟器（基因组 → 连接组 → 神经活动 → manifestHash） |
| `packages/arc-circle-x402` | Circle x402 Facilitator 通用客户端（开源包） |
| PoCA（Proof of Continuous Agency） | 把"代码身份 + 运行时旋钮 + 纪元链"锚上链，使静默换码成为链上可见的断裂 |

### 技术栈

- **Runtime**：Cloudflare Workers (ESM)、Durable Objects、KV、D1
- **Frontend**：Vanilla JS 裸 ESM（无打包器）+ Three.js + Canvas 2D，Cloudflare Pages
- **Neural sim**：TypeScript，FlyWire FAFB_783 连接组数据（CC-BY 4.0，Eckstein et al. 2024 递质符号化）
- **Blockchain**：Arc mainnet 5042、x402 (Circle)、viem、EIP-3009、EIP-712
- **Contracts**：Solidity + Foundry（`.foundry-bin/`，anvil/cast/forge）
- **CI**：GitHub Actions — verify（node 四门）+ contracts（forge）

---

## 2. 🚨 止血操作（最高优先级 · 出现任何意外先看这节）

### 2.1 一键止血

**任何涉及真钱的意外（异常转账、余额异常蒸发、settle 失控、gas 异常抬升、疑似被 wedge 的收据链），第一步不是排查，是止血：**

> 在 **Cloudflare Dashboard → Workers & Pages → `murmur` → Settings → Variables and Secrets**，把
> **`ECONOMY_REAL_SPEND` 设为 `false`**，保存。秒级生效，立即停止**所有**真实结算。

实测事实（务必知道，否则会找错地方）：

- `ECONOMY_REAL_SPEND` **当前不在 `wrangler.toml [vars]` 里**（该文件 L120 是**被注释掉**的示例行 `# ECONOMY_REAL_SPEND = "true"`）。
- 生效值来自代码兜底：`config.ts:1087` → `realSpendEnabled: (env.ECONOMY_REAL_SPEND ?? "true").toLowerCase() !== "false"`，即**默认开着真钱**。
- 所以在 Dashboard 里**新增/覆盖**这个 var（或 secret）为 `"false"` 就能止血；**不需要改代码、不需要重新部署 artifact**。
- 恢复：把它删掉（回落到代码默认 `"true"`）或设回 `"true"`。
- 语义边界：`ECONOMY_REAL_SPEND=false` 同时掐掉 arena / war / evolution / prediction 等所有真实资金车道（它们都以"master rails"为前置）；**只读膜层、编年史、神经模拟、PoCA 离链纪元链不受影响**，文明心跳继续。
- 另一个更窄的开关：`ECONOMY_SHADOW="true"`（当前 `"false"`，在 `[vars]` L121）= 签名 + `eth_call` 模拟但**不广播**。用于"想保留全流程但不花钱"的排障。

### 2.2 密钥纪律（无例外）

- **`ECONOMY_MNEMONIC`**：单一 BIP-39 种子，HD 派生**全部** agent 钱包（`m/44'/60'/0'/0/{id}`）**与 gas 钱包**。它等于系统里每一分钱。
  - **绝不**出现在聊天、日志、commit、issue、截图、临时文件里。
  - 只通过安全渠道（1Password / 线下）移交；本仓库内**没有**它的明文（`.env.local` 有一份本地副本，属未跟踪文件，**永不提交**）。
  - 派生范围必须覆盖 `maxLivePopulation`——历史上"新孵化果蝇 no signer for payer"就是派生上界不够导致的。
- 其余 secrets（共 **6** 个）：`ECONOMY_MNEMONIC`、`ECONOMY_FACILITATOR_PK`（可选专用 gas key）、`ALCHEMY_ARC_RPC_URL`（付费私有 RPC）、`ADMIN_TOKEN`（锁 `POST /tick`、`/reset`）、`ECONOMY_ONCHAIN_BALANCE_GATE`（R5 Fix A）、`ECONOMY_MIRROR_RESYNC_EVERY_N_CRON`（R5 Fix B）。
  - 后两个**故意不做成 `[vars]`**：128 文本绑定墙已满，放 secret 才能**秒级回滚**（`wrangler secret put` 单独重滚版本，不改代码、不重部署 artifact）。
  - 当前武装值：`ECONOMY_ONCHAIN_BALANCE_GATE="true"`、`ECONOMY_MIRROR_RESYNC_EVERY_N_CRON="3"`（2026-09-30 武装；链上部署时间线可见 05:49:14Z + 05:49:42Z 两个 `triggered_by=secret` 版本）。
  - 回滚：分别 put `"false"` / `"0"`。两者**可独立回滚**；缺失 ⇒ 代码默认 OFF ⇒ 与 R5 之前逐字节等价。
  - PoCA 语义（已实测订正过一次错误说法）：对这两个 secret 做 put **不产生任何 PoCA admin 事件**（既非 kind-3 也非 kind-7）——`pocaKnobsHash()` 只哈希 22 个**非 secret** 层级开关，两者都不在其中（设计如此）。secret put 只滚一个 `Source: "Secret Change"` 的新版本，CODE_COMMITMENT 与纪元不受影响。

### 2.3 硬条款

1. **计划获批 ≠ 部署获批。** 涉真钱路径 / worker / 链上 / 经济配置的改动，方案通过后仍须用户**单独明确批准**才能部署。
2. **纯 UI 改动**可走"免确认三连"（改 → bump → 部署），但**免测试不免复验**：部署后必须做线上字节复验（§7.4）。
3. **只读诊断不擅动生产。** 排查阶段只用 GET 探针与 RPC 只读调用；不 reset、不 `POST /tick`、不改 var/secret。
4. **暗部署优先。** 新资金动作 / 计费语义变更一律"代码上线但开关 OFF"，验证字节等价后再分级翻开。
5. **不删文件除非被明确要求。** 工作区大量 `_t*` 临时文件是历史证据，删除有风险（见 §11）。

---

## 3. 当前生产状态（2026-09-30T10:36Z 实测）

### 3.1 Worker / PoCA

| 项 | 值 |
|----|-----|
| Worker 名 | `murmur`（`wrangler.toml:1`，`main = "src/index.ts"`，`compatibility_date = "2026-01-01"`，`nodejs_compat`） |
| cron | `* * * * *`（每分钟触发；`cronRunning` 守卫会静默 SKIP 重叠触发） |
| 生效 Version | `9c5af85c-3466-4196-9568-33fecee1ede5`，deployment id `bbba3c91…`，2026-09-30T07:59:10.390815Z，100%，`triggered_by=deployment` |
| CODE_COMMITMENT | `066121bc5bf09f123af45e9556aa07048afa32f6dd4c1cffda7f09dc22233f92` |
| ↳ 构成 | treeHash `e8a1e0ec7d50829aa9d8879c81aea36acf1c9f0c2e219fcf840e0f9d30da6370`、fileCount 144、knobCount 29、artifactHash `dc84edfc2cd6cc6a0fcba671e2bd265423cfd7905e5d0e19bd183925c4377544` |
| 上一个 CODE_COMMITMENT | `1616fe50…3a19`（treeHash `feb82071…`），由 `7464b52` 旋转 |
| PoCA 纪元 | epochCount **10**、currentEpoch **9**、continuity **unbroken** |
| ↳ 当前纪元 | openTs `1790755203391`、digestCount 128、head `e47f9f41171341e8d67f16efe98c9471b21482030b2a6779b9263778965c882b` |
| ↳ 链上镜像 | `aligned: true`、`failures: 4`、`paused: false`、lastMirrorTs `1790755229960` |
| PoCA registry | `0x3f67b38030f2d709bafd2f7a3ee2388c35195b33`（ContinuityRegistry） |
| 绑定清单 | **128/128 满**：126 个 `env.*` 文本绑定（**122** 个 `[vars]` + 4 个非文本：DO×2 / D1 / KV）+ **6** 个 secret |
| 运行时（本次 boot） | `breaker: closed`、breakerOpenings 0、relayOk 6 / relayFail 0、circleOk 0、gasWeiTotal `10998520214471140`、bootTs `1790763036969` |
| `/health` | `ok: true`、features **13**（基线 13，不可下降）、`version: "0.2.0"`、`chain: "arc"`、`apiVersion: "v1"` |

**⚠️ 陷阱（本会话实测确认，别被误导）**：`codeCommitment.ts` 的 `GIT_COMMIT` 字段**不是**构建代码的 commit。codegen 在 deploy 前跑，此时修复尚未 commit，所以它stamp 的是**当时的 HEAD**，比真正被哈希的代码落后一个 commit。当前 `GIT_COMMIT = cc3e8d6`，而被哈希的 src 实际是 `7464b52` 的内容（线上 `/poca` 也报 `cc3e8d6`，两端一致）。`GIT_COMMIT` 注释里写明"Informational only — NOT folded into CODE_COMMITMENT"。**判断"线上跑的是哪份代码"只认 CODE_COMMITMENT / treeHash，不认 GIT_COMMIT。**

**⚠️ 已知缺一个链上事件（非故障，勿误修）**：`/poca/admin` 最新一条 `kind=7 CODE_CHANGE`（ts `1790755203391`，正是 epoch 9 的 openTs）**没有 `txHash` 字段**，而它之前所有 kind=7 都有（如 `0x5d209ea8…`、`0xf48806dd…`）。即本纪元的 `adminAction(kind=7)` 链上公告**失败了 1 次**，按 `poca.ts` 设计**不重试**。影响：链上少一个 CODE_CHANGE 公告事件；**epoch 完整性、continuity=unbroken、承诺旋转、离链 digest 链全部不受影响**（`mirror.aligned=true`）。属概率性行为，**下次封印自愈**。`mirror.failures=4` 是跨纪元累计计数，不等于"本纪元失败 4 次"。

### 3.2 前端

| 项 | 值 |
|----|-----|
| 项目 | Cloudflare Pages，project `murmur`，branch `main` |
| 入口 | `packages/frontend/public/index.html`（84,548 B） |
| 缓存键 | `main.js?v=162`（L922）、`styles.css?v=163`（L11） |
| 字典模块 | `i18n.js?v=114`（被 18 个模块 bare-import）、`i18n-ui.js?v=107`、`i18n-chron.js?v=75` |
| 线上复验 | `www.muros.live/` 84,548 B、`styles.css?v=163` 359,187 B — **与本地逐字节等长**，最新前端已生效 |
| 最新前端 commit | `71e2aa0`（task 137/139：atlas 首页保持 `.panel-econ` / `.panel-pop` 可见，styles.css v162→163；改动仅 `index.html` +2/-1、`styles.css` +24/-1） |
| 部署预览 URL | `9a1a0e43.murmur-4sx.pages.dev`（**会话口径·本次未实测**，Pages deployment 列表未查） |

**⚠️ 版本号当前不同步（有意为之，但要知道）**：`main.js?v=162` 与 `styles.css?v=163` **不一致**。`scripts/bump-frontend-version.mjs` 的设计是把两者**锁步**为同一个 N（自动取 `index.html` 里 `main.js?v=` +1）。task 137/139 只手工 bump 了 `styles.css`，所以现在**直接跑 bump 脚本会得到 163/163**（把 main.js 抬到 163，styles.css 原地不动）。若下一次改动同时碰 js 和 css，跑脚本即可归位；若只想再抬 css，必须手工改或给脚本传显式版本号。

### 3.3 合约地址（Arc mainnet 5042；`contracts/*_ADDRESS.txt` 与 `wrangler.toml` 双源一致）

| 合约 | 地址 | 备注 |
|------|------|------|
| ContinuityRegistry（PoCA） | `0x3f67b38030f2d709bafd2f7a3ee2388c35195b33` | **代码内兜底**（`config.ts:1072`），不占 `[vars]` 位；设零地址可显式关闭链上镜像（离链纪元链始终运行） |
| NeuralReceiptRegistry | `0x94d0c38bcc9957eaf8f318e6bbc6557f8cc3c815` | `[vars]` `ECONOMY_REGISTRY_ADDRESS`；收据哈希链链头，committer = facilitator |
| NeuralManifestRegistry | `0x3412eb909252adb983aaf793f97a3754ca029a37` | `[vars]` `MANIFEST_REGISTRY_ADDRESS`；committer = deployer `0x307D…3a0d` |
| ConnectomeLineage | `0x482b7a3bbef796c9627d86d5a23c67728a78096f` | `[vars]` `LINEAGE_ADDRESS` |
| PredictionArena | `0xaf1ae61e12c101d179a2f65a5f2e02e690968525` | `[vars]` `ARENA_ADDRESS`；计价代币 `ARENA_TOKEN` = MURMUR `0x8faae5592b9acc27a79fca745c6b872adf514a5d` |
| WarCoffer | `0x3d900b8d1d48b46fc18a3f57dfd15a4a28bb454b` | `[vars]` `WAR_ADDRESS`；`WAR_MAX_ESCROW_USDC=50` 合约内 immutable 硬顶 |
| facilitator / committer / resolver | `0x2b9A3197ed35d56E2e1c2A01f4D649586821055c` | **同一个钱包**同时是 gas 付款方、收据链 committer、Arena/War 的 immutable resolver |
| USDC precompile | `0x3600000000000000000000000000000000000000` | 6 位小数；`/economy` 报 `asset` 即此地址 |

**关键不变量（实测复核通过）**：facilitator 的 **native 余额 == USDC precompile 的 ERC-20 余额 × 1e12**（native `132.470702` / precompile `132.470701`，一致到 12 位小数）。也就是说**它付 gas 用的就是它的运营 USDC**，没有独立 gas 储备——这就是 GAS 续航成为头号风险的结构性原因。

### 3.4 真钱与经济（两样本：10:31:27Z / 10:36:03Z）

| 指标 | 样本 1 | 样本 2 | 说明 |
|------|--------|--------|------|
| mode / network | `onchain` / `arc` | 同 | 真钱模式，非 shadow |
| tickIndex | 67,995 | 68,062 | 276s 内 +67 |
| Σ agent mirror | **143,544,000 atomic** | **143,544,000 atomic** | **零和恒定，两样本完全相同**（= 143.544 USDC；`meanBalanceUsdc` 1.43544 × 100 一致） |
| treasuryOutAtomic / commonsPoolAtomic | 0 / 0 | 0 / 0 | caps 未触 |
| gini | 0.669588 | 0.669463 | **真实链上口径**；此前镜像曾高估到 ~0.785，已由 R5 Fix A 余额闸 + Fix B 镜像重对齐纠正 |
| liveAgents | 100 | 100 | 满载 |
| volumeUsdc | 253.550919 | 253.624024 | 累计真实成交量 |
| count（成交笔数） | 148,200 | 148,226 | +26 |
| settleOk / settleFail | 119,070 / 26,452 | 119,096 / 26,806 | +26 / **+354** |
| successRate（累计） | 0.8182 | 0.8163 | 边际成功率见下方观察 |
| netPending / netPendingTrades | 3,216 / 9,180 | 3,253 / 9,180 | **有界振荡**，非无界堆积（比会话早期 ~2,700 高，是 1440 闸门的预期副作用：dust 滞留 4× 更久） |
| mirrorDriftAtomicSum | 132,980,274 | 132,981,723 | Fix B 每 3 cron 重对齐，累计漂移量持续小幅增长属正常 |
| settleMsAvg / Max / Last | 2,044 / 28,261 / 584 ms | — | settleMsN 81,960 |

**agent 余额分布（atomic）**：min 67、p10 604、p25 113,530、p50 263,198、p75 2,274,577、p90 4,602,626、max 6,285,727（id 0，richestId=0；poorestId=91，余额 67）。高度不均与 gini 0.67 自洽。

**🔍 本会话新观察（只读，未根因定位，留给下一会话判断）**：`recent` / `lastTick` 里 48+50 条记录**几乎全是** `valid:false, reason:"insufficient on-chain USDC: have X, need Y"`，涉及 **12 个固定 id**（36/41/83/85/87/90/91/92/94/97/98/99，多为高 id = 新孵化）。对这 12 个逐一比对：**Fix A 闸门读到的 `have` 与 `/economy` 的 mirror 余额逐位相同**（如 id 92：mirror 573 == gate have 573）⇒ **mirror == chain 在这 12 个上直接验证成立**，它们是真实的"链上尘余额"（< 0.0011 USDC），不是镜像失真。

- 这些失败发生在 `economy.ts:1369-1380` 的 **verify 阶段**（`verified.valid === false` ⇒ `settleFail++` + `pairBackoff.streak++`，**不广播 tx**）；Fix A 在 `queueNet` 阶段的拒绝用的是另一个 reason `"onchain-insolvent"`（样本里只出现 1 次）。
- **不烧 gas 的证据**：同窗口 settle 尝试 ~82/min，而 facilitator nonce 增速仅 ~7.9/min ⇒ 约 90% 的尝试在广播前就被挡下。
- 但代价是：**占用每 cron 40 chunk 的 flush 预算**、持续给这 12 个 debtor 记 `settleFail`（进而压低 MAP-Elites 的 settle-rate 描述子与声誉），且边际成功率被拉到 26/380 ≈ **6.8%**（累计 81.6%）。
- 可能诱因（两个假设，都未证实）：① Fix A 只能拦**新**折叠，闸门武装前已存在的 pendingNets 会一直 verify-fail 到过期；② DO 驱逐会重置**内存态** `pairBackoff`，节流归零后出现失败爆发（`cc3e8d6` 的 commit message 明确预告过这种"部署后单次爆发"）。
- 建议下一步（**需用户批准，勿擅自改**）：给连续 verify-fail N 次的 net 一个丢弃/过期路径，或让 Fix A 同时剪除已被闸门判定 insolvent 的 debtor 的存量 pendingNets。

**shadowCompare（#117/#118 Phase 0+1，已武装、不花真钱）**：crons 13、decisions 832、baselineBuys 116、evolvedBuys 116、gateFlipsToBuy/Hold 0、goodSwitches 0、amountDeltaSumAtomic 0、evolved/baseline AmountSumAtomic 均 1,271,842 ⇒ **演化策略当前与基线完全一致**，证据窗口在积累中。

**真钱上限体系（恒定不扩）**：日 100 USDC（`ECONOMY_DAILY_CAP`）/ 单 agent 日 10（`ECONOMY_PER_AGENT_DAILY_CAP`）/ 单笔 0.05（`ECONOMY_MAX_DEAL`，注释态=代码默认）/ netting（`ECONOMY_NET_MIN_BROADCAST=0.01`）/ WarCoffer 单侧 ≤ 50（合约 immutable）。

### 3.5 🔴 GAS 续航（下一会话头号关注）

**链上实测（2026-09-30T10:35:22Z，Arc RPC 只读，block 23,525,533，chainId 0x13b2）**：

| 项 | 值 |
|----|-----|
| facilitator native | `132470701681994772635` wei = **132.470702** |
| facilitator USDC-precompile | `132470701` atomic = **132.470701 USDC** |
| nonce | **301,439** |

**燃烧率与续航（用 `cc3e8d6` commit message 里记录的 pre-gate 锚点 136.611889 USDC / nonce 299,533 @ 06:34:58Z，与上面的 10:35:22Z 实测构成 4.007h 窗口）**：

| 项 | pre-gate（06:29→06:34Z 窗口） | **post-gate（本次 4.007h 窗口）** |
|----|------------------------------|-----------------------------------|
| 燃烧 | 42.20 USDC/天 | **24.81 USDC/天** |
| tx 量 | 19,432.72 tx/天 | **11,417 tx/天** |
| 单 tx gas 成本 | 0.002172 USDC | **0.002173 USDC**（不变 ⇒ 闸门砍的是**笔数**，不是单价） |
| 续航 | 3.24 天 | **5.34 天** |

- 即 `ECONOMY_NET_FLUSH_TICKS` 360→1440 的应急闸**实测削减燃烧 41.2%**，把续航从 3.24 天拉到 **5.34 天**。
- **枯竭时点估算：约 2026-10-05 傍晚 UTC（±1 天）**。窗口只覆盖 4h 且横跨两次部署（06:35Z 闸门 + 07:59Z CORS 修复），属混合速率；**下一会话应重新采两个间隔 ≥1h 的样本复核**。
- ⚠️ 会话中期口径"余额 ~134.37 / 续航 ~3 天"中的 **3 天是 pre-gate 数字**，闸门武装后已不成立；余额也已从 134.37 漂到 132.47。
- ⚠️ 历史上还出现过"-92.6% / 44.6 天"的读数，那是**部署后短窗低活动期**的假象，**不代表稳态**，别再引用。

**结构性降 gas 的主方案**：Neil 的 **Merkle 批量收据**（#132，`GAS LEVER 2`），已存档于分支 `merkle-batch-receipts` commit `df2e386`，预计再降 ~44% tx。现状实测：该分支**领先 merge-base 1 个 commit、落后 `fresh` 4 个 commit**（落后的是 `8bcd7b0` / `cc3e8d6` / `7464b52` / `71e2aa0`），工作树干净，改动 8 文件 +824/-13：`economy.ts`(+95)、`config.ts`(+21)、`state.ts`(+53)、`provenance.ts`(+26)、新增 `receiptBatch.ts`(+95) 与 `receiptBatch.test.ts`(+424)、`frontend/public/pocaVerify.js`(+28)、`scripts/poca-verify.mjs`(+95)。**rebase 会在 `economy.ts`（flush）与 `config.ts` 撞上 `7464b52`**，需人工解冲突。详见 §10.1。

### 3.6 Worker 部署时间线（`wrangler deployments list --json` 实测，最近 10 次）

| # | 时间 (UTC) | 触发 | Version | 对应动作 |
|---|-----------|------|---------|---------|
| 9 | 2026-09-30T07:59:10Z | deployment | **`9c5af85c…`（生效中）** | `7464b52` CORS always-on + Alchemy 严格优先 + flush 45s 墙钟上界 + config.ts netFlushTicks 同步 |
| 8 | 2026-09-30T06:35:42Z | deployment | `d2ac7122…` | `cc3e8d6` GAS 应急闸 360→1440（var-only，CODE_COMMITMENT 未旋转，epochCount 保持 9） |
| 7 | 2026-09-30T05:49:42Z | secret | `7676d3ba…` | R5 Fix A/B secret 武装（第 2 个） |
| 6 | 2026-09-30T05:49:14Z | secret | `6b63facf…` | R5 Fix A/B secret 武装（第 1 个） |
| 5 | 2026-09-30T05:19:08Z | deployment | `90d9aa65…` | — |
| 4 | 2026-09-30T01:11:51Z | deployment | `1acf3a6a…` | — |
| 3 | 2026-09-30T00:12:28Z | secret | `ce8f8d69…` | — |
| 2 | 2026-09-29T23:44:06Z | deployment | `7ec45d16…` | — |
| 1 | 2026-09-29T23:43:42Z | secret | `bdcb2105…` | — |
| 0 | 2026-09-29T14:51:14Z | deployment | `2e829a60…` | — |

作者均为 `dlcmaliling@gmail.com`，strategy `percentage` 100%（无灰度分裂）。

### 3.7 验证门基线

| 门 | 基线 | 命令 |
|----|------|------|
| typecheck | tsc×3 全绿（**排除 `*.test.ts`**，所以接口加字段后必须另跑 test） | `npm run typecheck` |
| 单测 | **1186/1186** | `npm test` |
| 旋钮一致性 | **29/29** | `npm run check:knobs` |
| PoCA 验证 | `--selftest` 通过；`--registry` 模式有已知假阳性（#134，见 §10.5） | `npm run verify:poca` |
| 确定性 | brain-manifest replay **双跑 manifestHash 逐位一致**（`c0288c45…`） | `npm run replay` |
| 合约 | forge 全绿（Lineage 记录 61/61） | `contracts/` 内 forge |

上述基线来自 `7464b52` 的部署前门禁记录；**本次交接是 docs-only，未重跑任何门**。下一会话若要部署，必须重新跑全量门。

---

## 4. 本次会话工作（时间线）

### 4.1 GAS 调研 + 应急闸（#133，commit `cc3e8d6`）

- **量化调研**：两笔干净 pre-deploy 样本（06:29:34Z→06:34:58Z）测得 nonce 299,460→299,533 = **19,432.72 tx/天**，余额 136.770432→136.611889 = **−42.20 USDC/天**，隐含 0.002172 USDC/tx ⇒ **RUNWAY 3.24 天**。
- **动作**：`ECONOMY_NET_FLUSH_TICKS` 360→**1440**（强制 dust flush 窗口从 ~2h 拉到 ~8h）。
- **var-only，已验证**：`wrangler.toml` 在 treeHash 的 SRC_DIRS 之外 ⇒ CODE_COMMITMENT 保持 `1616fe50…`、treeHash/artifactHash 不变、files 144；`netFlushTicks` 也不在 `pocaKnobsHash()` 的 22 个开关里 ⇒ **既不 kind-7 也不 kind-3**。部署后线上确认：epochCount 9 不变、adminCount 10 不变、continuity unbroken、mirrorFailures 3 不变。
- **接受的临时副作用**：netPending 增长（dust 滞留）、dust 溯源延迟上升、mirrorDrift 在两次 resync 之间变宽（Fix B 每 3 cron 吸收）。**没有放宽任何 cap，没有触碰任何真钱旋钮。**
- **回滚**：秒级——改回 `"360"` + 仓库根 `npm run deploy:worker`。
- **遗留坑**：这次只改了 `wrangler.toml`，**漏改 `config.ts` 的 `?? "360"` 兜底**，被 `cron99.test.ts` 的 M9 drift guard 抓到（部署前一度 1186/1 fail），在 `7464b52` 里补齐。教训见 §5.1。

### 4.2 R5 诚实镜像 Fix A + Fix B 翻开（`876de0c` 暗部署 → 05:49Z secret 武装）

- **背景**：settle-fail 螺旋——镜像余额高于链上真实余额的 agent 每次 flush 都失败，白烧 settle attempt 与 gas。
- **Fix A `ECONOMY_ONCHAIN_BALANCE_GATE="true"`**：`queueNet` 在折叠 buyer 前查每 cron 一次的 Multicall3 `balanceOf` 缓存；链上不足者直接拒绝（`valid:false, reason:"onchain-insolvent"`），不再无限重排。**所有分支 fail-open**（关闭 / 模拟器 / 冷缓存 / 未知 id / 地址不在 multicall 结果里 / RPC 抛错 ⇒ 一律视为有偿付能力），所以闸门故障永不阻塞结算。**只读，零花费。**
- **Fix B `ECONOMY_MIRROR_RESYNC_EVERY_N_CRON="3"`**：每 3 个 cron 把每个活体 agent 的**显示镜像**覆写为其真实链上 `balanceOf`，并把 Σ|mirror − onchain| 累加进 `totals.mirrorDriftAtomicSum`（终身量，`/economy` 暴露，仅在 N>0 时持久化）。`"0"` = 关闭。
  - **不变量（武装时实测）**：镜像被设为**等于**链上，可上可下——武装瞬间 64/100 是 mirror < chain 被抬高，36/100 是 mirror > chain 被压低。关键是**后态 mirror == chain**，于是"mirror > chain 导致每次 flush 必败"的状态无法再持续。
  - N 取 3 而非 6：cron 计数器是**内存态**（不持久化），观测到的实例寿命短至 2 个 cron，N 太大有"resync 永不触发"的静默失败风险。闸门每 cron 已做一次 Multicall3，resync 复用同一缓存 ⇒ N=1/3/6 的 RPC 成本相同。
  - `mirrorDriftAtomicLast`（每 cron 增量）是私有运行时字段，**不在任何端点暴露**（测试用 `as any` 取）。
- **配套 commit**：`a5f8f7f` 退休 `POPULATION_SEED_BASE` 与 `BOURSE_TITHE_MILESTONE_MURMUR` 两个 var（零行为变更：var 值 == config.ts 里唯一的代码默认值），为这两个 secret 腾出 128 墙位；`8bcd7b0` 把 R5 Fix-A/B 的 secret 说明块订正为**武装时实测**的事实。
- **效果（本次实测）**：Gini 从镜像高估的 ~0.785 回到真实链上口径 **0.6696**；12 个尘余额 agent 的 `have` 与 mirror 逐位相同 ⇒ 镜像已诚实。

### 4.3 基尼干预包（#123 equity-tilt，`876de0c`，**暗部署 · 开关全 OFF**）

- 与 R5 同一 commit 上线，代码在但**所有开关 OFF**，字节等价。
- 现状佐证：`treasuryOutAtomic=0`、`commonsPoolAtomic=0` ⇒ 干预通道**从未动用真钱**，caps 未触。
- 翻开需用户单独批准（硬条款 §2.3.1）。标定工具：`scripts/calibrate-equity-tilt.ts`。

### 4.4 前端离线生产事故根治（#136，commit `7464b52`）

**症状**：`www.muros.live` 间歇性翻成 `state.offline=true` 并显示 "dreaming" 合成数据（20s breaker），浏览器报 **CORS 错误**而非 5xx。

**根因链（三段，缺一不可）**：

1. cron 系统性撞 **90s abort**——实测 live tail：11 个 cron 心跳里 **3 个是 89998ms（27%）**。
2. 撞墙的 cron 会把 **Durable Object 的单线程 input queue 堵满整整 90s**；排在其后的所有 DO-backed HTTP 请求全部 reject。而 `index.ts` 的 `stub.fetch()` **没有 try/catch**，异常逃出 handler ⇒ **Cloudflare 自己合成一个错误响应**，该响应不带任何自定义头 ⇒ **没有 `Access-Control-Allow-Origin`** ⇒ 浏览器报 CORS 错误。旁证：同期 worker-served 的 D1 路由（`/history`、`/shadow`、`/replay/economy`）**全程正常**，只有 DO-backed 端点挂。

**三处修复**：

1. **`index.ts` — CORS ALWAYS-ON（安全网）**：handler 主体原样搬进 `route()`；`fetch()` 先解析回显 Origin（`safeOrigin`，永不抛），再用 try/catch 包住 `route()`，异常时返回**带 `corsHeaders()` + `Cache-Control: no-store` 的 500 JSON**。从此没有任何代码路径能漏掉 ACAO，后端卡死会降级成"前端可读、可重试的 500"，而不是整片 CORS 黑洞。`Vary: Origin` 本已存在 ⇒ edge-cache 投毒洞保持关闭。（`index.ts` +299/-… 是本 commit 最大改动。）
2. **`chain.ts` — ALCHEMY 严格优先（真根因）**：`rotatingTransport` 原本在 5 端点池里轮询 ⇒ 只有 20% 的调用打到付费 Alchemy URL；配合每端点 6s 超时、`retryCount:0`、顺序 fall-through，**一次逻辑 RPC 最坏要花 5×6s = 30s**。新增 `preferFirst`：只要配置了 `ALCHEMY_ARC_RPC_URL` 就把 start 钉在 0，公共池降级为完整 failover 扫描 ⇒ **韧性不变，happy-path 延迟封顶在一个 round-trip**。
3. **`economy.ts` — flush 墙钟上界**：每个广播 chunk 要花 verify 读 + settle tx + registry commit + IPFS pin（2-10s），所以**光靠 40 chunk 的数量预算**即使 RPC 全健康也可能跑超 90s abort。`flush()` 现在**超过 45s deadline 也会 break**，把余量留给本 beat 的其余工作。安全性：H7 carry-forward 只在 chunk **成功**时才 `remaining -= value`（实测 `economy.ts:1396`），未完成的 pair 留在 `pendingNets` ⇒ 提前 break 只是**把债延到下一个 cron，绝不免债**。
4. **附带修正 #133 的 M9 desync**：把 `config.ts` 的 `netFlushTicks` 兜底与 `cron99.test.ts` 的陈旧字面量同步到 1440。`wrangler.toml` 本身未动 ⇒ **线上行为不变**，但"[vars] 丢失 ⇒ 静默 4× flush 烧干 facilitator"的雷被拆掉。

**部署前门禁**：tsc×3 clean、**1186/1186** 测试通过、`check-knob-defaults` **29/29** 一致、brain-manifest replay 双跑 manifestHash 逐位一致（`c0288c45…`）。
**效果**：CODE_COMMITMENT `1616fe50` → `066121bc`，kind7 CODE_CHANGE，**epochCount 9 → 10**，continuity unbroken。

### 4.5 WarCoffer 审计（只读核实，未改代码）

- 核实了两条被质疑的声明：**事实成立，但属设计意图，不是漏洞**。
- 最大暴露 **50 USDC 已封顶**（`WAR_MAX_ESCROW_USDC="50"`，且是合约内 **immutable** 硬顶）；war-rail 绕过 ECONOMY 日限但受这个链上 EscrowCap 硬顶约束（已在 `SECURITY.md` 的"Disclosed Centralization & Trust Assumptions"里披露）。
- 遗留一个**纯注释**问题：`WarCoffer.sol` 第 133 行注释写 "never withdraw … except a house vault"，实际**连 vault 提取都不存在**（单向沉没池）。属误导性注释，订正需用户批准（§10.7）。

### 4.6 首页 atlas 视图恢复面板可见（task 137/139，commit `71e2aa0`）

- 问题：atlas（羊皮纸世界地图册）首页把 `.panel-econ` / `.panel-pop` 藏掉了。
- 修复：`styles.css` +24/-1（叶几何：`--leaf-top` 为 panel-econ / panel-pop / land-leaderboard / cron-warn 共享的上边缘；`--col-l` 为最宽左栏叶；econ/temp 的 cap 公式减掉它，使 panel-econ 的下边缘正好落在该处）；`index.html` 把 `styles.css?v=162` → `?v=163`。
- 复验：线上 `styles.css?v=163` 359,187 B == 本地；index.html 84,548 B == 本地。已 push `fresh` 与 `fresh:main`。

### 4.7 对外文案

- 准备了**双语长推更新文案**（未发布）。对外文案体裁有既有判据：宣传叙事 / 社群答疑 / 更新说明 changelog 三种体裁不同，release-notes 用工程语体，单条长推文优先。

---

## 5. 关键技术决策

### 5.1 双写旋钮必须三处同改（血泪教训）

`ECONOMY_NET_FLUSH_TICKS` 这类**同时写在 `wrangler.toml [vars]` 和 `config.ts` 代码兜底**里的旋钮，任何调参都要同步：

1. `wrangler.toml` 的 `[vars]` 值（当前 L136 = `"1440"`）
2. `config.ts` 的 `?? "<default>"` 兜底（当前 L1102 = `?? "1440"`）
3. `cron99.test.ts` 的 M9 字面量断言（当前 L584 测试名里的 `0.01 / 1440` + L591 的 `assert.equal(cfg.economy.netFlushTicks, 1440, …)`）

**为什么**：`config.ts` 用 env 兜底，`[vars]` 一旦丢失/未注入就**静默回落旧默认**。只改 toml 会让 net flush 频率静默 4× 抬升、烧干 facilitator，而**生产运行不告警、退出码全绿**。`cron99.test.ts:606-618` 的 **M9 drift guard** 会直接读 `wrangler.toml` 重新推导期望值，两端不一致就先红并点名文件——这是唯一的安全网。L600 那条"显式 env 覆盖代码默认"的测试用 `"30"`，**调参时不需要改它**。

### 5.2 应急闸取 var-only，不动代码默认（当时的决定）

`cc3e8d6` 刻意只改 `wrangler.toml`：var-only 不旋转 CODE_COMMITMENT、不触发 kind-7/kind-3 纪元封印，回滚是秒级。代价就是 §5.1 的 desync 雷（后由 `7464b52` 补平）。**下次做同类应急闸，直接三处同改，别再分两步。**

### 5.3 跳过"每 N cron 读余额"方案

考虑过让余额读取节流（每 N cron 才读一次链上余额）以省 RPC，**已否决**：那会让 Fix A 的闸门在节流窗口内**fail-open**，等于削弱刚武装上的诚实镜像修复。当前选择是**每 cron 一次 Multicall3 批量读**（一次 RPC 覆盖全部 agent），Fix B 的 resync 复用同一缓存 ⇒ N=1/3/6 成本相同。

### 5.4 Merkle 批量收据是结构性降 gas 主方案，但需前端配套

复用现有 `commit()` + 链下 Merkle 包含证明，**无需重部署合约**；把每 cron 的 N 笔收据折叠成 1 笔根提交（tx 数 N→1），USDC 真实转账一笔不减，单笔仍可离线验证包含性。预计再降 ~44% gas。**但必须补前端批量证明展示（t8）+ 文档（t9）**，否则用户拿到的收据无法自证。

### 5.5 新膜层事件不做链上锚定

零 gas 决策：新增膜层事件只依赖编年史哈希链（`chroniclerRulesHash`），不额外上链。链上锚定只保留给 PoCA 纪元/承诺、收据哈希链、manifest、lineage、arena、war 这些"必须 trustless"的东西。

### 5.6 链上广播不可跨车道并行（结构不变量）

`economy.flush()` 与 `driveArena` / `driveWar` / `driveEvolution` / prediction commit **共用同一个 facilitator 钱包且无 nonceManager**，注册表侧还共用严格顺序的 `proofChainHead`（`netReceipt.prevChain = this.proofChainHead`，收到 receipt 才推进）。任何 `Promise.all/allSettled` 式并行都会抽到同一 nonce（碰撞）与同一 prevChain（合约 `BadPrevHead` revert），并可能**永久 wedge 注册链**。

- **反直觉点**：按买方 HD 地址分组并行**也不解决**——被共享的不是买方的 gas nonce，而是中继钱包的 nonce 与 proof-chain head；EIP-3009 的 nonce 由 receiptHash 派生本身唯一，不构成并行依据。
- 要安全并行必须先做 send / wait-receipt 拆分，或引入带 nonceManager 的多中继钱包 / 全托管 Circle 通道。
- **只有只读操作可并行**：`sampleArcActivity`（内部已 `Promise.all` 并发 `getBlock`）、`driveBourse` 的 `getLogs` 这类无签名无链头依赖的采样，可在 cron 开头用 `Promise.allSettled` 合并预取。
- 改任何 cron 内链上调度前，先 grep `commitToRegistry` 与 `proofChainHead` 的赋值点确认这两处串行依赖仍在。
- **推论**：降 gas 只能**减少广播次数本身**，不能靠并行省时间/成本。

### 5.7 纯 UI 改动走免确认三连，但免测试不免复验

改 → bump → 部署可以不等确认（零真钱风险：3D 主画布 / `drawers.js` / `polling.js` 数据层不动）；但**部署后必须做线上字节复验**（§7.4），因为 CDN 缓存与 `?v` 级联是最容易翻车的地方。

### 5.8 暗部署（Dark Deployment）

新增资金动作与计费语义变更一律"代码上线 + 开关 OFF + 验证字节等价"，再分级翻开。当前处于暗部署状态的：#123 equity-tilt/Gini 干预包（全 OFF）、shadowCompare Phase 0/1（已武装但**不花真钱**）。

---

## 6. 仓库结构

```
GOOD2/                                   # 仓库根（npm workspaces）
├── package.json                         # scripts: typecheck / test / check:knobs / verify:poca /
│                                        #          replay / deploy:worker / deploy:frontend / deploy
├── HANDOVER.md                          # ← 本文档
├── README.md  API.md  CHANGELOG.md  SECURITY.md  CONTRIBUTING.md  CODE_OF_CONDUCT.md  LICENSE
├── docs/                                # AGENT-ECONOMY.md / ARCHITECTURE.md / DEPLOYMENT.md /
│                                        # NEURAL-SIM.md / POCA.md（553 行完整规范）
├── scripts/                             # gen-codecommit.mjs（deploy 前自动跑）、bump-frontend-version.mjs、
│                                        # poca-verify.mjs + poca-verify.vectors.json、check-knob-defaults.mjs、
│                                        # calibrate-equity-tilt.ts、verify-flywire.ts、_*.py/_*.ts（FlyWire 数据溯源工具）
├── .github/workflows/                   # CI：verify（node 四门）+ contracts（forge）
├── .foundry-bin/                        # Foundry 工具链（anvil/cast/forge）— 保留
├── .worktrees/merkle-batch/             # 分支 merkle-batch-receipts @ df2e386 的 worktree（干净）
├── _head_wt/                            # 遗留 worktree @ 6492d85（detached）— 清理候选
├── _connectome_data/                    # FlyWire 原始数据（feather）— 保留（溯源）
├── design-mockups/                      # UI 效果图参考（含 v2/direction-a.html、IA-MAPPING.md）— 保留
└── packages/
    ├── trader-worker/                   # ★ Cloudflare Worker 主运行时（注意：不是 packages/worker）
    │   ├── wrangler.toml                #   654 行；[vars] 在 L30-608（122 个未注释项）
    │   ├── src/                         #   index.ts（入口/cron/route）、state.ts（DO/land/persist）、
    │   │                                #   economy.ts（5545 行，flush/netting/R5）、chain.ts（RPC transport）、
    │   │                                #   config.ts（loadConfig + 全部代码默认值）、codeCommitment.ts（生成物）、
    │   │                                #   poca.ts（PoCA 引擎）、provenance.ts、openapi.ts、
    │   │                                #   cron99.test.ts（M9 drift guard）、r5Fix.test.ts、equityTilt.test.ts、
    │   │                                #   shadowCompare.test.ts、flywire-loader.ts …
    │   ├── contracts/                   #   Solidity + foundry.toml + build/out/lib/test
    │   │                                #   ContinuityRegistry.sol / NeuralReceiptRegistry.sol /
    │   │                                #   NeuralManifestRegistry.sol / ConnectomeLineage.sol /
    │   │                                #   PredictionArena.sol / WarCoffer.sol + *_ADDRESS.txt
    │   ├── scripts/  baseline-evidence/  capability-evidence/  schema.sql（D1，20,171 B）
    │   ├── .env.local                   #   本地密钥副本 — 未跟踪，永不提交，永不打印
    │   └── admin-token.key  .circle-key.local  .dev.vars.example
    ├── frontend/                        # ★ Cloudflare Pages 裸 ESM 前端（无打包器）
    │   ├── package.json                 #   deploy = wrangler pages deploy public --project-name=murmur --branch=main
    │   ├── scripts/                     #   check-syntax.mjs、audit-i18n.mjs
    │   └── public/                      #   index.html（84,548 B）、styles.css（359,187 B）、_headers、
    │                                    #   main.js、scene3d.js、render2d.js、camera.js、dayNight.js、particles.js、
    │                                    #   terrainTex.js、walkMode.js、sim.js、shared.js、nations.js、civstage.js、
    │                                    #   institutions.js、institutionsHud.js、landLayer.js、landDrawer.js、
    │                                    #   lineageView.js + lv*.js（8 个）、economy.js、evolution.js、inspector.js、
    │                                    #   drawers.js（253,692 B，含真钱操作，谨慎修改）、polling.js、pocaVerify.js、
    │                                    #   i18n.js / i18n-ui.js（631,114 B）/ i18n-chron.js（7 语含 RTL）、
    │                                    #   flywire-meta.json、assets/（含 nsfw 模型权重）、
    │                                    #   developers.html、community.html/js、canary.html、
    │                                    #   app.js（571,309 B，**遗留单体备份，index.html 不加载**，bump 脚本 SKIP）
    ├── fly-brain/src/                   # 神经模拟器：connectome-data/（FlyWire 子图 + 生成器）、
    │                                    # neuromod.ts（DA/OA 门控）、genome.ts、manifest.ts（manifestHash）
    └── arc-circle-x402/                 # Circle x402 Facilitator 通用客户端（开源包）
```

**workspaces**：`packages/fly-brain`、`packages/trader-worker`、`packages/frontend`、`packages/arc-circle-x402`。

**⚠️ 旧文档陷阱**：早期交接文档写的 `packages/worker` **已不存在**，现在是 `packages/trader-worker`。

---

## 7. 部署与运维

### 7.1 Worker 部署（唯一正确姿势）

```powershell
# 仓库根执行（会先跑 codegen 封印 CODE_COMMITMENT，再部署）
$env:HTTPS_PROXY=$env:HTTP_PROXY="http://127.0.0.1:17891"
npm run deploy:worker
```

- `deploy:worker` = `node scripts/gen-codecommit.mjs && npm run deploy -w @fly/trader-worker`。**codegen 必须在 wrangler 之前跑**，否则部署的 artifact 与 CODE_COMMITMENT 不一致，PoCA 会把它当成静默换码。
- **绝对不要用 `npx wrangler deploy`**：它跳过 codegen，会部署一个未被封印的 artifact（PoCA 纪元链与代码身份脱钩）。旧交接文档里写的 `cd packages/worker && npx wrangler deploy` **是错的，已作废**。
- 部署会**重启 DO**：`pairBackoff` 是内存态，重启后节流归零 ⇒ **部署后第一个 cron 可能出现单次 settleFail 爆发**（`cc3e8d6` 部署时实测 4.7min 内 +120 fail / +0 ok），随后随 streak 重建而消退。这是良性的，别当成事故。
- 部署也会重置 Fix B 的**内存态 cron 计数器**（`mirrorResyncEveryNCron` 的计数不持久化）。

### 7.2 前端部署

```powershell
# 仓库根执行；代理必须先设，否则 wrangler fetch 在非交互 shell 里超时
$env:HTTPS_PROXY=$env:HTTP_PROXY="http://127.0.0.1:17891"
npm run deploy -w @fly/frontend      # 等价于 npm run deploy:frontend
# 实际命令：wrangler pages deploy public --project-name=murmur --branch=main
```

本地预览：`npm run dev -w @fly/frontend`（`npx serve public -l 8788`）。

### 7.3 成败判据（PowerShell 会把 wrangler 的 stderr 进度条包成假报错）

**不要**看到红字就判定失败。判据是三条同时成立：

1. `$LASTEXITCODE` / `EXIT=0`；
2. 输出里出现 **`Deployed murmur`**（worker，伴随 `Uploaded murmur` + `Deployed murmur triggers`）**或 `Deployment complete`**（Pages）；
3. 拿到 **Version ID / hash URL**（worker 形如 `Version ID 9c5af85c-…`，Pages 形如 `https://9a1a0e43.murmur-4sx.pages.dev`）。

典型假报错：`node.exe : ⚠ [WARNING] Proxy environment variables detected…` 被 PowerShell 包成 `NativeCommandError` + `FullyQualifiedErrorId`——这只是 wrangler 往 stderr 写进度，**不是错误**。

参考实测数据点（`cc3e8d6` 部署）：`EXIT=0`、`Uploaded murmur` + `Deployed murmur triggers`、`Version ID d2ac7122-1d79-455f-a1aa-fba4b9782ad9`、**2151.68 KiB / gzip 516.74 KiB**、绑定清单仍 126 个 `env.*`（122 vars + 4 非文本）+ 6 secrets = **128/128**。

### 7.4 线上复验（缓存破除两代规则）

**规则一（入口 + 裸导入模块）**：`index.html` 里 bump `main.js?v=N`；`_headers` 对所有本地 ESM 模块下 `no-cache, must-revalidate`（`shared.js` / `i18n*.js` / `pocaVerify.js` 更强，是 `no-cache, no-store, must-revalidate`），HTML 本身 `no-store`。

> 为什么两层都要：`muros.live` 自定义域有 **zone 级 Cache Rule（max-age=14400）会覆盖 `_headers`**，所以真正保证新鲜的是 `?v=` 让每次部署产生唯一 URL ⇒ CDN miss ⇒ 回源取新字节。`_headers` 只是 Pages 源站侧的 belt-and-braces。

**规则二（字典模块例外，最容易翻车）**：`scripts/bump-frontend-version.mjs` 的 `SKIP_MODULES = {i18n.js, i18n-ui.js, i18n-chron.js}` —— **脚本不动这三个**。所以改了字典必须**手工级联 bump 所有引用点**：

- 改 `i18n-ui.js` → bump `i18n.js:15` 里的 `./i18n-ui.js?v=` → 再 bump **18 个模块**里的 `./i18n.js?v=`（`main.js`、`drawers.js`、`polling.js`、`economy.js`、`evolution.js`、`render2d.js`、`inspector.js`、`institutionsHud.js`、`landLayer.js`、`landDrawer.js`、`lineageView.js`、`lvInteract.js`、`lvGenetics.js`、`lvNeural.js`、`lvProvenance.js`、`lvTimeReplay.js`、`walkMode.js` 等）。
- 改 `i18n-chron.js` → bump `i18n.js:16` 里的 `./i18n-chron.js?v=` → 同样级联 `i18n.js?v=`。
- **为什么必须级联**：ESM 模块图以**完整解析后的 URL** 为键。若一部分 importer 用 `i18n.js?v=113`、另一部分用 `?v=114`，就会**双实例分叉**（两份字典、`currentLang` 各存一份），语言切换实时重渲染会失效。

bump 脚本用法与当前陷阱：

```powershell
node scripts/bump-frontend-version.mjs --dry   # 预览
node scripts/bump-frontend-version.mjs         # 自动 = index.html 里 main.js?v= 的值 +1
node scripts/bump-frontend-version.mjs 164     # 显式版本
```

- 脚本把**所有本地 `.js` 的 bare import** 锁步到同一个 N，并同时把 `main.js?v=N` 与 `styles.css?v=N` 都设为 N。
- `SKIP_FILES = {app.js}`：`app.js`（571 KB 遗留单体备份，`index.html` 已不加载它，只留一行注释说明）被跳过，所以它里面的 `i18n.js?v=100` 是**陈旧但无害**的，别去"修"它。
- **当前不同步**：`main.js?v=162` / `styles.css?v=163`。现在直接跑脚本会得到 **163/163**（main.js 抬到 163，css 不动）。若下次要 css 到 164，必须传显式版本号。

**复验命令（务必用 `curl.exe` 落盘 + `Select-String`，抓根路径要带 `-L`）**：

```powershell
$env:HTTPS_PROXY=$env:HTTP_PROXY="http://127.0.0.1:17891"
curl.exe -sL --max-time 40 "https://www.muros.live/" -o _live_index.html
(Get-Content _live_index.html -Raw | Select-String -Pattern '(main\.js|styles\.css)\?v=\d+' -AllMatches).Matches.Value
(Get-Item _live_index.html).Length          # 与本地 (Get-Item packages\frontend\public\index.html).Length 比
curl.exe -sL --max-time 40 "https://www.muros.live/styles.css?v=163" -o _live_styles.css
(Get-Item _live_styles.css).Length          # 与本地 styles.css 比
Select-String -Path _live_styles.css -Pattern "<你改的 CSS 选择器>"
```

本会话实测结果：index.html **84,548 B == 本地**、styles.css?v=163 **359,187 B == 本地** ⇒ 部署确认生效。

- 用 `curl.exe` 而不是 `curl`（后者在 PowerShell 里是 `Invoke-WebRequest` 别名，行为不同）。
- 带 `-L`：根路径有 308 重定向，不带会拿到空 body 而误判。

### 7.5 监控要点

| 项 | 现状 / 阈值 |
|----|-------------|
| cron 壁钟 | 目标 < 90s abort；`7464b52` 前实测 **27% 的 beat 撞 89998ms**，修复后应显著下降——**下一会话请重新 tail 一次确认** |
| flush 预算 | 40 chunk/cron（`netFlushBudgetPerCron`）+ **45s 墙钟上界**（新） |
| DO 冻结 | `CRON_WEDGE_MS=180s` watchdog，cron START 时 arm alarm |
| persist | 分片写，`persistChunkSize=262144`（#98 的 crash-safe sharded persist） |
| settle 成功率 | 累计 **81.6%**；边际见 §3.4 观察项 |
| netPending | 有界振荡（当前 ~3,216→3,253）；**无界单调上涨才是故障** |
| facilitator 余额 | **132.47 USDC**，~24.8 USDC/天 ⇒ 见 §3.5 |
| features 数 | 基线 **13**，不可下降 |

### 7.6 常用只读命令

```powershell
# 部署历史（Version ID / 触发源 / 时间）
cd packages\trader-worker; npx --no-install wrangler deployments list --json
# 注意：是 --json，不是 --format json（后者会报 Unknown argument: format）

# API 探针（全部 GET，免费无钥，CORS 开放）
curl.exe -sL "https://api.muros.live/health"
curl.exe -sL "https://api.muros.live/poca"          # epochCount / continuity / codeCommitment / mirror
curl.exe -sL "https://api.muros.live/poca/admin?limit=8"   # kind=7 CODE_CHANGE / kind=3 PARAM_OVERRIDE，看 txHash 有无
curl.exe -sL "https://api.muros.live/economy"       # totals / agents / recent / shadowCompare
curl.exe -sL "https://api.muros.live/annals?limit=1"
curl.exe -sL "https://api.muros.live/population"    # {snapshot:{tickIndex,collective,flies}, economy, topology}
curl.exe -sL "https://api.muros.live/history"

# facilitator 余额（只读 RPC；本会话用仓库根 _t141_bal.mjs 做过，脚本从 wrangler.toml 读公共 RPC_URL，只打印余额，不打印 RPC/密钥）
cast balance 0x2b9A3197ed35d56E2e1c2A01f4D649586821055c --rpc-url <ARC_RPC>
cast call 0x3600000000000000000000000000000000000000 "balanceOf(address)(uint256)" 0x2b9A…055c --rpc-url <ARC_RPC>
cast nonce 0x2b9A3197ed35d56E2e1c2A01f4D649586821055c --rpc-url <ARC_RPC>
```

---

## 8. 编年史监控（用户明确要求：经常/定期做，不止部署后）

**背景**：编年史是文明心跳，也是词库 lexicon 铸词的数据源，停更同时冻结历史与造词。曾停更 3 小时（#97，根因 cron 壁钟超 cadence；#98 根治 = persist 分片写 + flush 预算上限 + 积压告警 + 壁钟监控）；2026-09-29 的回归版本 `48c50d3` 又冻结 72 分钟，靠部署 fresh（`eb42670`）恢复。

**只读探针**：`GET api.muros.live` 的 `/annals`、`/history`、`/economy`、`/population`、`/health`，**间隔数分钟取 3-4 个样本（跨约 15 分钟）**，确认**持续**单调前进，而不是单次递增。

**9 条判据（全不触发 = 健康）**：

1. `tickIndex` 每 cron +6 单调；
2. `annals.seq` 推进；
3. `headHash` 每样本变化；
4. head 事件年龄 < ~600s；
5. `lastCron` 年龄 < 180s（`CRON_STALE_MS` 看门狗）；
6. `/health.ok == true`；
7. `features` 数不降（基线 **13**）；
8. `economy.count` 推进；
9. `netPending` 不无界堆积（应下降或稳态振荡）。

**⚠️ 校准（最容易误报的一条）**：实际 cron 周期 **~140-200s**（不是 60s；`cronRunning` 守卫会静默 SKIP 中间触发）是 #98 之后的**正常亚临床态，不是停更**。只有**单步间隔漂移 > ~300s** 或**多小时冻结**才该告警。

**本次交接实测样本（可作下一会话的基线对照）**：

| 时刻 (UTC) | tickIndex | annals.seq | headHash | era | 备注 |
|-----------|-----------|-----------|----------|-----|------|
| 10:31:36Z | 67,995 | 15,872 | `78c8189a3a9d0708…` | 143 | head 条目 tick 68,000、kind `CENSUS`、"100 minds alive" |
| ~10:32:5xZ | 68,048（`/population`） | 15,888 | `3e21d3b119f6ee18…` | 143 | **+16 seq / ~70s** |
| 10:36:03Z | 68,062 | — | — | 143 | `/health.ok=true`、features 13 |

⇒ **编年史正常推进，无停更**。generation 583、civLevel 42（declining）、chroniclerHash `a1726ef821f5…`、era 143 "the Yoke of Houses"（CALM）。

**发现真停更时的处置顺序**：只读排查 cron 壁钟 / 积压 / DO eviction / persist 报错 / Version 是否被回退；**涉真钱风险第一步 `ECONOMY_REAL_SPEND=false` 止血**（§2.1）；恢复手段是部署 fresh（带上 #98 的修复）。**只读诊断阶段不擅动生产。**

---

## 9. Git 拓扑

- **远端**：**仅** `new-origin` → `https://github.com/EvolutionDeep/murmur.git`（fetch + push）。旧仓已彻底断开。远端还有 `new-origin/HEAD -> new-origin/main` 与一个 dependabot 分支 `dependabot/npm_and_yarn/types/node-26.5.1`。
- **分支**：
  - `fresh` ← **工作分支**（当前 checkout，HEAD `71e2aa0`，工作树干净）
  - `main` ← 发布分支（也在 `71e2aa0`）
  - `merkle-batch-receipts` @ `df2e386`（在 `.worktrees/merkle-batch` 里 checkout，故 `git branch` 显示 `+`）
  - `feat/lexicon-permanence` @ `7cde7ba`（已合入 fresh，历史分支）
  - `hotfix/c2-x402`（历史分支）
- **worktrees**（`git worktree list` 实测）：
  - `C:/Users/dlcma/Desktop/GOOD2` → `71e2aa0 [fresh]`
  - `C:/Users/dlcma/Desktop/GOOD2/.worktrees/merkle-batch` → `df2e386 [merkle-batch-receipts]`（干净）
  - `C:/Users/dlcma/Desktop/GOOD2/_head_wt` → `6492d85`（**detached，遗留**，清理候选）
- **stash**：`stash@{0}: On fresh: kim-responsive` —— 用户取消的全尺寸响应式优化（`styles.css` +1587/-324、`index.html` v=111、`landLayer.js`），内含 2 个真缺陷修复（≤480px 抽屉左移 10px、`.epitaph` 与 HUD 重叠）。如需恢复：`git stash pop` 后手工合并进 Direction A 的新 `styles.css`（**注意 styles.css 已大幅演进，直接 pop 必冲突**）。

**标准推送（两条都要）**：

```powershell
git push new-origin fresh
git push new-origin fresh:main
```

三方对齐（`fresh` == `main` == `new-origin/*`）是常态，推完务必确认。

---

## 10. 下一步 / 遗留 backlog

### 10.1 🔴 GAS 续航（头号优先级）

- **现状实测**：facilitator **132.4707 USDC**，燃烧 **24.81 USDC/天**（11,417 tx/天），续航 **≈5.34 天** ⇒ 约 **2026-10-05 傍晚 UTC** 枯竭。
- **两条路，可并行**：
  1. **再充值兜底**（最快、最稳）。⚠️ **务必确认发的是能付 gas 的那种资产**：Arc 的 **native gas 代币**与 **6 位小数的 USDC precompile**（`0x3600…0000`）在代码里严格分离，但在这个钱包上二者数值恒等（native == atomic × 1e12）。发错资产 = 白充。
  2. **部署 #132 Merkle 批量收据**（结构性，预计再降 ~44% tx）。存档：分支 `merkle-batch-receipts`，commit `df2e386`，worktree `.worktrees/merkle-batch`（干净）。
     - 已验证状态：tsc×3 绿、1019/1019 测试、OFF 时字节等价、ON 时 N→1 折叠逐笔可验。
     - **落后 fresh 4 个 commit**（`8bcd7b0`、`cc3e8d6`、`7464b52`、`71e2aa0`），改动 8 文件 +824/-13。
     - **部署前必做**：① 补 **t8 前端批量证明显示**（否则用户拿到的收据无法自证包含性）；② 补 **t9 文档**；③ **rebase 到最新 HEAD**（会在 `economy.ts` 的 flush 与 `config.ts` 撞 `7464b52`，需人工解冲突）；④ 跑**全量验证门**（tsc×3 + 全测 + `check:knobs` + replay 双跑一致 + OFF 字节等价复核）。
     - 涉及真钱路径 ⇒ **需用户单独批准部署**（§2.3.1）。
- **重新采基线**：下一会话应先取**两个间隔 ≥1h** 的 (余额, nonce, 时间) 样本重算燃烧率，别直接沿用本次的 4h 混合窗口。

### 10.2 netFlushTicks 回调（Merkle 上线后）

Merkle 批量收据上线后，把 `ECONOMY_NET_FLUSH_TICKS` 从 **1440 调回 360**，**三处同改**（详见 §5.1）：

1. `packages/trader-worker/wrangler.toml:136` → `"360"`（并更新该行注释里的"TEMPORARY GAS EMERGENCY GATE (#133)"说明）
2. `packages/trader-worker/src/config.ts:1102` → `?? "360"`
3. `packages/trader-worker/src/cron99.test.ts:591` 的 `assert.equal(cfg.economy.netFlushTicks, 1440, …)` → `360`，以及 **L584 测试名**里的 `"…0.01 / 1440…"` → `"…0.01 / 360…"`

改完跑全测确认 **1186/1186**（L606-618 的 drift guard 会自动读 toml 重新推导，两端不一致会先红并点名文件；L600 那条用 `"30"` 的显式覆盖测试**不用改**）。

**只改 `wrangler.toml` 的后果**：`config.ts` 兜底仍是 1440 时不会立刻出事，但一旦 `[vars]` 缺失/未注入就**静默 4× flush 烧钱**；反过来只改 `config.ts` 不改 toml 会让 drift guard 立刻红。**这就是为什么必须三处同改。**

### 10.3 #87 真钱渐进武装 + #89 终局集成验证

- **#87**：shadow-compare **Phase 0/1 已武装且不花真钱**（`04ef9a4` 修好了 `economyCfg()` 从未透传 `shadowCompare` 的接线缺口，Phase 1 证据窗口已 live；实测 crons 13 / decisions 832 / gateFlips 0 / evolved 与 baseline 金额完全相同）。后续 Phase 需按证据窗口逐步推进。
- **#89**：终局集成验证，**blockedBy #87**。

### 10.4 #125 `shadow_decisions` D1 表有界 GC / retention

`shadow_decisions` 是 **append-only 无界**表，实测增长 **~42.7k 行/天**。需要 GC 或 retention 策略，否则 D1 体积与查询延迟持续恶化。参考 `a6d5b61`（#113 pre-#87 hardening）里 N1 把 GC `sweepTo` 上界化的做法。

### 10.5 #134 `verify:poca` 假阳性修复

两处：

1. `criterion2` 应**排除末位 open epoch**（当前纪元的未封印状态被当成断链）；
2. `getLogs` 应**优先 `ALCHEMY_ARC_RPC_URL`** 以避免公共 RPC 限流导致的假失败。

相关文件：`scripts/poca-verify.mjs`、`packages/frontend/public/pocaVerify.js`（两者共享纯核心）。注意 `merkle-batch-receipts` 分支也改了这两个文件（+95 / +28），**先合 Merkle 还是先修 #134 需要排序**，否则会冲突。

### 10.6 #135 0-LLM 用神经元解数学问题（只读调研，**从未启动**）

纯调研任务：探索仅靠神经模拟（无 LLM）解数学问题的可行性。零生产风险，适合作为低优先级穿插任务。

### 10.7 WarCoffer.sol 注释订正（需用户批准，仅文档/注释）

`packages/trader-worker/contracts/WarCoffer.sol` **第 133 行**注释写 "never withdraw … except a house vault"，但实际**连 vault 提取都不存在**（单向沉没池，最大暴露 50 USDC 已 immutable 封顶）。属误导性注释，会误导审计者以为存在提取路径。**改动仅注释，但因在 contracts/ 目录内、且涉真钱合约，需用户批准后再动。**

### 10.8 前端可选加固（`7464b52` 事故的经验延伸，均为纯前端、零真钱风险）

1. `FETCH_TIMEOUT_MS` 3500 → **8000**（给后端慢 beat 更多余地，减少误判 offline）；
2. `OFFLINE_BACKOFF_MS` 20000 → **6000**（一旦真 offline，恢复更快）；
3. `poll` 的 catch 按 **`AbortError` 分流**：超时时**保留上一帧真实快照**，不翻 `state.offline`、不显示 "dreaming" 合成数据。

> 有了 §4.4 的 CORS always-on 之后，后端卡死现在会返回**带 ACAO 的 500 JSON**，前端能读到真实错误而不是 CORS 黑洞；这三条是让前端在"能读到 500"之后**表现得更诚实**。

### 10.9 本会话新发现，待判断（只读观察，未根因定位）

**12 个尘余额 agent 的 verify-fail 循环**：详见 §3.4 末尾的观察项。要点——不烧 gas（nonce 增速 ≪ 尝试增速），但吃 flush 预算、压低边际成功率到 6.8%、持续给这些 debtor 记 `settleFail` 与声誉污点。**需用户决定**是否给连续 verify-fail 的 net 加丢弃/过期路径。

### 10.10 已知非故障项（别去"修"）

- 本纪元 `kind=7` 的 `adminAction` 链上公告失败 1 次（最新一条 admin 记录无 `txHash`），按 `poca.ts` 设计不重试，**下次封印自愈**；epoch 完整性 / continuity / 承诺旋转均不受影响。
- `netPending` 比会话早期高（~3,200 vs ~2,700）是 **1440 应急闸的预期副作用**（dust 滞留 4× 更久），不是堆积故障。
- `app.js` 里的 `i18n.js?v=100` 是遗留单体备份的陈旧引用，`index.html` 不加载它，bump 脚本 `SKIP_FILES` 也跳过它。
- `mirrorDriftAtomicSum` 持续增长是 Fix B 的**累计量**语义，不是"漂移在恶化"；要看的是每次 resync 后的**后态 mirror == chain**。
- 部署后第一个 cron 的 settleFail 爆发（`pairBackoff` 内存态重置）是良性已知行为。

---

## 11. 交接注意事项

### 11.1 后台 agent 与残留文件

- **被用户取消的后台 agent 无法从 leader 侧强制终止**（`SendMessage` 的名字解析会命中同名旧会话），只能等其自然结束，或由用户在 IDE 侧关闭对应会话 / 结束进程。
- 因此工作区**可能残留其临时文件**。交接时应说明这一点，不要把它们误当成本会话产物。

### 11.2 工作区临时文件现状与清理建议（**本次交接未删除任何文件**；删除有风险且未被要求）

实测：仓库根 **503 个文件里 490 个是 `_` 前缀临时文件**（`_*.json` / `_*.log` / `_*.mjs` / `_*.ps1` / `_*.txt` 等历史探针与报告），外加 **24 个 `_` 前缀目录**（`_cdp_*` / `_*_prof` 为主的 Chrome profile 与量测目录，是体积大头）与 `design-mockups/`、`_head_wt/`、`.worktrees/merkle-batch/`；`git status --porcelain --ignored` 共 **543 行**，全部已被 `.gitignore` 覆盖、**不在版本控制内**。

按类别一句话处置：

- **可删**：`_cdp_*` / `_*_prof` / `_rv_root` / `_lg_probe` 等 profile 与量测目录；`_t118_*` / `_t122_*` / `_t124_*` / `_t130_*` / `_t141_*` 等按任务编号的 JSON/log/脚本证据；`_fv_*` / `_rr_*` / `_p1_*` / `_p2_*` / `_hana_*` / `_rec_*` / `_rsp_*` / `_rv_*` / `_run_*` / `_dep*` 等历史探针与日志；`_old_index.html` / `_parent_index.html` 等 HTML 快照；`packages/_wk_gate.log`、`packages/trader-worker/_dev_smoke.log`。
- **建议保留**：`design-mockups/`（UI 效果图与 IA-MAPPING）、`_connectome_data/`（FlyWire 原始数据，溯源）、`.foundry-bin/`（工具链）、`.worktrees/merkle-batch/`（§10.1 要用）、`_t141_bal.mjs`（余额/nonce 只读探针，下次算续航还要用；或搬进 `scripts/`）、`packages/trader-worker/.env.local` + `admin-token.key` + `.circle-key.local`（**本地密钥：永不提交、永不打印、永不进聊天**）、`.qoder/` / `.verify/` / `node_modules/`。
- **需先用 git 命令而非直接删目录**：`_head_wt/` 是遗留 worktree（detached @ `6492d85`），用 `git worktree remove _head_wt`（直接删目录会留下悬空 worktree 记录）。
- **绝不可删（唯一被 git 跟踪的 `_` 前缀文件）**：`packages/frontend/public/_headers`（缓存策略，见 §7.4）与 `scripts/_*.py` / `scripts/_*.ts`（FlyWire 数据溯源工具，11 个）。

操作顺序建议：先 `git status --porcelain --ignored` 导出清单，确认无未归档证据（近期任务如 `_t130_*` / `_t141_*` 建议先归档到仓库外），再分批删；**不要在后台 agent 仍在运行时删 profile 目录**（会破坏其浏览器会话）。

---

## 12. 本次交接的实测差异清单（与上游口径不一致处，以实测为准）

| # | 上游口径 | 实测值 | 处置 |
|---|----------|--------|------|
| 1 | 真钱零和恒定 **143,576,000** atomic | **143,544,000** atomic（143.544 USDC），两样本 276s 间隔**完全相同**；与 `meanBalanceUsdc` 1.43544×100 自洽 | 文档采用实测 **143,544,000**；差 32,000 atomic（0.032 USDC）。零和**不变量成立**，只是常数取值不同 |
| 2 | facilitator ~**134.37** USDC，续航 **~3 天** | **132.470701** USDC（block 23,525,533，nonce 301,439，10:35:22Z）；4.007h 窗口实测 **24.81 USDC/天 ⇒ 续航 5.34 天** | **~3 天是 pre-gate 数字**（42.20 USDC/天 ⇒ 3.24 天，测于 06:29-06:34Z）。应急闸武装后实测削减 **41.2%**。文档按 post-gate **≈5.3 天（约 2026-10-05 傍晚 UTC）**记，并标注需重采 ≥1h 窗口复核 |
| 3 | tickIndex ~**67,280**；chronicle seq ~**15,621** | tickIndex **67,995 → 68,062**；seq **15,872 → 15,888** | 系统正常前进，无矛盾；文档用最新值 |
| 4 | netPending 有界 **~2,697-2,737** | **3,216 → 3,253**（`netPendingTrades` 9,180 不变） | 仍**有界振荡**；抬升是 1440 闸门的预期副作用（dust 滞留 4× 更久），非故障 |
| 5 | 本纪元 kind7 公告失败 **1 次** | `/poca/admin` 最新 kind=7（ts `1790755203391`）**确无 `txHash`**，之前各条均有 ⇒ **成立**；但 `poca.mirror.failures` = **4**（跨纪元累计） | 两者不矛盾：4 是累计计数，本纪元确实只失败 1 次。文档已分别记清 |
| 6 | mirror == chain **98/100** | 公共 API **无 per-agent 链上字段**，无法整体复验；但对 12 个被拒 buyer 逐一比对，**Fix A 的 `have` 与 mirror 余额逐位相同** ⇒ 在这 12 个上直接验证成立 | 98/100 标注为**会话口径·未整体实测**；已验证的部分写清方法与结论 |
| 7 | 测试 **1186/1186**、tsc×3 绿、manifestHash `c0288c45…` | 出自 commit `7464b52` 的门禁记录；**本次 docs-only 未重跑** | 作为**基线**记录并注明未复跑；下次部署前必须重跑全量门 |
| 8 | Worker Version `9c5af85c-3466-4196-9568-33fecee1ede5` | `wrangler deployments list --json` 实测最新 deployment（07:59:10Z）的 `versions[0].version_id` **完全一致** | ✅ 确认 |
| 9 | CODE_COMMITMENT `066121bc…`、treeHash `e8a1e0ec`、artifactHash `dc84edfc`、files 144、knobs 29 | 仓库 `codeCommitment.ts` 与线上 `/poca` **双端逐字一致** | ✅ 确认 |
| 10 | epochCount 10 / currentEpoch 9 / era 143 "the Yoke of Houses" / continuity unbroken | 线上 `/poca`、`/annals` **全部一致** | ✅ 确认 |
| 11 | Gini ≈ **0.670**（真实链上） | **0.669588 → 0.669463** | ✅ 确认 |
| 12 | caps 未触（treasuryOut=0 / commonsPool=0） | 两样本均 **0 / 0** | ✅ 确认 |
| 13 | 前端 `main.js?v=162` / `styles.css?v=163`，线上字节复验命中 | 本地 `index.html:922/:11` 一致；线上 index.html **84,548 B** 与 styles.css?v=163 **359,187 B** 均与本地**等长** | ✅ 确认（并发现两者**版本号不同步**这一 bump 脚本陷阱，已记入 §3.2/§7.4） |
| 14 | netFlushTicks 两端值 | `wrangler.toml:136 = "1440"`、`config.ts:1102 = ?? "1440"` ⇒ **已同步**（`7464b52` 补齐） | ✅ 确认；回调步骤见 §10.2 |
| 15 | 前端部署预览 URL `9a1a0e43.murmur-4sx.pages.dev` | 未查 Pages deployment 列表 | 标注为**会话口径·未实测** |
| 16 | 链 Arc mainnet chainId **5042** | RPC 实测 `eth_chainId = 0x13b2` = **5042** | ✅ 确认 |
| 17 | 工作树状态 | `git status --short` **空** ⇒ 无本会话遗留的未提交改动，无需另行说明 | ✅ 干净 |
| 18 | Merkle 分支 `df2e386` | 存在，worktree 干净，**领先 merge-base 1 / 落后 fresh 4** | ✅ 确认，并补上了具体的 rebase 冲突面（`economy.ts` / `config.ts`） |

### 本会话产出的新临时文件（供后续清理参考）

`_t141_health.json`、`_t141_health2.json`、`_t141_poca.json`、`_t141_econ.json`、`_t141_econ2.json`、`_t141_annals.json`、`_t141_annals2.json`、`_t141_admin.json`、`_t141_pop.json`、`_t141_deployments.json`、`_t141_live_index.html`、`_t141_live_styles.css`、`_t141_bal.mjs`（余额/nonce 只读探针，**建议保留**）。全部在 `.gitignore` 覆盖范围内，**未被提交**。

---

*本文档由任务 #141 更新（docs-only，未改任何代码、未部署 worker/frontend、未触碰真钱 / `wrangler.toml` / `config.ts`）。*
