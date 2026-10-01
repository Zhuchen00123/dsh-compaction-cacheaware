# dsh-compaction-cacheaware

Reasonix-style **cache-aware compaction** backend for DeepSeek Harness (DSH).

This is a standalone, modular DSH plugin. It implements the official
`@deepseek-ai/dsh-compaction` seam (`ctx.compaction`) and is designed to be
mounted **instead of** `@deepseek-ai/dsh-compaction-basic` inside a preset's
compaction realm. It does **not** modify other plugins, presets, or host files.

> 🐋 收录于 DSH 插件社区目录（1024Store）
>
> 本仓库带 `dsh-plugin` topic，且 `package.json` 声明了有效的
> `dsh.bundle.patch`（patch 文件随仓库同 revision 提交），可被
> [awesome-deepseek-harness-plugins](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)
> 目录的静态校验收录。
> 在线市场：<https://deepseek1024.com/>

## Docs

- [PROJECT.md](docs/PROJECT.md) — 项目说明与维护入口
- [MAINTENANCE.md](docs/MAINTENANCE.md) — 维护手册
- [MIGRATION_BRIEF.md](docs/MIGRATION_BRIEF.md) — 迁移交接说明
- [DESKTOP_MIGRATION.md](docs/DESKTOP_MIGRATION.md) — DSH Desktop `0.2.0-rc.2` 安装与迁移
  （两套依赖锚点、包安装 ≠ preset realm 替换、宿主 API 变化、待执行验收清单）
- [reasonix_compact_design.md](docs/reasonix_compact_design.md) — Reasonix 原始设计

## What it ports from Reasonix

Synced against upstream `main-v2` at the commit recorded in
`src/generated/reasonix-constants.ts`; each sync writes
[docs/UPSTREAM_SYNC_REPORT.md](docs/UPSTREAM_SYNC_REPORT.md).

- **One automatic trigger**: `compact_ratio` (default `0.8`), not multiple
  soft/snip/force thresholds.
- **One structured checkpoint per transaction**: stable prefix + one summary +
  recent tail.
- **Stable prefix is the system head only**: upstream's `pinnedPrefixLen` keeps
  the system message, so older user turns, failures, and `[[keep]]` markers now
  enter the summary prefix instead of being retained verbatim.
- **Recent tail budget**: `window × recent_tail_ratio` (16%), with no min/max
  clamp.
- **Checkpoint acceptance**: the candidate must strictly reduce tokens and, for
  automatic maintenance, land below the physical input ceiling
  (`window − protocolReserveTokens`). Upstream removed the 50% checkpoint
  ceiling and the exceptional fixed-prefix savings path, so any strictly
  smaller candidate is accepted.
- **Canonical transcript preserved**: DSH's surface `replace` shadows the old
  range in the model-visible projection only; the raw session log remains the
  source of truth.
- **Bounded summarizer calls**: one call per candidate attempt, with the
  provider-neutral transcript fallback for `invalid_prompt` gateways and no
  unbounded retry loop.
- **Reasonix summary headings**: `Standing facts & constraints`, `Goal`,
  `Decisions & rationale`, `Files & code`, `Commands & outcomes`,
  `Errors & fixes`, `Pending & next step`.

### 0.2.0 scope and upstream gaps

This release ports the single pressure threshold, system-head retention, one
structured checkpoint plus recent tail, bounded summary routing, durable
`compaction/start → summary → replace → end` transactions, and canonical-log
preservation through the DSH `0.2.0-rc.2` session API (the earlier
`0.1.6-alpha.2` generation is history — see
[DESKTOP_MIGRATION.md](docs/DESKTOP_MIGRATION.md) §1). Manual `/compact`,
pressure compaction, and provider-confirmed overflow all use the same backend
transaction. A restored checkpoint below the pressure threshold does not
summarize again on resume; later requests still follow the normal threshold.

The following upstream mechanisms are not implemented by this package: keeping
the latest two completed rounds inside an active-turn overflow fold, trigger-
specific summary budgets, binary search for a safe summary prefix, chunked
summaries, overflow-driven slim/transcript retries, lossy tool-result/history
trimming, and learned summary-token feedback. If the optional
`dsh-compaction-tool-result-pruner` is mounted, this plugin invokes it before a
summary attempt; the pruner itself remains a separate package and is not enabled
by default. Other vendored `context_*.go` files are reference snapshots, not a
port of Reasonix's context-capsule, receipt, recovery, reporting, or usage
subsystems.

