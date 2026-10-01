# DSH Desktop 0.2.0-rc.2：安装与迁移

> **状态声明（先读）**：本轮源码迁移**已实现，并通过本地验证**（类型 / 构建 / 24 个 fixture 测试，
> 见 §10）。但**没有把本插件安装到 DSH Desktop**（Desktop 应用本机已安装），也没有连接真实模型
> 做端到端验收：§11 的 10 项桌面验收全部是 `未执行`，**不要读成通过**。
> 本文只描述 Desktop `0.2.0-rc.2` 一代宿主上的安装方式与本轮迁移，不重写任何历史文档
> （`MIGRATION_0.1.11_TO_0.2.0.md`、`PROJECT.md`、`MAINTENANCE.md`、`MIGRATION_BRIEF.md`、
> `UPSTREAM_SYNC_STATUS.md` 与 `vendor/` 全部保留原样）。

## 1. 版本现状

| 项 | 值 | 说明 |
|---|---|---|
| 本轮源码目标宿主 | DSH `0.2.0-rc.2` 一代 | `package.json` 的 `peerDependencies` 与 `devDependencies` 均已指向 `0.2.0-rc.2`；本机 `node_modules` 里实际安装的 `@deepseek-ai/dsh-{session,compaction,agent,llm,token-meter,commands}` 也都是 `0.2.0-rc.2` |
| 插件本地版本 | `0.2.0`（源码），**尚未作为迁移产物发布** | 本文**未查询 registry** 的最新 tag，因此不对其他发布状态作断言 |
| 历史文档记录的已发布版本 | `0.1.11` | **只是历史记录**（来自 `PROJECT.md` 等历史文档，本次未查询 registry）：它的 peer 范围是 `^0.1.6-alpha.2`，几何策略也是旧的（checkpoint ceiling、recent-tail min/max、exceptional savings、first-user pin 都还在） |
| 历史迁移文档 | [MIGRATION_0.1.11_TO_0.2.0.md](MIGRATION_0.1.11_TO_0.2.0.md) | 记录 `0.1.11 → 0.2.0` 的配置键删除；其中「面向 DSH `0.1.6-alpha.2` 一代」是**当时**的记录，不是 Desktop 目标 |
| 本轮迁移状态 | 源码迁移**已实现 + 本地验证通过**（见 §10） | **未发布、未安装到 Desktop**；桌面侧验收见 §11 |

两个直接后果：

1. **本轮没有发布迁移产物，Desktop 侧要用本地产物验收。** 本文**不断言其他发布状态**：
   可依据的事实是本地源码版本 `0.2.0` 尚未作为迁移产物发布，而历史文档记录的已发布版本
   （`0.1.11`）peer 范围与 `0.2.0-rc.2` 不匹配——安装/启动会要求用户**显式确认精确版本豁免**，
   且其 geometry 是旧的。发布前的做法见 §3.3。
2. **装包不等于换引擎。** 详见 §4。

## 2. 两套依赖锚点：Desktop 自己的，与全局 CLI / web

- **Desktop 有自己的锚点。** Desktop 的已解析应用 profile 会为运行时包解析指定**自己的安装锚点**，
  同时沿用 Harness home 的 patch、代理环境、遥测开关、patch 热重载与有界关闭
  （`@deepseek-ai/dsh/profile-boot` 向 Desktop Host 提供共享 profile 生命周期）。
- **全局 CLI 与 web profile 各有自己的锚点。** `~/.dsh/profiles/web` 之类的 profile 目录是独立安装，
  本工作区 README 已经记录过：那里的 `node_modules/dsh-compaction-cacheaware` 是一份**真实目录副本**，
  不是 `file:` 链接，重建本仓库或只改 web profile **都不会**影响 Desktop。
- **结论**：给 Desktop 用的包必须落在 Desktop 的锚点里；版本匹配也按 Desktop 运行时
  （`0.2.0-rc.2`）判定，而不是按全局 CLI 的 `dsh --version`。

## 3. 安装：走桌面插件管理

### 3.1 推荐路径

