# Reasonix Compact 迁移到 DSH —— 新会话交接说明

> 本文保留最初的调研交接背景；当前实现范围、已删配置键和发版门槛以
> [PROJECT.md](PROJECT.md) 与 [0.1.11 → 0.2.0 迁移说明](MIGRATION_0.1.11_TO_0.2.0.md)
> 为准。自动化集成测试使用 DSH `0.1.6-alpha.2` 的真实 `Session` / `Context`
> 类型；它不是连接真实模型或运行中 DSH profile 的端到端验收。

## 目标

把 Reasonix 的 **Cache-Aware Checkpoint（内容驱动上下文维护）** 移植成 DSH 的 compact 实现，替换/增强官方 `compaction-basic`。

## 参考源码

- Reasonix 仓库：https://github.com/esengine/DeepSeek-Reasonix
- 核心文件：
  - `internal/agent/compact.go`
  - `internal/agent/compact_fold_input.go`
  - `internal/agent/compact_projection.go`
  - `internal/agent/compact_commit.go`
  - `internal/agent/compact_user_turns.go`（历史文件；在当前同步 commit 中已删除）
- 设计文档：`docs/research/cache-aware-compaction-design.md`
- 本仓库已有摘要：`research/router_experiments.md` 不相关，`WORK_SUMMARY.md` 有背景。

## Reasonix 设计要点（必须保留）

1. **Canonical transcript 永不改写**
   - DSH 的 append-only session event log 保留原消息；
   - compaction 只用 surface replacement 改变 model-visible projection。

2. **唯一自动触发**
   - 配置 `compact_ratio`（默认 0.8，随上游）；
   - projected tokens ≥ `compact_ratio × context_window` 时才压缩。

3. **Checkpoint 形态**
   - stable prefix（仅 system head；上游已删除 first-user-turn pin）
   - 一条结构化 summary（上限 8192 tokens）
   - recent tail（`window × 16%`，上游已取消 32K–96K 夹取）

4. **摘要失败安全**
   - 不写 mechanical marker，不安装半成品，不改 canonical。

5. **缓存友好**
   - resume 本身不触发摘要，恢复后的请求仍按 pressure 阈值判断；
   - 已在阈值以下的 checkpoint 不会立即再次摘要。

6. **工具结果写入时限长**
   - 这是 Reasonix 上游的工具结果持久化策略，不由本插件实现；
   - 本插件尚未移植 active-turn overflow keep、summary 输入裁剪、chunked summary
     或 lossy tool-result trimming，见 `PROJECT.md` 的未移植机制清单。

## DSH 侧需要对接的东西

1. **Compaction seam**
   - DSH 官方是 `@deepseek-ai/dsh-compaction-basic`；
   - 需要实现 `compactIfNeeded` / `compactNow` / `compactRegion` 等接口。

2. **Token meter 坑（已踩过）**
   - 当前实现使用 `Session.eventAt()` / `SessionSeq` 和 token meter 的 surface 测量；
   - surface replacement 使用 `startSeq` / `endSeq` 并完整引用被替换节点。

3. **会话日志格式**
   - session 是 zstd 多帧 JSONL；
   - 压缩事件走 `compaction/start → compaction/summary → user/message replace → compaction/end`；
   - 不要破坏 seq 连续性。

4. **Preset 集成**
   - 目标 preset：`dsh-wsl-modes/presets/code-wsl` 和 `minimal-wsl`；
   - 也要兼容 `router-opencode-wsl`。

## 交付物

1. DSH 插件包：`dsh-compaction-cacheaware`（或类似名字）；
2. 可替换 `compaction-basic` 的配置示例；
3. 使用 DSH 原生日志和 surface 保留 canonical 历史，不再额外要求本插件 sidecar；
4. 自动化测试使用 DSH session 实例覆盖 `/compact` 后端、threshold、overflow、
   摘要失败、canonical 保留、继续对话和 replay/resume；真实模型 / profile 测试仍需另行安排：
   - 不报 token meter 错误；
   - canonical 历史完整；
   - 压缩后能继续对话；
   - resume 不丢上下文。

## 测试计划

1. 新建测试会话，跑一段较长对话；
2. 触发 `/compact`；
3. 验证：
   - `session.history` 中 canonical 仍在；
   - 模型可见上下文变短；
   - 继续对话正常；
   - 不出现 `sourceEventSeqs` 坏引用。

## 当前环境

- 插件宿主目标：DSH `0.1.6-alpha.2` API。
- 本文后面的 `0.1.0-rc.6` 与 `127.0.0.1:3101` 是最初调研时记录的环境，
  不是当前发版验证结果。
