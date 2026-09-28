# HANDOVER — murmur 项目交接文档

> 最后更新：2026-09-29  
> 最新 commit：`ff2450a`（UI 全档自适应 + PoCA 批次）  
> 生产 Worker version：`4a8ad944`

---

## 1. 项目概览

**murmur**（原 Immortal Fruit Flies）是一个运行在 Arc mainnet 上的自主果蝇文明模拟。每只果蝇拥有独立的神经网络（基于真实果蝇连接组）、基因组和生命周期。系统通过 x402 微支付协议实现真钱经济结算。

### 核心架构

| 层级 | 职责 |
|------|------|
| Cloudflare Worker | 主运行时，cron 驱动 tick，x402 支付结算 |
| Durable Objects (66 shards) | 果蝇状态存储与计算分片 |
| KV (FLYWIRE_ARTIFACT) | FlyWire 连接组子图 artifact 缓存 |
| Arc Mainnet | manifestHash 链上 commit，MURMUR ERC-20 代币 |
| 前端 (Cloudflare Pages) | Three.js 3D 主画布 + 抽屉式 UI |
| packages/fly-brain | 果蝇神经模拟器（基因组→连接组→神经活动） |

### 技术栈

- **Runtime**: Cloudflare Workers (ESM), Durable Objects, KV
- **Frontend**: Vanilla JS + Three.js, Cloudflare Pages
- **Neural sim**: TypeScript, FlyWire FAFB_783 连接组数据
- **Blockchain**: Arc mainnet, x402 (Circle), USDC 结算
- **CI**: GitHub Actions — verify (node 四门) + contracts (forge)
- **Chain tools**: Foundry (anvil/cast/forge)

---

## 2. 当前生产状态

| 指标 | 值 |
|------|-----|
| manifestHash | `100712db…ef9c` (FlyWire 模式) |
| commitCount | 3 (链上 append-log) |
| aliveCount | 68/100 |
| volumeUsdc | $209.99+ |
| settle 成功率 | 96.0% (93,167 笔) |
| tick cadence | ~37s/tick (60s cadence, margin 23s) |
| FLYWIRE_TOPOLOGY | `"true"` |
| NEUROMOD_GATING | `"true"` |
| ECONOMY_SHADOW | `"false"` (真钱) |
| KV namespace | FLYWIRE_ARTIFACT (id=`fc21e2dae15b45d09f786bb50250c5c3`) |

### 前端版本号

| 文件 | 版本 |
|------|------|
| main.js | ?v=142 |
| styles.css | ?v=112 |
| i18n.js | ?v=99 |
| i18n-ui.js | ?v=92 |

---

## 3. 本次会话完成的工作

### 3.1 土地像素系统覆盖修复 + NSFW 审查 (commit `3b3e8a1`)

- **根因**：`GET /land-img/<id>` 的 `Cache-Control: max-age=86400` 且 URL 覆盖后不变 → 24h CDN 缓存返回旧图
- **修复**：`state.ts` 的 `getLand`/`postLand` 中 imageUrl 追加 `?v=<overrides>` 产生新缓存键
- **NSFW 存量审查**：76 已认领地块，nsfwjs + tfjs(CPU) 扫描，0 命中（最高 0.055 << 0.5 阈值）
- **清理**：临时 `POST /land-moderate` 端点已移除，`LAND_MODERATE_KEY` secret 已从 config.ts 清除

### 3.2 FlyWire 真实果蝇连接组集成（多 commit）

#### A3 神经调质门控 (commit `f1e88d2`)

- 新文件：`packages/fly-brain/src/neuromod.ts` + `neuromod.test.ts`
- 从 modulatory 层派生 DA/OA 标量（refHz=40, clamp01, NaN 安全）
- `NEUROMOD_GATING` 默认 false（暗部署），manifest-neutral
- 发现：随机拓扑下 modulatory 恒 ~0Hz（inert），真实 FlyWire 布线下 DA 2.07Hz 恢复

#### A2 离线 FlyWire 子图管线 (commit `f1e88d2`)

- 新目录：`packages/fly-brain/src/connectome-data/`
  - `index.ts`, `types.ts`, `decoder.ts`, `generator.ts`
  - `fafb783.test.ts`, `fafb783-mb-cx-meta.json`, `fafb783-mb-cx.bin.gz.b64`
