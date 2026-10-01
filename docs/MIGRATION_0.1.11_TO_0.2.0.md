# 从 0.1.11 升级到 0.2.0

`0.2.0` 是破坏性配置更新。升级前请检查每个使用
`dsh-compaction-cacheaware` 的 preset，尤其是独立 compaction realm；profile
bundle patch 不会替换这些 preset realm 中的 `compaction-basic`。

## 配置键变化

以下键已删除，升级时应从 preset 配置中移除：

| 0.1.11 配置键 | 0.2.0 处理方式 |
|---|---|
| `checkpointCeilingRatio` | 已删除。候选 checkpoint 只需严格减少 token；自动压缩还必须低于物理输入上限。 |
| `recentTailMinTokens` / `recentTailMaxTokens` | 已删除，改由 `recentTailRatio` 按模型窗口预算；默认 `0.16`，不再使用 min/max 夹取。 |
| `exceptionalMinSavingsRatio` | 已删除。没有 exceptional fixed-prefix savings 分支。 |
| `maxPinnedFirstUserTokens` / `pinnedFirstUserWindowFrac` | 已删除。稳定前缀只保留 system head，旧 user turn 与 `[[keep]]` 内容可进入 summary。 |

当前常用默认值：

- `compactRatio: 0.8`
- `recentTailRatio: 0.16`
- `summaryMaxTokens: 8192`
- `minRecentKeep: 2`
- `minCompactMessages: 2`
- `protocolReserveTokens: 256`

如果希望保留更多近期上下文，请调高 `recentTailRatio`。不要把旧的
`recentTailMinTokens` / `recentTailMaxTokens` 原值机械换算成固定 token 数；
新策略按具体模型窗口缩放。

## 宿主版本

0.2.0 面向 DSH `0.1.6-alpha.2` 一代的 compaction seam 和 session API。此版
使用 `Session.eventAt()` / `SessionSeq` 读取日志，以 `startSeq` / `endSeq`
指定 surface replacement，并从 `system/message` surface node 重放 system
prompt。请确认宿主及相关 `@deepseek-ai/dsh-*` 包符合 `package.json` 中的
peer dependency 范围。

## 行为和 preset 检查

- 保留 `dsh-command-compact`，其 `/compact` 会调用此包的 `compactNow`。
- 自动 pressure 仍以 `compactRatio` 触发；provider 确认 context overflow 时可走
  单次 overflow recovery。成功的 compaction 保留原始 canonical session log，
  仅替换 model-visible surface。
- Resume 本身不会触发摘要；恢复后的请求仍按常规 pressure 阈值判断，因此已在
  阈值以下的 checkpoint 不会立刻再次摘要。
- 可选 `dsh-compaction-tool-result-pruner` 由独立插件提供；默认不启用。未安装时
  0.2.0 不会自行执行持久 tool-result prune。

截至 2026-09-23，本次只读检查结果：

- `compaction-reasonix/` 的 YAML 示例中没有使用这些已删键；
- `%USERPROFILE%\.dsh\profiles\{headless,tui,web}` 的配置文件中没有这些键；
- 工作区相邻的 `F:\codexprojects\deepseek-harnes` 有 **7 个 preset 配置**仍带有
  `checkpointCeilingRatio: 0.5` 以及旧 `recentTailMinTokens` / `recentTailMaxTokens`：
  `config/agent-presets/deepseek-team`、
  `wsl-modes/router-opencode-wsl/preset`，以及
  `wsl-modes/dsh-wsl-modes/presets/{code-wsl,minimal-wsl,router-standard-wsl,
  router-standard-wsl-thin,router-flash-godmode-wsl}`。未发现这些 preset 使用
  `exceptionalMinSavingsRatio` 或 first-user pin 两个键。

这 7 个 preset 仍保留 `compactRatio: 0.85`、`recentTailRatio: 0.1` 和
`summaryMaxTokens: 16384`。这些仍是有效选项，会继续覆盖 0.2.0 默认值；已删的
ceiling 与 tail min/max 则不会进入 resolved config。结果是原来的 50% ceiling 和
8K/16K 或 32K/96K tail clamp 不再生效，而 `recentTailRatio: 0.1` 会按窗口预算
10% tail。升级这些 preset 时，删除三项旧键，并明确决定是否保留 `.85` / `.1` /
`16384` 这三个仍有效的自定义值。

这些 preset 位于项目外，本次只记录影响，没有修改它们。其他未挂载、未检出的
preset 仍需各自检查。

## 发版前

提交内容应包含 `src/`、对应的 `lib/`、测试、文档、`cordis.patch.yml` 与完整
`vendor/reasonix/compact/` 快照。将发布 commit 推送并把 `v0.2.0` tag 推到远端后，
再运行 `./scripts/publish-npm.sh 0.2.0`；该脚本只接受已提交且已推送的 release
commit，不会自动 bump 版本或在 npm 发布后再尝试 Git 操作。
