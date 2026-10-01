# 上游 Reasonix 同步状态报告

- 检查时间：2026-09-23
- 上游仓库：`https://github.com/esengine/DeepSeek-Reasonix`（公开，默认分支 `main-v2`）
- 本地基准：`352d171b3254c36cb36dd25532d0ef7e6f7d7f0a`（2026-08-16T01:37:36+08:00）
  —— 即 `src/generated/reasonix-constants.ts` 里记录的 `REASONIX_UPSTREAM_COMMIT`，也是 `reasonix-src/` 克隆的 HEAD
- 上游当前：`2a2dbbeaefe624d1764118d4aafb660fb7a53e0b`（2026-09-23T10:58:24Z，仓库 `pushed_at` 2026-09-23T12:32:39Z）

> **后续状态（已处理，2026-09-23）**：本文件是当次调研快照，下述问题均已落地修复——
> ① sync 脚本改为「必产快照 + 漂移报告」并自动发现上游新增文件（可 `--from` 离线）；
> ② `vendor/` 与 generated 常量已刷新到 `2a2dbbea`；
> ③ 端口按上游新设计对齐，并迁移到宿主 `0.1.6-alpha.2` 一代 API
> （`Session.eventAt`/`SessionSeq`、`surfaceOp.startSeq/endSeq`、`EpochHeader` 去掉 `system`），
> 旧的 ceiling / first-user pin / kept-user-turn / exceptional-savings 策略层已删除；
> ④ 版本升到 `0.2.0`（破坏性配置变更）并同步到本地 profile。
> 当前漂移为零，见自动生成的 [UPSTREAM_SYNC_REPORT.md](UPSTREAM_SYNC_REPORT.md)。

## 结论

**有更新，而且是大幅更新；但本插件的自动同步链路已经硬失效，现在跑 `sync:reasonix` 只会打印一条 warning 然后什么都不改。**

| 项目 | 结果 |
|---|---|
| 上游领先提交 | **2054 个**（`status=ahead, ahead_by=2054, behind_by=0`） |
| 13 个被跟踪文件 | **12 个已改动，1 个被上游删除** |
| `scripts/sync-reasonix-compact.mjs` 契约 | **15 个必需常量中 9 个已在上游彻底消失 → `IncompatibleUpstreamError`** |
| 插件本体（本地） | 源码已无法编译（DSH 宿主 API 漂移），运行的是 2026-08-28 的 `lib/` |

## 一、上游位移

本地基准到上游 HEAD 之间共有 **2054 个提交**。采集到 2026-08-15 以后的提交清单（API 上限 100 条）显示上游处于高频迭代状态，其中直接触及压缩链路的代表性提交：

