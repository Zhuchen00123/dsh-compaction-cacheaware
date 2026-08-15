# Reasonix Compact 迁移到 DSH —— 新会话交接说明

## 目标

把 Reasonix 的 **Cache-Aware Checkpoint（内容驱动上下文维护）** 移植成 DSH 的 compact 实现，替换/增强官方 `compaction-basic`。

## 参考源码

- Reasonix 仓库：https://github.com/esengine/DeepSeek-Reasonix
- 核心文件：
  - `internal/agent/compact.go`
  - `internal/agent/compact_fold_input.go`
  - `internal/agent/compact_projection.go`
  - `internal/agent/compact_commit.go`
  - `internal/agent/compact_user_turns.go`
- 设计文档：`docs/research/cache-aware-compaction-design.md`
- 本仓库已有摘要：`research/router_experiments.md` 不相关，`WORK_SUMMARY.md` 有背景。

## Reasonix 设计要点（必须保留）

1. **Canonical transcript 永不改写**
   - `Session.Messages` 始终保存完整历史；
   - 压缩只生成 model-visible projection，不替换 canonical。

2. **唯一自动触发**
   - 配置 `compact_ratio`（默认 0.85）；
   - projected tokens ≥ `compact_ratio × context_window` 时才压缩。

3. **Checkpoint 形态**
   - stable system/early prefix
   - 一条结构化 summary（上限约 16K）
   - recent tail（约 10% 窗口，32K–96K）

4. **摘要失败安全**
   - 不写 mechanical marker，不安装半成品，不改 canonical。

5. **缓存友好**
   - resume 不自动压缩；
   - 只在首次跨过阈值时 miss 一次，之后前缀稳定。

6. **工具结果写入时限长**
   - 创建时模型可见 Content 限制 ~32KB；
   - 完整原文进 RawContent / archive。

## DSH 侧需要对接的东西

1. **Compaction seam**
   - DSH 官方是 `@deepseek-ai/dsh-compaction-basic`；
   - 需要实现 `compactIfNeeded` / `compactNow` / `compactRegion` 等接口。

2. **Token meter 坑（已踩过）**
   - `/compact` 会校验 `assistant/message.sourceEventSeqs`；
   - 必须只引用 `assistant/chunk`，否则报：
     `token meter: assistant/message ... is not assistant/chunk`
   - 已有修复工具：`research/scripts/repair_all_token_meter.cjs`

3. **会话日志格式**
   - session 是 zstd 多帧 JSONL；
   - 压缩事件走 `compaction/start → replace → compaction/end`；
   - 不要破坏 seq 连续性。

4. **Preset 集成**
   - 目标 preset：`dsh-wsl-modes/presets/code-wsl` 和 `minimal-wsl`；
   - 也要兼容 `router-opencode-wsl`。

## 交付物

1. DSH 插件包：`dsh-compaction-cacheaware`（或类似名字）；
2. 可替换 `compaction-basic` 的配置示例；
3. 保留 canonical 的 sidecar：`<session>.context.json`（schema v3 类似）；
4. 测试：在真实会话跑 `/compact`，确认：
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

- DSH：`0.1.0-rc.6`
- 测试实例：`http://127.0.0.1:3101/`
- 视觉/router 插件已装，不影响 compact 开发。