通过 **Desktop 的插件管理**安装（Desktop 的内置命令运行时用该安装的运行时管理**已初始化**的
Desktop profile）。插件管理会把包写进 Desktop profile 的依赖（`dependencies`）与组合包列表
（`dsh.profile.bundles`），也就是 §4 的「步骤 1」。

### 3.2 不要用 `dsh plugin --profile desktop`

- `desktop` 这个 profile 名**保留给 Electron 持有的 profile**：CLI 会拒绝针对它的启动与配置 dump 请求，
  npm CLI 也会拒绝它的插件管理请求。
- 所以 `dsh plugin --profile desktop add dsh-compaction-cacheaware` **不会生效**（会被拒绝），
  Desktop 侧的插件管理才是通道。
- CLI 侧 `desktop` 这个**名字**仍然保留（不会释放给别的用途），只是 CLI 不能 launch / manage 它。

### 3.3 发布前的本地替代（注意依赖锚点）

Desktop 侧要用本地产物时，优先让**宿主依赖锚点保持唯一**：

- **推荐（可用于生产验收）**：`npm pack` 打出 tarball，再通过 Desktop 的插件管理安装。
  这样 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 由 Desktop 自己的锚点解析，与运行时是同一份。
- **不推荐把这个开发目录直接 `file://` 挂给 Desktop**：本仓库工作目录带着本地完整的 dev
  `node_modules`，从该路径加载时，宿主类 / cordis 依赖会按 Node 解析规则从**该目录**解析，
  可能与 Desktop 运行时的实例不是同一份（peer 不一致 / 双实例风险）。它只适合临时、可回退的
  调试，不能当作无风险的验收方式。
- 静态配置路径（本文件描述的路径）按 **Desktop 的提示**做重载 / 重启：运行中的进程持有旧模块实例。
  若该 Desktop 版本的热重载**明确覆盖**这些 target，则以**实测**结果为准。

## 4. 两步走：包安装 ≠ preset 内部替换

| 步骤 | 做什么 | 谁做 |
|---|---|---|
| 步骤 1 | 包进入 Desktop 的依赖锚点（`dependencies` / `node_modules`），按需列入 `dsh.profile.bundles` 以启用包自带的 bundle patch | Desktop 插件管理 |
| 步骤 2 | **agent preset 的 compaction realm** 里那一行引擎仍然指向 `@deepseek-ai/dsh-compaction-basic`，必须在该 realm 内换成 `dsh-compaction-cacheaware` | 每个 preset 各自（本包不代做） |

关键事实：

- 包自带的顶层 bundle patch（[`cordis.patch.yml`](../cordis.patch.yml)：`compaction-basic: disabled`
  + insert `compaction-cacheaware`）**只作用于 profile 层**。它按行 id 覆盖 profile 组合，
  **到不了 agent preset 的 isolated compaction realm**；反过来也一样。
- 因此：装好包 + 加进 bundles **不等于**引擎换掉了；只改 profile 层也**不等于** preset 换了。

### 4.1 standard / ptc / cordis：各自 isolated

（`standard` / `ptc` / `cordis` 已确认**各自持有独立的 compaction realm**，三者都必须在
**各自的 realm 里分别替换**，一次替换不会传播到另一个；`minimal` 的情况未确认，见 §4.2）。

每个 realm 里要**保留**：

- `@deepseek-ai/dsh-command-compact` —— `/compact` 与后端无关，它调用当前 realm 里拥有
  `ctx.compaction` 的那个后端，所以换引擎后 `/compact` 仍然走本插件；
- `@deepseek-ai/dsh-compaction-tool-result-pruner`（可选）—— 本插件通过 `ctx.get('toolResultPruner')`
  读取它，在摘要尝试前调用；未挂载时本插件不自行 prune。

即：**只替换「官方引擎」这一行**，不要顺手改动同 realm 的其它行。

> 行 id 以该 preset 实际组合树里的值为准（见 §4.2 的 dump 说明）；不要凭猜测新写一个 id。

### 4.2 minimal：先看组合树，不要盲目加一行

`minimal` 的 compaction 组合**未确认**：它可能没有独立的 compaction realm，也可能没有官方引擎行，
或用了不同的行 id / 嵌套结构。