- FAFB_783 子图：10,361 神经元 / 467,314 突触 / fan-in 45.1 / 93.3% 兴奋 6.7% 抑制
- 数据源：FlyWire (Princeton/Murthy Lab), CC-BY 4.0, Eckstein et al. 2024 递质符号化
- 生成器：`buildFromFlyWire(subgraph, {seed})` → Connectome，确定性
- Artifact: `fafb783-mb-cx.bin.gz.b64` (1.32MB)

#### 第 3 步实现 (commit `dd8b3a8`)

- `FLYWIRE_TOPOLOGY` flag（默认 false）
- `flywire-loader.ts`：Workers 兼容 KV + DecompressionStream 子图加载器
- `genome.ts`：`FLYWIRE_DEFAULTS{weightGain:0.22, weightJitter:0.30}`, `FLYWIRE_GENOME_BOUNDS`
- `manifest.ts`：`assembleManifestFlyWire`，新 manifestHash `0xe97a2e16`（后因实现差异实际为 `0x100712db`）
- 重标定：weightGain 1.0→0.22, weightJitter 0.15→0.30, `REF_BANDS_FLYWIRE`

#### 全量上线 (commit `534118e`)

- `FLYWIRE_TOPOLOGY="true"` + `NEUROMOD_GATING="true"` + `ECONOMY_SHADOW="false"`（真钱）
- KV namespace: `FLYWIRE_ARTIFACT` (id=`fc21e2dae15b45d09f786bb50250c5c3`)
- 链上 commit: tx `0xcd974e73`, manifestHash `100712db…ef9c`, commitCount 3, Arc mainnet 5042
- Worker version: `4a8ad944`
- Evicted vars: `FRONTEND_ORIGIN`, `CIRCLE_FACILITATOR_URL`（为 KV binding 腾位）

#### 性能事故与修复

- **问题**：首次部署冻结 cron 40 分钟（66 shard 各自 KV 解码 1.32MB artifact + 55s AbortSignal 超时 → cronRunning 永久卡死）
- **回滚**：执行两次部署（第二次才驱逐卡死 DO）
- **修复**（commit `534118e` 内）：
  - `flywire-loader.ts`: `loadSubgraphCached()` DO-storage 2-chunk 缓存（冷启 24s→1-3s）
  - `index.ts`: `AbortSignal.timeout` 55s→90s
  - `state.ts`: `CRON_WEDGE_MS` 900s→180s + cron START 时 arm alarm
- **稳态**：~37s/tick（60s cadence），margin 23s
- **注意**：population 增长到 100 满载时 margin 会更紧，需监控

### 3.3 UI 重构 — 方向 A Command Rail (commit `6492d85`)

- **策略**：增量 chrome 覆盖层（保留全部现有 panel/drawer ID 和渲染逻辑零改动）
- **新增**：左缘 60px 图标 rail（8 按钮）+ 可折叠紧凑卡 + 图层 popover + 统一抽屉外观
- **变更**：5 文件 +316/-5：`index.html`, `styles.css`, `main.js`, `i18n-ui.js`, `i18n.js`
- **缓存键**：`styles.css?v=112`, `main.js?v=142`
- **i18n**：7 语（rail.* 键）
- **响应式**：三断点 — 桌面(>1024) / 平板(681-1024) / 手机(≤680)
- **安全**：3D 主画布零改动，`drawers.js` / `polling.js` 数据层零改动（零真钱风险）
- **设计参考**：`design-mockups/v2/direction-a.html` + `IA-MAPPING.md`

### 3.4 已取消/搁置的工作

- **Kim 全尺寸响应式优化**：用户取消，改动保存在 `git stash` (stash@{0}: kim-responsive)
  - 涉及：`styles.css` (+1587/-324), `index.html` (v=111), `landLayer.js`
  - 内含 2 个真缺陷修复（≤480px 抽屉左移 10px、`.epitaph` 与 HUD 重叠）
  - 如需恢复：`git stash pop` 后手动合并到 Direction A 的新 styles.css

---

## 4. 关键技术决策