For removed configuration keys and the upgrade from `0.1.11`, see
[the migration guide](docs/MIGRATION_0.1.11_TO_0.2.0.md).

## Install / build

### 安装到 DSH profile（推荐）

已发布到 npm registry，直接安装：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add dsh-compaction-cacheaware
```

注意：`npm install` 按 registry 上的 tag 解析，装到哪个版本取决于当时的 tag，**不能代替**选择
本轮本地产物——本地 `0.2.0` 迁移产物尚未发布，也未安装到 Desktop；目标宿主是 DSH `0.2.0-rc.2`
一代（见 [DESKTOP_MIGRATION.md](docs/DESKTOP_MIGRATION.md) §1 / §3.3）。

本包自带 DSH profile bundle 声明和 `cordis.patch.yml`。将
`dsh-compaction-cacheaware` 加入 profile 的 `dsh.profile.bundles` 后，DSH 会在
**profile 层**禁用 `compaction-basic` 并挂载本后端；agent preset 的 isolated compaction
realm 需要**各自另行替换**（profile 层 patch 到不了那里，见下）。不要再把同一条插入 patch
重复添加到 profile 的 `cordis.patch.yml`。

也可以从 GitHub 安装：

```powershell
pnpm add dsh-compaction-cacheaware@github:Zhuchen00123/dsh-compaction-cacheaware
```

### 安装到 DSH Desktop

Desktop 走**桌面自己的插件管理**，不要用 `dsh plugin --profile desktop`
（`desktop` 这个名字保留给 Electron 持有的 profile，CLI 会拒绝它的插件管理请求）。
Desktop 有自己的依赖锚点，且「装包」与「在每个 preset 的 isolated compaction realm 里替换引擎」
是两步；本节上面的 profile 层自动替换只覆盖 profile 组合，不覆盖 preset realm。

安装载体建议用 **`npm pack` 打出的 tarball 经桌面插件管理安装**：这样 `@deepseek-ai/dsh-*`
与 `@deepseek-ai/cordis` 都由 Desktop 自己的锚点解析，与运行时是同一份。**不要**把带完整 dev
`node_modules` 的开发目录直接 `file://` 挂给 Desktop——宿主类依赖会从该目录解析，可能与
Desktop 运行时不是同一实例（peer 不一致 / 双实例风险），只适合临时调试。
完整步骤、`0.2.0-rc.2` 宿主 API 变化与桌面验收清单见
[DESKTOP_MIGRATION.md](docs/DESKTOP_MIGRATION.md)。

### 本地开发 / 构建

```bash
pnpm install
pnpm build
```

本地验证状态：`npm run typecheck` 与 `npm run build` 通过，`node --test` **24/24 通过**
（6 config + 2 selection + 16 engine，含选区准备与摘要期间重定价、变更拒绝和手动错误分类）；这是源码侧 fixture 验证，
**不是**真实模型或 Desktop 验收，后者仍是 `未执行`
（见 [DESKTOP_MIGRATION.md](docs/DESKTOP_MIGRATION.md) 的 §10 / §11）。

如果不使用 profile bundle，也可以在 preset 的 compaction realm 里手动替换：

```yaml
# - id: compaction-basic
#   name: '@deepseek-ai/dsh-compaction-basic'
- id: compaction-cacheaware
  name: 'dsh-compaction-cacheaware'
  config:
    compactRatio: 0.8
    recentTailRatio: 0.16
    summaryMaxTokens: 8192
```

如果从源码本地调试，也可以直接用编译产物路径：

```yaml
- id: compaction-cacheaware
  name: 'file:///absolute/path/to/dsh-compaction-cacheaware/lib/index.js'
  config:
    compactRatio: 0.8
    recentTailRatio: 0.16
    summaryMaxTokens: 8192
```

Note: mounts inside an **agent preset's isolated compaction realm** replace
`compaction-basic` there directly; the profile-level bundle patch cannot reach
that realm, so every preset that ships `compaction-basic` in its own compaction
group must be migrated to this package.

