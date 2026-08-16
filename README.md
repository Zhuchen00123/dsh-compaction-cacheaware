# dsh-compaction-cacheaware

Reasonix-style **cache-aware compaction** backend for DeepSeek Harness (DSH).

This is a standalone, modular DSH plugin. It implements the official
`@deepseek-ai/dsh-compaction` seam (`ctx.compaction`) and is designed to be
mounted **instead of** `@deepseek-ai/dsh-compaction-basic` inside a preset's
compaction realm. It does **not** modify other plugins, presets, or host files.

> 🐋 收录于 DSH 创意工坊
>
> 本仓库打上 `dsh-plugin` topic 后，会被
> [DSH 创意工坊](https://github.com/JxaMe/dsh-workshop) 自动扫描收录。
> 在线地址：<https://JxaMe.github.io/dsh-workshop/>

## Docs

- [PROJECT.md](docs/PROJECT.md) — 项目说明与维护入口
- [MAINTENANCE.md](docs/MAINTENANCE.md) — 维护手册
- [MIGRATION_BRIEF.md](docs/MIGRATION_BRIEF.md) — 迁移交接说明
- [reasonix_compact_design.md](docs/reasonix_compact_design.md) — Reasonix 原始设计

## What it ports from Reasonix

- **One automatic trigger**: `compact_ratio` (default `0.85`), not multiple
  soft/snip/force thresholds.
- **One structured checkpoint**: stable prefix + one summary + recent tail.
- **Recent tail budget**: `clamp(window×10%, 32K, 96K)`.
- **Checkpoint acceptance**: normal candidates ≤ 50% of window and below the
  trigger; exceptional fixed-prefix path requires ≥25% savings.
- **Canonical transcript preserved**: DSH's surface `replace` shadows the old
  range in the model-visible projection only; the raw session log remains the
  source of truth.
- **One summarizer call per transaction**: no application-layer retry loops.
- **Reasonix summary headings**: `Standing facts & constraints`, `Goal`,
  `Decisions & rationale`, `Files & code`, `Commands & outcomes`,
  `Errors & fixes`, `Pending & next step`.

## Install / build

### 安装到 DSH profile（推荐）

通过 GitHub 安装（preset 里使用包名 `dsh-compaction-cacheaware`，不再依赖本地绝对路径）：

```powershell
cd "$env:USERPROFILE\.dsh\profiles\web"
pnpm add dsh-compaction-cacheaware@github:Zhuchen00123/dsh-compaction-cacheaware
```

发布到 npm registry 后可直接：

```powershell
pnpm add dsh-compaction-cacheaware
```

### 本地开发 / 构建

```bash
pnpm install
pnpm build
```

然后在 preset 的 compaction realm 里替换：

```yaml
# - id: compaction-basic
#   name: '@deepseek-ai/dsh-compaction-basic'
- id: compaction-cacheaware
  name: 'dsh-compaction-cacheaware'
  config:
    compactRatio: 0.85
    checkpointCeilingRatio: 0.5
    recentTailRatio: 0.1
    recentTailMinTokens: 32768
    recentTailMaxTokens: 98304
    summaryMaxTokens: 16384
```

如果从源码本地调试，也可以直接用编译产物路径：

```yaml
- id: compaction-cacheaware
  name: 'file:///absolute/path/to/dsh-compaction-cacheaware/lib/index.js'
  config:
    compactRatio: 0.85
    checkpointCeilingRatio: 0.5
    recentTailRatio: 0.1
    recentTailMinTokens: 32768
    recentTailMaxTokens: 98304
    summaryMaxTokens: 16384
```

Keep `@deepseek-ai/dsh-command-compact` in the same realm so `/compact` uses
this backend. The optional `@deepseek-ai/dsh-compaction-tool-result-pruner` can
still be mounted as a sibling; this plugin reads it through `ctx.get()`.

## Configuration

| Key | Default | Meaning |
| --- | --- | --- |
| `compactRatio` | `0.85` | Sole automatic trigger fraction. |
| `checkpointCeilingRatio` | `0.5` | Normal auto-checkpoint acceptance ceiling. |
| `recentTailRatio` | `0.1` | Recent verbatim tail fraction. |
| `recentTailMinTokens` | `32768` | Lower bound for production tail. |
| `recentTailMaxTokens` | `98304` | Upper bound for production tail. |
| `summaryMaxTokens` | `16384` | Summarizer output cap. |
| `exceptionalMinSavingsRatio` | `0.25` | Required savings when fixed prefix exceeds ceiling. |
| `minRecentKeep` | `2` | Minimum recent messages kept. |
| `minCompactMessages` | `2` | Minimum compactable messages. |
| `maxPinnedFirstUserTokens` | `1500` | Pin first user turn if ≤ this. |
| `pinnedFirstUserWindowFrac` | `0.15` | First-user pin window fraction cap. |
| `protocolReserveTokens` | `256` | Framing reserve. |
| `summarizationProvider` / `summarizationModel` | `''` | Optional summary route; defaults to conversation route. |
| `auto` | `true` | Register automatic pressure/overflow listeners. |

## Modularity

- The plugin only registers `ctx.compaction` and its own automatic listeners.
- It does not edit `dsh-wsl-bash`, `dsh-team-dashboard`, `router-opencode-wsl`,
  or any other plugin.
- To use it, mount it in your own preset or profile patch; see
  `cordis.patch.example.yml` in this package.

## Keeping in sync with Reasonix

`scripts/sync-reasonix-compact.mjs` and the GitHub Action in
`.github/workflows/sync-reasonix-compact.yml` watch
`esengine/DeepSeek-Reasonix` and open/update a PR when the upstream compact
implementation changes. The sync job:

1. Fetches the latest `main-v2` Reasonix source.
2. Updates `vendor/reasonix/compact/` with the upstream compact files and
   design docs.
3. Regenerates `src/generated/reasonix-constants.ts` from the Go constants and
   summary prompt (when they change).
4. Commits and opens a PR with a summary of what changed.

The generated constants are imported by this package so tuning values stay
traceable to upstream.

## Publish to GitHub / DSH Workshop

This repository is designed to be published as a standalone public GitHub repo.
The DSH creative workshop discovers public repos with the `dsh-plugin` topic.

```bash
# 1. Authenticate GitHub CLI once
gh auth login

# 2. From this repository root, publish and add workshop topics
./scripts/publish.sh dsh-compaction-cacheaware
```

`scripts/publish.sh` will:

1. Create a public GitHub repo and push this repository.
2. Add `dsh-plugin`, `deepseek-harness`, and `reasonix` topics.

After that, the workshop index at <https://JxaMe.github.io/dsh-workshop/>
will pick it up automatically (it scans `dsh-plugin` topic repositories).

## License

MIT