| # | 决策 | 理由 |
|---|------|------|
| 1 | FlyWire 缓存策略：缓存共享 subgraph（2.26MB, 2-chunk）而非 per-fly connectome | per-fly connectome 3.74MB > 2MB 单值墙；buildFromFlyWire 仅 116ms，重跑远比缓存便宜且无需 genome 失效逻辑 |
| 2 | UI 重构策略：增量覆盖而非重写 | 对含真钱的 3892 行 drawers.js 零改动，通过 CSS 覆盖层 + rail 事件委派实现视觉重构 |
| 3 | 链上 commit 顺序：commit-first 再翻 flag | isCommitted 是 append-log 成员资格判定，先 commit 不会让旧 hash 变红 |
| 4 | 128 文本绑定墙 | wrangler.toml [vars] 已耗尽，新增 var 需 evict 低优先级候选；R2/KV binding 不占文本墙位 |

---

## 5. 仓库结构与关键文件

```
packages/
├── fly-brain/src/          # 神经模拟器
│   ├── connectome-data/    # FlyWire 子图数据+生成器
│   ├── neuromod.ts         # DA/OA 神经调质门控
│   ├── genome.ts           # 基因组→连接组映射
│   └── manifest.ts         # manifestHash 计算
├── worker/src/             # Cloudflare Worker 主运行时
│   ├── index.ts            # 入口，cron handler
│   ├── state.ts            # DO 状态管理，land 系统
│   └── flywire-loader.ts   # KV 子图加载器
└── frontend/               # Cloudflare Pages 前端
    ├── index.html
    ├── styles.css
    ├── main.js             # Three.js 3D 画布 + UI 逻辑
    ├── drawers.js          # 抽屉面板（含真钱操作，谨慎修改）
    ├── polling.js          # 数据轮询层
    ├── i18n.js             # 7 语字典
    └── i18n-ui.js          # UI 组件 i18n
```

---

## 6. 部署与运维

### 部署命令

```bash
# Worker 部署
cd packages/worker && npx wrangler deploy

# 前端部署
cd packages/frontend && npx wrangler pages deploy . --project-name=murmur
```

### 监控要点

- **tick 耗时**：当前 ~37s/tick，margin 23s。population 100 满载时会压缩
- **DO 冻结**：`CRON_WEDGE_MS=180s` watchdog 自动 arm alarm 恢复
- **KV 冷启**：首次 DO 创建需从 KV 加载 artifact (~1-3s with cache)
- **settle 成功率**：当前 96.0%，低于 90% 需排查

### 链上操作

```bash
# 查看 commitCount
cast call <MANIFEST_REGISTRY> "commitCount()(uint256)" --rpc-url $ARC_RPC

# 提交新 manifestHash
cast send <MANIFEST_REGISTRY> "commit(bytes32)" <HASH> --private-key $PK --rpc-url $ARC_RPC
```

---

## 7. 工作区临时文件（建议清理）

仓库根有大量历史 agent 留下的临时文件：

| 模式 | 说明 | 建议 |
|------|------|------|
| `_cdp_*`, `_rail_prof/`, `_resp_prof/`, `_rsp_prof*/`, `_rv_prof/`, `_shot_prof*/`, `_t52_prof/`, `_verify_lb_prof/`, `_chrome_prof_terr/` | Chrome profile 目录 | 可删 |
| `_rsp_*`, `_rv_*`, `_run_*`, `_tail_*`, `_test_*`, `_dep_*`, `_n0*`, `_t[2-4].log` | 日志/临时脚本 | 可删 |
| `_mresp.mjs`, `_rail_probe.mjs`, `_t53_cdp.mjs`, `_verify_lb.mjs`, `_worker_dev.log` | 临时工具 | 可删 |
| `family_tree_*.png` | 历史截图 | 可删 |
| `design-mockups/` | UI 效果图参考 | **保留** |
| `_head_wt/` | worktree 残留 | 可删 |
| `_connectome_data/` | FlyWire 原始数据（feather 格式） | **保留**（溯源） |
| `.foundry-bin/` | Foundry 工具链 | **保留** |

---

## 8. Git 拓扑

- **远端**：仅 `new-origin` → `EvolutionDeep/murmur`（旧仓已断开）
- **分支**：`fresh` = `main` = HEAD（三方对齐）
- **stash**：`stash@{0}: kim-responsive`（已取消的响应式优化）

---

## 9. 下一步可能方向