Keep `@deepseek-ai/dsh-command-compact` in the same realm so `/compact` uses
this backend. The optional `@deepseek-ai/dsh-compaction-tool-result-pruner` can
still be mounted as a sibling; this plugin reads it through `ctx.get()`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `compactRatio` | `0.8` | Sole automatic trigger fraction. |
| `recentTailRatio` | `0.16` | Recent verbatim tail fraction of the window. |
| `summaryMaxTokens` | `8192` | Summarizer output cap. |
| `minRecentKeep` | `2` | Minimum recent messages kept. |
| `minCompactMessages` | `2` | Minimum compactable messages. |
| `protocolReserveTokens` | `256` | Framing reserve; also sets the physical input ceiling (`window − this`). |
| `summarizationProvider` / `summarizationModel` | `''` | Optional summary route; defaults to conversation route. |
| `auto` | `true` | Register automatic pressure/overflow listeners. |

The former `checkpointCeilingRatio`, `recentTailMinTokens`,
`recentTailMaxTokens`, `exceptionalMinSavingsRatio`, `maxPinnedFirstUserTokens`,
and `pinnedFirstUserWindowFrac` keys were removed: upstream deleted the concepts
they tracked, so keeping them would have been configuration that silently stops
tracking anything. `minRecentKeep` is retained as a safety bound — upstream's
`planCompaction` currently passes a constant `0` tail floor, which its own
comment contradicts, so this port does not copy that behaviour.

## Modularity

- The plugin only registers `ctx.compaction` and its own automatic listeners.
- **Realm self-check (since 0.1.11)**: mounting logs a warning when another
  compaction engine already owns `ctx.compaction` in the same realm, and if a
  later mount supersedes this instance, its automatic listeners stand down
  (warn-once, hot-reload aware) instead of racing the new owner. Note a
  profile-level bundle patch cannot reach an agent preset's isolated
  compaction realm — migrate each preset individually.
- It does not edit `dsh-wsl-bash`, `dsh-team-dashboard`, `router-opencode-wsl`,
  or any other plugin.
- To use it, mount it in your own preset or profile patch; see
  `cordis.patch.example.yml` in this package.

## Keeping in sync with Reasonix

`scripts/sync-reasonix-compact.mjs` and the GitHub Action in
`.github/workflows/sync-reasonix-compact.yml` check `esengine/DeepSeek-Reasonix`
weekly (Sunday 03:00 UTC), on manual dispatch, and on pushes to this repository's
`main`; when it finds changes it opens or updates a PR. The sync job:

1. Fetches the latest `main-v2` Reasonix source (or uses a pre-fetched tree via
   `--from <dir>`, for sandboxes and CI without git network access).
2. Discovers matching `compact*.go` / `context*.go` files in the upstream agent
   directory instead of using a fixed file list.
3. Refreshes `vendor/reasonix/compact/`, regenerates
   `src/generated/reasonix-constants.ts`, and writes
   `docs/UPSTREAM_SYNC_REPORT.md`.
4. Commits and opens a PR with what changed.

Sync used to be compatibility-gated: a structural upstream rewrite produced a
warning and **no changes at all**, so CI opened no PR and the vendored snapshot
rotted unnoticed. It now always lands the snapshot plus a report, marks any port
constants upstream has removed via `REASONIX_UPSTREAM_REMOVED_CONSTANTS`, and
keeps the last local value only so the package still builds.

```bash
pnpm sync:reasonix                        # fetch from git
node scripts/sync-reasonix-compact.mjs --from /path/to/upstream-tree   # offline
```

The generated constants are imported by this package so tuning values stay
traceable to upstream.

## Publish to GitHub / community catalog

This repository is designed to be published as a standalone public GitHub repo.
The [1024Store catalog](https://github.com/imsai-sh/awesome-deepseek-harness-plugins)
discovers public repos with the `dsh-plugin` topic and statically validates the
`dsh.bundle.patch` declaration (the patch file must exist in the same tree).

```bash
# 1. Authenticate GitHub CLI once
gh auth login

# 2. From this repository root, publish and add catalog topics
./scripts/publish.sh dsh-compaction-cacheaware
```

`scripts/publish.sh` will:

1. Create a public GitHub repo and push this repository.
2. Add `dsh-plugin`, `deepseek-harness`, and `reasonix` topics.

After that, [deepseek1024.com](https://deepseek1024.com/) lists the entry.
For an npm release, first commit and push the complete release tree and push its
matching `vX.Y.Z` tag, then run `./scripts/publish-npm.sh X.Y.Z`. The npm script
checks that the local and remote branch/tag already identify the same clean
commit before it publishes; it does not bump versions or create Git refs.

## License

MIT
