# dsh-compaction-cacheaware 项目说明

> 本文档是 `compaction-reasonix` 子目录的维护入口。
> 以后所有 Reasonix compact 迁移、DSH 插件开发、同步与发布都在本目录进行。

## 项目目标

把 Reasonix 的 **Cache-Aware Checkpoint（内容驱动上下文维护）** 移植为
DeepSeek Harness 的模块化 compact 插件，替换/增强官方 `compaction-basic`。

核心设计：

- canonical transcript 永不改写；
- 唯一自动触发：`compact_ratio`（默认 0.8，随上游）；
- checkpoint = stable prefix（仅 system head）+ 一条结构化 summary + recent tail
  （`window × 16%`）；
- 验收：候选必须真正减 token，自动维护还须落到物理硬上限
  （`window − protocolReserveTokens`）以下；
- 缓存友好：resume 本身不触发摘要；恢复请求仍按 pressure 阈值判断，低于阈值的
  checkpoint 不会立即被再次摘要；
- 摘要失败不写半成品、不装 mechanical marker；
- 不侵入其他 DSH 插件。

## 上游对齐现状

| 项 | 值 |
|---|---|
| 上游 | `esengine/DeepSeek-Reasonix` @ `main-v2` |
| 当前同步 commit | `2a2dbbeaefe624d1764118d4aafb660fb7a53e0b`（2026-09-23） |
| vendor 快照 | 17 个文件（15 个 `.go` + 2 个设计文档），见 `vendor/reasonix/compact/` |
| 漂移 | **零**（`REASONIX_UPSTREAM_REMOVED_CONSTANTS = []`） |
| 本包版本 | 源码 `0.2.0`；npm 已发布 `0.1.11` |

### 0.2.0 已实现范围

- DSH `0.1.6-alpha.2` compaction seam、手动 `compactNow`、pressure 监听和
  provider-confirmed overflow recovery；
- system head 稳定前缀、按窗口比例选择 recent tail、单条结构化 checkpoint；
- 有界 summarizer 路由与 `invalid_prompt` 时 provider-neutral transcript fallback；
- durable compaction 生命周期和 DSH surface replacement；canonical event log 不删除，
  resume 从替换后的 surface 重建可见历史；
- 若独立 `dsh-compaction-tool-result-pruner` 已挂载，会在 summary 前调用它并重测；
  未安装时本包不自行 prune。

`0.2.0` 是**破坏性配置变更**：上游删除了 checkpoint ceiling、recent-tail
min/max、exceptional savings、first-user pin、kept-user-turn 这一整层几何策略
（承载它的 `compact_user_turns.go` 也被删除），因此插件同步删除对应配置项，
而不是留成「不再跟踪任何东西」的假配置。同时宿主 API 迁移到
`0.1.6-alpha.2` 一代：`Session.eventAt`/`SessionSeq` 取代 `Session.events`，
`surfaceOp` 用 `startSeq`/`endSeq`，`EpochHeader` 不再带 `system`
（system prompt 现在是 surface node 0 的 `system/message`，随 `messages` 一起
replay 才能命中 provider KV cache）。迁移写法对齐宿主自带的
`dsh-compaction-basic`，不是自行发明。

### 尚未移植的上游机制

完整上游快照在 `vendor/` 中仅作参考；vendored 不代表已移植。DSH 插件尚未实现：

- active-turn overflow fold 保留最近两轮完整对话；
- 按 pressure / overflow / manual 分配不同 summary 输出预算；
- 对 summary 输入做安全前缀二分，或将 summary 拆成 chunk；
- summary 请求自身溢出后的 slim/transcript 重试，以及有损截断 / 删除 replay 单元；
- 根据真实 summary 调用 token 数反馈校准预算。

上游的 prune-first 只通过可选 pruner 插件条件式接线；持久 prune 算法不属于本包，
也不是默认启用。`context_*.go` 快照中的 capsule、receipt、recovery、report 和 usage
子系统同样没有随 0.2.0 移植到本插件。

另有一处**故意不跟**：上游 `planCompaction` 传入常量 `0` 的 tail floor，使
`minRecentKeep` 在规划中失效，而 `compact.go` 的注释与代码自相矛盾。本插件保留
`minRecentKeep` 作为安全界，不复刻疑似回归。

## 目录结构

