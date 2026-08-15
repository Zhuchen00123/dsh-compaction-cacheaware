# dsh-compaction-cacheaware 项目说明

> 本文档是 `compaction-reasonix` 子目录的维护入口。
> 以后所有 Reasonix compact 迁移、DSH 插件开发、同步与发布都在本目录进行。

## 项目目标

把 Reasonix 的 **Cache-Aware Checkpoint（内容驱动上下文维护）** 移植为
DeepSeek Harness 的模块化 compact 插件，替换/增强官方 `compaction-basic`。

核心设计：

- canonical transcript 永不改写；
- 唯一自动触发：`compact_ratio`（默认 0.85）；
- checkpoint = stable prefix + 一条结构化 summary + recent tail；
- 缓存友好：resume 不自动压缩，只有跨过阈值时预期 miss 一次；
- 摘要失败不写半成品、不装 mechanical marker；
- 不侵入其他 DSH 插件。

## 目录结构

```text
compaction-reasonix/
├── README.md                     # 对外 README（GitHub 首页）
├── docs/
│   ├── PROJECT.md                # 本文件：项目说明
│   ├── MAINTENANCE.md            # 维护手册
│   ├── MIGRATION_BRIEF.md        # 迁移交接说明
│   └── reasonix_compact_design.md # Reasonix 原始设计摘要
├── src/
│   ├── engine.ts                 # CompactionEngine 实现
│   ├── selection.ts              # range/tail/ceiling 选择
│   ├── config.ts                 # 配置解析
│   ├── prompt.ts                 # summary prompt / framing
│   ├── index.ts                  # 插件入口
│   └── generated/
│       └── reasonix-constants.ts # 由 sync 脚本自动生成
├── vendor/
│   └── reasonix/compact/         # 上游 Reasonix compact 源码/文档快照
├── scripts/
│   ├── sync-reasonix-compact.mjs # 自动同步上游
│   └── publish.sh                # GitHub 发布 + workshop topic
├── .github/workflows/
│   └── sync-reasonix-compact.yml # 定时/手动同步 Action
├── lib/                          # 编译产物
├── package.json
├── tsconfig.json
├── cordis.patch.example.yml
├── LICENSE
└── .gitignore
```

## 技术栈

- TypeScript / ESM
- DeepSeek Harness `0.1.0-rc.6`
- `@deepseek-ai/dsh-compaction` seam
- `@deepseek-ai/dsh-token-meter`
- `@deepseek-ai/dsh-llm`
- `@deepseek-ai/dsh-session`
- `@deepseek-ai/dsh-agent`
- `@deepseek-ai/dsh-commands`

## 常用命令

```bash
# 构建
pnpm build

# 类型检查
pnpm typecheck

# 同步 Reasonix 最新实现
node scripts/sync-reasonix-compact.mjs

# 发布到 GitHub + 创意工坊 topic
./scripts/publish.sh dsh-compaction-cacheaware
```

## 当前状态

- [x] Reasonix compact 设计调研
- [x] DSH compact 接口调研
- [x] 插件实现 `CacheAwareCompactionEngine`
- [x] 自动同步脚本 + GitHub Action
- [x] GitHub 发布准备
- [ ] 实际推送 GitHub（需要 `gh auth login` / `gh.exe`）
- [ ] 创意工坊收录确认