**先 dump 组合树再决定。** 注意 CLI 不能用于 desktop profile
（`dsh --profile desktop --dump-config` 会被拒绝，因为该名字保留给 Electron），
要在 Desktop 侧用它自己的配置检查 / 插件管理能力导出组合树（具体入口以该版本 Desktop 界面为准；
本次未在真机操作）。

- 若 `minimal` 里有官方引擎行 → 按 §5 做「替换」。
- 若 `minimal` 里**没有**引擎行 → §5 的片段不适用：那是「新增一个引擎」，不是「换掉官方引擎」。
  需要先判断该 preset 是否真的需要压缩后端、配套的 `command-compact` / pruner 行是否存在，
  不要盲目加一个。

## 5. 要写进 preset 的片段

> ⚠️ **下面不是完整的顶层 patch，也不是一条可直接追加的新行。**
> 它是「preset 里**已经存在**的那个 compaction 引擎行内部」的**局部片段**。
> 只有该行存在时（§4.2 已确认）才适用。

### 5.1 局部片段：现有 compaction 行的 `config:` 内部

```yaml
# 位置：preset 中已有的 compaction 引擎行（id 以该 preset 实际行 id 为准）的 config: 下面。
# 片段 = 该行 config 的键值对；不要整段贴到 profile/preset 的 cordis.patch.yml 顶层。
compactRatio: 0.8
recentTailRatio: 0.16
summaryMaxTokens: 8192
minRecentKeep: 2
minCompactMessages: 2
protocolReserveTokens: 256
```