```text
compaction-reasonix/
├── README.md                     # 对外 README（GitHub 首页）
├── docs/
│   ├── PROJECT.md                # 本文件：项目说明
│   ├── MAINTENANCE.md            # 维护手册
│   ├── MIGRATION_BRIEF.md        # 迁移交接说明
│   ├── MIGRATION_0.1.11_TO_0.2.0.md # 本次破坏性配置迁移
│   ├── UPSTREAM_SYNC_REPORT.md   # 每次同步自动生成的漂移报告（机器产出）
│   ├── UPSTREAM_SYNC_STATUS.md   # 2026-09-23 上游调研快照（历史记录）
│   └── reasonix_compact_design.md # Reasonix 原始设计摘要（历史文档，含过期提示）
├── src/
│   ├── engine.ts                 # CompactionEngine 实现
│   ├── selection.ts              # stable prefix / recent tail / 验收规则
│   ├── config.ts                 # 配置解析与 token budget 解析
│   ├── prompt.ts                 # summary prompt / framing
│   ├── index.ts                  # 插件入口
│   └── generated/
│       └── reasonix-constants.ts # 由 sync 脚本自动生成
├── tests/
│   ├── selection.test.mjs        # range selection 回归测试
│   └── engine.integration.test.mjs # DSH Session / Context compaction 集成验证
├── vendor/
│   └── reasonix/compact/         # 上游 Reasonix compact 源码/文档快照
├── scripts/
│   ├── sync-reasonix-compact.mjs # 自动同步上游（支持 --from 离线快照）
│   ├── publish.sh                # GitHub 发布 + dsh-plugin topic
│   └── publish-npm.sh            # 已提交、已推送 tag 的 npm 发布预检
├── .github/workflows/
│   └── sync-reasonix-compact.yml # 定时/手动同步 Action
├── lib/                          # 编译产物（发布内容）
├── cordis.patch.yml              # 随包发布的 bundle patch
├── cordis.patch.example.yml      # 手动挂载示例
├── package.json                  # files 白名单即发布内容
├── tsconfig.json
├── LICENSE
└── .gitignore
```

## 技术栈

- TypeScript / ESM，Node `>=22`
- DeepSeek Harness `0.1.6-alpha.2`（`peerDependencies` 声明 `^0.1.6-alpha.2`；
  这些包在 npm 上是公开的）
- `@deepseek-ai/dsh-compaction` seam（同时参考官方 `dsh-compaction-basic` 的迁移写法）
- `@deepseek-ai/dsh-session`、`dsh-llm`、`dsh-agent`、`dsh-token-meter`、`dsh-commands`
- 可选：`@deepseek-ai/dsh-compaction-tool-result-pruner`

## 常用命令

```bash
# 类型检查 / 构建
pnpm typecheck
pnpm build

# 回归 / 集成测试
pnpm test                        # selection + DSH Session / Context transaction coverage

# 同步 Reasonix 最新实现
pnpm sync:reasonix
node scripts/sync-reasonix-compact.mjs --from <已抓取的上游树>   # 无 git 网络时

# 发布
# npm：先提交并推送 release commit 及匹配 tag，再运行固定目标版本
./scripts/publish-npm.sh 0.2.0
./scripts/publish.sh dsh-compaction-cacheaware   # GitHub + dsh-plugin topic
```

## 部署到本地 profile（重要）

`~/.dsh/profiles/web/node_modules/dsh-compaction-cacheaware` 是**真实目录副本**，
不是 `file:` 链接。因此：

- 只重建本仓库**不会**改变线上加载的产物；
- 必须把 `lib/**` + 包元数据（`package.json`、`README.md`、`LICENSE`、
  `cordis.patch.yml`、`cordis.patch.example.yml`）拷进去，或重新 `pnpm add`；
- 拷贝后需要重载/重启 DSH 才生效（运行中的进程持有旧模块实例）；
- 本机已有一个先前安装的 0.2.0 profile 副本，旧版备份在
  `node_modules/dsh-compaction-cacheaware.bak-0.1.10-20260923`；本次发版准备没有
  把新的构建产物复制到 profile，也没有重载 DSH。

## 当前状态

- [x] Reasonix compact 设计调研
- [x] DSH compact 接口调研
- [x] 插件实现 `CacheAwareCompactionEngine`
- [x] 自动同步脚本 + GitHub Action（改为「必产快照 + 漂移报告」，幂等）
- [x] 宿主 API 迁移到 `0.1.6-alpha.2`，恢复可编译
- [x] 按上游 `2a2dbbea` 对齐几何策略，删除已废弃概念
- [x] typecheck / build / selection + engine integration tests 全绿
- [ ] 将本次构建同步到本机 profile 并在运行中的 DSH 实例验收（不属于本次发版准备）
- [x] GitHub 仓库与 npm 发布链路打通（npm 已发布 `0.1.11`）
- [x] 检查项目、本机 profile 和工作区相邻 preset；发现 7 个 preset 仍有旧 ceiling /
      tail min/max 键，均未修改，见迁移指南
- [ ] 提交并推送完整 `0.2.0` release commit 与匹配 tag，再请求发布批准
- [ ] 创意工坊收录确认