1. **population 满载监控**：aliveCount 接近 100 时 tick margin 压缩，可能需要优化
2. **Kim stash 中的缺陷修复**：≤480px 抽屉偏移 + epitaph 重叠，值得 cherry-pick
3. **UI 持续迭代**：Direction A rail 已上线，可进一步细化交互动画
4. **FlyWire 数据扩展**：当前仅 MB+CX 子图，全脑 139,255 神经元可选扩展
5. **经济系统**：信贷复合体链上集成（当前为读出膜/因果膜分界）

---

## 10. Sprint — PoCA 批次 (2026-09-28 → 2026-09-29)

### 10.1 UI 全档自适应部署 (commit `ff2450a`)

- Direction A Command Rail 全面上线：桌面/平板/手机三断点响应式
- 缓存键 `styles.css?v=112`, `main.js?v=142`
- 3D 主画布、drawers.js、polling.js 零改动（零真钱风险）

### 10.2 波 1 安全整改

- **SECURITY.md** 新增 §“Disclosed Centralization & Trust Assumptions”，五条披露：
  1. PredictionArena resolver 为 exitTempR6 可信预言机
  2. WarCoffer 单向沉没池 ~50 USDC
  3. war-rail 绕过 ECONOMY 日限但受链上 EscrowCap(50) 硬顶
  4. 治理投票即时余额加权（可买-投-卖）
  5. ADMIN_TOKEN fail-open 语义
- 每条包含 Mitigation / Discoverability / Why accepted 三段
- `deploy-manifest-auto.mjs` 新增 `MANIFEST_HASH_BYPASS_APPROVED=1` 硬门

### 10.3 PoCA 实现状态

| 组件 | 状态 | 说明 |
|------|------|------|
| `poca.ts` (off-chain engine) | ✅ 完成 | 788 行，PocoEngine + digest chain + Merkle + epoch lifecycle |
| `poca.test.ts` | ✅ 完成 | 26 tests，in-memory store + stub hooks |
| `codeCommitment.ts` | ✅ 生成 | `CODE_COMMITMENT = 2bd01a41…`，git `ff2450a` |
| `gen-codecommit.mjs` | ✅ 完成 | 162 行，deploy 前自动跑 |
| `ContinuityRegistry.sol` | ✅ 完成 | 181 行，openEpoch/sealEpoch/adminAction/isUnbroken |
| `state.ts` 接线 | ✅ 完成 | cron entry/exit hooks + 5 routes |
| `openapi.ts` schemas | ✅ 完成 | PocaSealedEpoch/Epoch/Proof/MerkleStep/AdminEntry |
| `/poca*` endpoints | ✅ 完成 | 5 endpoints，免费无钥 CORS |
| `docs/POCA.md` | ✅ 完成 | 完整规范 (553 行) |
| **ContinuityRegistry 部署** | ⏳ 待做 | 需 `npm run deploy:registry`（同 NeuralReceiptRegistry 流程） |
| **合约地址回填** | ⏳ 待做 | 部署后回填 `docs/POCA.md` + `wrangler.toml` POCA_REGISTRY_ADDRESS |
| **首纪元锚定** | ⏳ 待做 | 部署后第一次 cron 自动 openEpoch + 第一次 seal |
| **前端 PoCA 抽屉** | ⏳ 待做 | 显示 continuity verdict + epoch list + admin log |
| **`scripts/poca-verify.mjs`** | ⏳ 待做 | CLI 验证器（--selftest / --registry / --sample / --json） |

### 10.4 待办优先级

1. **部署 ContinuityRegistry** — 用现有 `deploy-registry-auto.mjs` 流程，committer = facilitator `0x2b9a…055c`
2. **地址回填** — `docs/POCA.md` TODO 标记处 + `wrangler.toml` 新增 `POCA_REGISTRY_ADDRESS`
3. **翻开关** — 设置 `POCA_REGISTRY_ADDRESS` 后 redeploy Worker，引擎自动从 disabled → enabled
4. **前端抽屉** — 读 `GET /poca` + `GET /poca/epochs` 显示纪元链
5. **CLI 验证器** — 实现 `poca-verify.mjs` 四模式
6. **ERC-8004 注册** — Arc mainnet singleton `0x8004Cc8439f36fd5F9F049D9fF86523Df6dAAB58`