| 日期 | 提交 |
|---|---|
| 2026-09-22 | `Fix /compact feedback and history detection` (#10642) |
| 2026-09-20 | `Fix compaction ownership, cancellation, and durable operation recovery` |
| 2026-09-19 | `feat(attachments): admit images at the session boundary` |
| 2026-09-16 | `Preserve compacted context across restart and migration` (#10430) |
| 2026-09-07 | `fix(agent): recover from summary-request overflow and rescue over-ceiling context` |
| 2026-09-02 | `fix(agent): checkpoint pinned revisions during compaction` |
| 2026-09-02 | `feat(cache): move dynamic indexes into session context` |
| 2026-08-31 | `feat(agent): /compact recovers over-length sessions via chunked-summary fallback` (#9632) |
| 2026-08-30 | `refactor(agent): isolate compaction prune policy` |
| 2026-08-27 | `fix(agent): let manual compaction escape the over-ceiling deadlock` |

分文件提交数（`since=2026-08-16`）：`compact.go` 13 个、`compact_projection.go` 13 个、`context_manager.go` 10 个、`compact_commit.go` 3 个。

## 二、vendored 快照已整体过期

`vendor/reasonix/compact/` 下 13 个受跟踪文件的行数对比（上游 / vendor）：

| 文件 | 上游 | vendor | 状态 |
|---|---:|---:|---|
| `internal/agent/compact.go` | 566 | 682 | CHANGED |
| `internal/agent/compact_fold_input.go` | 89 | 276 | CHANGED（大幅瘦身） |
| `internal/agent/compact_projection.go` | 742 | 609 | CHANGED（大幅增长） |
| `internal/agent/compact_commit.go` | 147 | 86 | CHANGED |
| `internal/agent/compact_user_turns.go` | — | 90 | **上游已删除（404）** |
| `internal/agent/context_manager.go` | 376 | 229 | CHANGED |
| `internal/agent/context_usage.go` | 58 | 55 | CHANGED |
| `internal/agent/context_report.go` | 88 | 88 | CHANGED |
| `internal/agent/context_receipt.go` | 178 | 160 | CHANGED |
| `internal/agent/context_recovery.go` | 122 | 112 | CHANGED |
| `internal/agent/context_status.go` | 146 | 124 | CHANGED |
| `docs/research/cache-aware-compaction-design.md` | 127 | 124 | CHANGED |
| `docs/SPEC.md` | 1235 | 1249 | CHANGED |

注意 `compact_user_turns.go` 在上游只剩测试文件 `compact_user_turns_test.go`——**Pinning / kept-user-turn 这一层策略在上游被拆掉了**。

另外，上游在压缩区新增了若干文件，但它们不在 `sync-reasonix-compact.mjs` 的 `compactFiles` 清单里，也就是说即使同步成功也不会被 vendor 进来：

`compact_active_turn.go`、`compact_safe_prefix.go`、`compact_slim.go`、`compact_summary_feedback.go`、`context_capsule.go`

## 三、同步脚本已硬失效（核心问题）

`scripts/sync-reasonix-compact.mjs` 的 `extractConstants()` 要求上游 `compact.go` 里存在 15 个具名常量、`summaryTagOpen` / `summaryTagClose`、以及摘要 prompt，缺任何一个就抛 `IncompatibleUpstreamError`，脚本走 `::warning::` 分支并**产零改动**。

直接调用脚本自身的 `extractConstants()`（导入真实源码，只摘掉 `main()`，未做任何重写）实测：

```
对 vendor 里的旧 compact.go：15/15 全部命中 → 0 missing（证明探针忠实）
对上游新 compact.go：       9/15 缺失   → IncompatibleUpstreamError: Could not find compatible Go constant checkpointCeilingRatio
```

已在上游**全仓库范围内彻底消失**（GitHub code search 逐个确认为空，非改名迁移）：

```
checkpointCeilingRatio        minRecentTailTokens        maxRecentTailTokens
exceptionalMinSavingsRatio    maxPinnedFirstUserTokens   pinnedFirstUserWindowFrac
maxKeptUserTurnTokens         keptUserTurnsBudgetTokens  keptUserTurnsWindowFrac
```

仍然存在但默认值被上游改掉的：

| 常量 | 上游新值 | vendor 旧值 |
|---|---|---|
| `defaultCompactRatio` | **0.80** | 0.85 |
| `recentTailBudgetRatio` | **0.16** | 0.10 |
| `summaryOutputMaxTokens` | **8192**（`16 * 1024` → `8192`） | 16384 |

未变：`minRecentKeep = 2`、`minCompactMessages = 2`、`protocolReserveTokens = 256`。

`summaryTagOpen` / `summaryTagClose` / `compactionInstruction`（prompt，1570 字符，首行 `Compact the preceding conversation prefix into a durable resume briefing.`）仍然存在。

> 补充：`LOCAL_POLICY` 里那 15 个本地策略值本来就被脚本设计为"上游改了也不跟"，所以**它们不是失效原因**；失效原因是上游把这些常量本身删掉了，脚本连"提取"这一步都过不去。

## 四、上游设计变了什么

设计文档 `docs/research/cache-aware-compaction-design.md` 的 diff 显示这是设计层面的重构，不是修 bug：

- 流水线从"一次 summary"变成 **prune 优先 + 至多两次 checkpoint summary**：`达到阈值：先持久 prune；不足时至多两次 summary，逐次 CAS 安装 checkpoint`
- 最近原文尾巴：`recent tail` → **`recent 16% tail`**（对应 `recentTailBudgetRatio` 0.10 → 0.16）
- overflow 路径明确化为：**至多一次 prune、一次 summary、一次原请求重试**
- 工具结果改为**兼容性双字段存储**：provider 可见 `Content` 固定 ≤32KB，完整原文进本地 `RawContent`；普通 sampling / stream retry / summary / projection replay 始终用同一份有界 `Content`，避免旧前缀因完整结果大小而改变
- 模型要看全文时，改走稳定的 `use_capability` 代理显式调 `session:tool_result`，按 UTF-8 字节 offset 分页读 16–24KiB
- **manual `/compact` 不再自动 prune**
- 新增旧版 `promoted-RawContent` sidecar 的反向归一化（仅在哈希精确匹配时），保证新旧版本读同一 session 不损坏数据

一句话：上游把原来"ceiling + pinned-first-user + kept-user-turn + exceptional-savings"这套几何策略层**删掉**，换成了 prune-first + 双 checkpoint + 单一 16% 尾巴 + 分页回读。

## 五、附带发现（与上游无关，但会挡住"更新插件"这件事）

1. **插件源码已编译不过**。`tsc -p tsconfig.json` 报错：
   - `src/selection.ts(82,25): Property 'events' does not exist on type 'Session'`
   - `src/engine.ts(884~894): 'number' is not assignable to 'SessionSeq'`；`'start' does not exist in type '{ op: "replace"; startSeq; endSeq }'`
   原因是宿主 API 漂移：`node_modules` 里 `@deepseek-ai/dsh-{session,agent,compaction}` 实际是 **0.1.6-alpha.2**，而 `package.json` 的 peerDeps 还声明 `^0.1.0-rc.6`（devDeps 是 `0.1.1-rc.2`）。
2. `tsconfig.json` 设了 `noEmitOnError: true`，所以 `lib/` 一动不动停在 **2026-08-28 13:23**。插件在 profile 里是 `[active] compaction-cacheaware`，即**当前跑的是 8-28 的旧产物**，`src/` 已与产物脱节。
3. `tests/selection.test.mjs` 在本会话**无法验证**（不是真实失败）：`node --test` 以 piped stdio 派生进程，被沙箱拦成 `spawn EPERM`。这是沙箱边界，不代表测试坏了。
4. 工作区有两处**我先到时就存在**的未提交改动（各 1 行，时间戳 2026-08-28，非本次产生）：`src/engine.ts` 与 `lib/engine.js` 放宽了摘要失败信息的正则，加了 `no summarization candidates available|no provider/model available`。
5. `README.md` 版本信息过期：文档写"npm 最新已发布 0.1.10"，实际 npm registry 上 latest = **0.1.11**（`gitHead a68ec4b`，与本地 HEAD 一致）；`package.json` 也是 0.1.11。

## 六、建议的下一步（三选一或组合）

1. **最小动作**：让 `sync-reasonix-compact.mjs` 从"契约不符就静默产零改动"升级为**生成差异报告**（列出上游新增/删除的文件、消失的常量、变了的默认值），并把 vendor 快照刷新到 `2a2dbbea`，同时把 `compact_active_turn.go`、`compact_safe_prefix.go`、`compact_slim.go`、`compact_summary_feedback.go`、`context_capsule.go` 纳入跟踪清单。
2. **设计移植**：按新设计（prune-first + 双 checkpoint + 16% tail + ratio 0.80 + 工具结果分页回读）改 TS 端口——这属于设计评审级改动，不是一个 sync 能带过去的。
3. **修宿主漂移**：把 `Session.events` / `SessionSeq` 的用法对齐当前宿主（0.1.6-alpha.2），让插件重新可编译、可发布，否则后面任何改动都落不到 `lib/`。

## 附：证据与复现

- 抓取的上游快照（13 个受跟踪文件 + 5 个新文件）：`.scratch/upstream/`
- 契约探针（导入真实 `extractConstants`）：`.scratch/probe-contract.mjs`、`.scratch/probe-enumerate.mjs`
- 逐文件哈希/行数对比：`.scratch/cmp.mjs`
- 上游比对原始数据：`.scratch/compare.json`、`.scratch/commits.json`、`.scratch/hist_*.json`

复现要点：本机 git/curl 走 schannel，在沙箱内 TLS 握手失败（`SEC_E_NO_CREDENTIALS`），因此**不能用 `git fetch` 拉上游**；上面所有上游数据都由 `gh api`（Go 自带 TLS 栈）取得。`gh auth status` 正常。