同一行还要把 `name` 从 `@deepseek-ai/dsh-compaction-basic` 换成 `dsh-compaction-cacheaware`
（发布前可用 `file:///.../lib/index.js`，但注意 §3.3 的依赖锚点限制）。这些键是**本插件的** schema
（完整表见 [插件 README](../README.md#configuration)）。

官方后端是另一套键名，**不要混用**：官方用 `thresholdRatio` / `retainRatio` / `retainTokens` /
`headroomTokens` / `maxTokens` / `compactionRetries` / `maxOverflowRetries` / `modelPolicies`，
本插件用 `compactRatio` / `recentTailRatio` / `summaryMaxTokens` / `protocolReserveTokens` /
`minRecentKeep` / `minCompactMessages`。

### 5.2 整行示意（仍然只是「那一行」）

```yaml
# 仅示意：展示「引擎行整行长什么样」。这依然不是一份完整 patch 文档——
# 不要用它覆盖 preset 的其它行（见 §6）。
- id: compaction-basic          # 保留 preset 里已有的引擎行 id（示例假定为 compaction-basic）
  name: 'dsh-compaction-cacheaware'
  config:
    compactRatio: 0.8
    recentTailRatio: 0.16
    summaryMaxTokens: 8192
    minRecentKeep: 2
    minCompactMessages: 2
    protocolReserveTokens: 256
```

不要把本片段**追加**成第二个引擎行：同一 realm 里再挂一个 `ctx.compaction` 注册者，会让本插件在
挂载时告警并（或）让先前的自动监听器 stand down —— 「替换」的语义是同一 realm 内的替换，不是并列。

如果该 preset 把这些行写在**嵌套的 config 数组**下（而不是顶层列表），请**整体编辑那一层数组**：
保留同级其它行，只改引擎行；不要另外新增一个顶层条目。

## 6. 为什么不能整体替换、也不能只写一半

- **宿主 patch 语义是「替换整块 config」，不是合并。** 组合包的 `cordis.patch.yml` 头注释与
  `@deepseek-ai/dsh-base` README 都明确：patch 会替换目标行的**整个 `config`**，后续层与用户的
  profile patch 按 id 覆盖行、**每行最后一次写入生效**。所以一个只写 3 个键的覆盖会把该行其它键
  整块丢掉。
- **不完整的 preset 覆盖会导致工具丢失。** preset realm 里的其它行（`command-compact`、
  `tool-result-pruner`、`token-meter` 等）如果不在替换后的文件里就**不会挂载**：命令和工具会直接消失。
  不要复制粘贴半份 preset 去整体覆盖。
- **保守做法**：一次只动「引擎行」，并把这行要保留的键写全（§5.1）；其它行一个字符都不改。

## 7. 隔离 realm 与 runtime injector 的边界

- **顶层 bundle patch 不会自动禁用隔离后端。** 包自带的 [`cordis.patch.yml`](../cordis.patch.yml)
  只在 profile 层把 `compaction-basic` 置为 `disabled`；preset 的 isolated compaction realm 里
  若还挂着 `compaction-basic`，**它禁不掉**。每个 preset 必须单独迁移（与工作区 README 里
  「profile 层 bundle patch 禁用不到 preset realm」的记录一致）。
- **本次未验证注入器的目标与 realm 覆盖。** Web 会话里的超级注入器（`dev_inject_plugin`
  一类运行时注入）注入的是它所在的 loader 实例 / 进程；**不得把当前 Web 注入视作 Desktop 的安装**，
  也不得假定它覆盖 preset 的 isolated realm。若某个注入器版本明确支持 Desktop 目标，
  需要**另行验证**其目标解析与 realm 覆盖范围。Desktop 与 preset realm 的变更路径是 §3 / §4。
- **realm 自检**：同一 realm 里若已有别的引擎持有 `ctx.compaction`，本插件挂载时会告警；若之后又被
  别的引擎取代，它的自动监听器会 stand down（warn-once，热重载感知）。替换后的期望状态是
  「该 realm 只有一个 `ctx.compaction` 所有者，且没有 supersede 告警」。

## 8. 宿主 API 变化（0.2.0-rc.2）与迁移动作

### 8.1 消息 API

`0.2.0-rc.2` 一代的消息词汇与 `0.1.6-alpha.2` 不同：

- `Message` 现在是**按 role 闭合的映射**：`system | developer | user | assistant | tool`。
- **tool 结果是一等的 `role: 'tool'` 消息**（`ToolResultMessage`，带 `toolCallId`、`isError`），
  不再是 `tool-result` 内容块；`ContentBlockMap` 现在只有
  `text / reasoning / image / file / tool-call / tool-addition / tool-removal`。
- `MessageSource` 是可合并扩展的联合，**没有 catch-all 的 `plugin` kind**：每个生产者声明自己的 kind
  （`user` / `model` / `tool` / `system-prompt` / `compact-checkpoint` / `model-selection`）。
- **checkpoint 消息**必须用 `@deepseek-ai/dsh-compaction` 导出的
  `compactCheckpointSource(compactionId, sourceCommandId?)`（`kind: 'compact-checkpoint'`）。
  官方 `0.2.0-rc.2` 后端即
  `createUserMessage({ content: frameSummary(...), source: compactCheckpointSource(...) })`，
  并用 `surfaceOp: { op: 'replace', startSeq, endSeq }` 做唯一一次表层变更。
- **本轮迁移（已实现）**：`src/engine.ts` 与 `src/selection.ts` 里 switch `tool-result` 块、
  以及构造 `source: { kind: 'plugin', plugin: ... }` 的地方，都已改为上述新契约；
  checkpoint 用 `compactCheckpointSource(...)` 构造 source。本地验证见 §10。

### 8.2 toolHistory 与动态工具

- `GenerateOptions.toolHistory?: ToolHistory` 由 `Session.toolHistory()` 提供：它按 `headerSeq`
  解析历史里的 `tool-addition` / `tool-removal`，返回不可变快照；请求分发时
  `projectToolUpdates` 据此构造延迟声明、并在 `in-history` 模式保留已移除定义。
- **主循环与压缩调用都应携带它**：官方后端摘要调用传 `toolHistory: agent.session.toolHistory()`；
  缺少历史、或请求前缀遗漏已记录更新时，回退为「当前有效声明、不发 developer 更新」。
- **本轮迁移（已实现）**：`summarizeWithCandidate` 的摘要调用已携带
  `toolHistory: agent.session.toolHistory()`（此前只传
  `provider / model / messages / tools / maxTokens / sessionId / purpose / signal`）。
  本地验证见 §10。

### 8.3 route-priced 与 heuristic 计量

`ctx.tokenMeter` 的节点现在是**双价**：

| 字段 | 含义 | 谁读它 |
|---|---|---|
| `TokenSurfaceNode.tokens` | 该节点在**被测路由**下的请求压力 token；图片出现位置在该路由声明 `imageRequestPricing` 时用提供方视觉 token 价，否则退回固定启发式 | 预算与验收：压力触发、尾部预算、范围选择、checkpoint 验收（`shadowedRouteTokenCount`） |
| `TokenSurfaceNode.heuristicTokens` | 同一消息的**固定启发式**价，与路由无关 | **持久化**的影子价：`compaction/summary` 事件与结果里的 `shadowedTokenCount`（meter 折叠替换时用的是同一套固定估计器，与 `compaction/prune` 共享影子价协议） |

- 两类数值本插件都读，但用途不重叠：预算/验收走路由定价的 `tokens`
  （`shadowedRouteTokenCount`、`measurement.totalTokens` / `surfaceTokens`），
  写进事件与结果的持久化 `shadowedTokenCount` 走 `heuristicTokens`。
- 已知宿主限制：缺少可复用的提供方 usage 时，meter 退回「字符数 + 结构开销」的固定启发式，
  对 CJK 文本与 JSON Schema 定价偏低；tokenizer 精确计量仍是宿主的开放方向。

### 8.4 取消与恢复

- **取消权威**：后端必须把 signal 转发到调用的 `GenerateOptions.signal`，因此 abort 或 fiber dispose
  会停止进行中的摘要。`compaction/start` 标记**之前**的取消或 `busy` 拒绝**不留下记录**；
  标记之后失败才以带错误的 `compaction/end` 记录（不会留下假装成功的 `end`）。
- **恢复不触发摘要**：resume 本身不摘要；恢复后的请求仍按常规 pressure 阈值判断，
  因此已在阈值以下的 checkpoint 不会立刻被再次摘要。
- signal 语义已随本轮迁移接入（`GenerateOptions.signal` + 摘要循环内的 `throwIfAborted`），
  并在本地 fixture 覆盖（§10）；桌面侧验收时确认宿主语义一致。

### 8.5 图片与文件

- **宿主能力，不等于本插件能力**：支持图片的路由在保留出现位置按精确字节超预算时以
  `IMAGE_OFFLOAD_REQUIRED` 失败，官方配套 `dsh-compaction-image-offload` 会记录 `image/offload`
  并重试。**本插件尚未移植 `compaction/summary-error` waterfall**，因此「摘要调用触碰图片预算后
  恢复」这条路径对本插件**未验证**，不要当成已具备的能力。
- 摘要调用返回**图片输出**时，本插件以 `UNSUPPORTED_CONTENT` 失败，而不是静默消失。
- `FileBlock` 引用**不会到达任何适配器**：宿主请求组装把每个引用（含 tool-role 结果中的出现）
  替换为确定性句柄文本 + 该文件的只读保存路径；纯文本路由对图片给确定性占位符。
- 摘要复用热前缀的前提：回放的 system head（surface 节点 0 的 `system/message`）、工具与遮蔽区域
  消息要与上一次路由请求**逐字**一致。本插件为避免跨路由 `invalid_prompt`，会移除
  assistant 消息中的 reasoning 块及 `source.replayState`；这是一项可移植性取舍，可能从该位置
  开始失去热前缀缓存命中，并不保证完整 KV 前缀复用。portable 降级进一步把历史转成文本，
  不携带原始 `tools` 声明；其摘要质量与缓存命中需单独实测。

## 9. 本轮源码迁移内容（已实现）

下面这些是**本轮**落地的源码改动，**不是长期待办清单**；均为实现完成 + 本地验证通过（§10），
**但未发布、也未安装到 Desktop**。

1. **删除临时 cache 诊断**：`src/engine.ts` 里的 `CACHE_DIAG_LOG`（曾指向 `.scratch/compact-diag.jsonl`）、
   `diagDigest` / `diagMessageText` / `diagAppend` 及其在 `summarizeWithCandidate` 的调用点已删除。
   它是解释 summarizer cache 命中率波动的一次性工具，不属于交付物。
2. **保留 Reasonix 策略本身**：唯一触发 `compactRatio`、system head 稳定前缀、
   一条结构化 checkpoint + recent tail、严格减 token 验收 + 物理输入上限、
   canonical session log 不 rewrite、有界摘要尝试。删诊断**不得**顺手改这些几何。
3. **适配消息 API**（§8.1）与补 `toolHistory`（§8.2）。
4. **保留** `command-compact` 与 `tool-result-pruner` 的挂载与协作方式：只替换官方引擎。
5. **历史文档与 vendor 保留**：不重写 `MIGRATION_0.1.11_TO_0.2.0.md`、`PROJECT.md`、
   `MAINTENANCE.md`、`MIGRATION_BRIEF.md`、`UPSTREAM_SYNC_STATUS.md`、`vendor/`。

## 10. 本地已执行验证（源码侧）

本节记录一次**本地**执行的结果。它只证明源码在类型 / 构建 / fixture 层面成立，
**不是真实模型验收，也不是 Desktop 验收**。

| 检查 | 命令 | 结果 |
|---|---|---|
| 依赖对齐 | `npm install --ignore-scripts --cache ../.scratch/npm-cache` | 对齐 `@deepseek-ai/schemastery 3.18.4`（移除 6 个重复包） |
| 类型 | `npm run typecheck` | exit 0 |
| 构建 | `npm run build` | exit 0 |
| 测试 | `node --test` | **24 tests / 24 pass / 0 fail**（6 config + 2 selection + 16 engine） |

覆盖到的场景（fixture 层面）：canonical / resume、pressure / overflow、failure / cancel、
header 与默认 output 预留、`toolHistory` / native file / image refs / temporary user、
图片摘要输出拒绝、conversation 与 fallback 预算、portable tool call / result / file / tool updates
（含空 `isError` 的 tool 与带 offloaded 图片 ID/name 的 block），以及 **selected-span** 的两项：
模拟同一 seq 的重定价时拒绝提交，以及 span 外 append 仍允许并保留。
前者覆盖节点稳定性检查，但没有实际调用图片 offload / prune 插件；这些联动仍待桌面验收。
另外覆盖选区后的异步准备窗口：刷新 route / heuristic 双价，并在选区降价后拒绝实际增量的
checkpoint；手动错误分类区分摘要失败（保留候选链）、准备失败与维护准入 `busy`。

两点限制：

- 测试使用真实 `Session` / `Context` 类型与 fixture，**不调用真实模型**，也不运行 Desktop
  或其 preset realm；
- 受限环境先返回 `spawn EPERM`（管道 stdio 被禁止），上表 `node --test` 的结果来自放宽权限后的
  正式执行。

因此这 24 个 fixture **不能**替代 §11 的桌面验收。

## 11. 待执行验收清单（桌面侧，全部未执行）

> 本阶段**没有把本插件安装到 Desktop、没有连接真实模型**。下表的「状态」列全部是 `未执行`，
> 不是通过也不是失败；§10 的本地 fixture 结果**不构成**本表任何一项。不要在完成前把它读成绿灯。

| # | 场景 | 检查点 | 状态 |
|---|---|---|---|
| 1 | 手动 `/compact` | 走 realm 内当前后端的 `compactNow`，报告压缩项数与释放 token；`command-compact` 未被移除 | 未执行 |
| 2 | pressure 自动触发 | 越过 `compactRatio` 才触发；一次事务；canonical log 未被改写 | 未执行 |
| 3 | provider 确认 overflow | `CONTEXT_WINDOW_EXCEEDED` → 一次最大平衡头缩减，且仅在 replace generation 前进后才重试 | 未执行 |
| 4 | 取消 | 摘要中取消 → 摘要停止；`start` 之前取消无记录；不留半成品 checkpoint | 未执行 |
| 5 | 恢复 resume | 已在阈值以下的 checkpoint 不再摘要；继续对话上下文完整 | 未执行 |
| 6 | 动态工具 | 有 `tool-addition` / `tool-removal` 的会话里，摘要请求工具面与主循环一致；声明不丢不重 | 未执行 |
| 7 | 图片 | 纯文本路由收到确定性占位符；超预算图片路由的行为（含 `IMAGE_OFFLOAD_REQUIRED` 恢复路径）按宿主能力单独验证；摘要图片输出以 `UNSUPPORTED_CONTENT` 失败而非消失 | 未执行 |
| 8 | 文件 | `FileBlock` 不到达适配器，被替换为句柄文本 + 只读路径 | 未执行 |
| 9 | 计量 | 触发 / 尾部 / 范围与 checkpoint 验收走路由定价的 `tokens`；持久化的 `shadowedTokenCount` 走 `heuristicTokens`；无 token-meter surface 不匹配错误 | 未执行 |
| 10 | realm 一致性 | 替换后该 realm 只有一个 `ctx.compaction` 所有者，无 supersede 告警 | 未执行 |

**关于 cloud compaction 的 Codex bridge**：Desktop 侧还有云端 compaction 的 Codex bridge。
它与本地 compaction 后端**可以共存**，本文**不声称二者强制互斥**；做上面这些验收时，
可以**先把 cloud compaction 关掉以隔离变量**，否则观测到的压缩可能来自 cloud 侧而不是本插件。
该共存行为本阶段未在本机验证。

## 12. `resolveCompactSpec` 的 output 预算

记 `W` = context window，`O` = 该路由请求预留的输出 token，`reserve` = `protocolReserveTokens`：

| 量 | 公式 |
|---|---|
| 物理输入上限 ceiling | `W − O − reserve` |
| 触发阈值 trigger | `min(W × compactRatio, ceiling)` |
| recent tail | `min((W − O) × recentTailRatio, floor((W − O) / 2))`（后者是 Reasonix 半窗口保护） |

- `O` 的取值链：`Session.requestHeader()?.config.maxTokens` → 适配器 `defaultMaxTokens` → `0`
  （未路由到可用模型时无法解析 spec）。
- `O + reserve >= W`（ceiling ≤ 0）时**显式失败**并给出 `outputTokens` / `protocolReserveTokens` /
  `contextWindow` 三个数值，而不是产生一个不可达的 ceiling。
- 三个调用点（pressure 触发、范围选择、手动/range 的 spec 解析）都传入同一个 `O`。
- `O = 0` 只是取值链的兜底。本轮几何把 trigger 约束在 ceiling 之内
  （`min(W × compactRatio, ceiling)`），tail 按 `W − O` 计算。

## 13. 相关文档

**随 npm tarball 分发**（在 `package.json` 的 `files` 白名单内）：

- [插件 README](../README.md) —— 配置表、`/compact` 与 pruner 的协作方式
- [cordis.patch.example.yml](../cordis.patch.example.yml) —— 手动挂载示例（含 `file:///` 形式）
- [MIGRATION_0.1.11_TO_0.2.0.md](MIGRATION_0.1.11_TO_0.2.0.md) —— 历史文档记录的已发布代（`0.1.11`）到 `0.2.0` 的配置键迁移

**只在仓库里**（**不随 tarball 分发**，所以给仓库源链接而不是包内相对路径）：

- [PROJECT.md](https://github.com/Zhuchen00123/dsh-compaction-cacheaware/blob/main/docs/PROJECT.md)
  / [MAINTENANCE.md](https://github.com/Zhuchen00123/dsh-compaction-cacheaware/blob/main/docs/MAINTENANCE.md)
  —— 项目说明与维护手册；链接指向仓库 `main` 上的源文件，本地工作区可能领先于已推送内容
  （这两份文档也不在 `files` 白名单内）
- 工作区根 `README.md`（`reasonix-compaction/README.md`）—— **仅源码工作区可用**：
  tarball 不包含工作区根目录，因此这里不给链接，只作本机参考

> 本文件（`docs/DESKTOP_MIGRATION.md`）已列入 `package.json` 的 `files`，随 npm tarball 一起分发。
> 本机另有一份 Desktop API 只读快照（工作区内的 `.scratch/desktop-api/`），
> 它在本仓库 tree 之外，只作本机参考。
