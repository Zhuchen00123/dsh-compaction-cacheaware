# 维护手册

本目录是 `dsh-compaction-cacheaware` 插件的唯一维护位置。

## 日常维护

### 1. 修改插件源码

```bash
cd compaction-reasonix
# 修改 src/ 下的 TS 文件
pnpm typecheck
pnpm build
```

### 2. 同步 Reasonix 上游更新

```bash
cd compaction-reasonix
node scripts/sync-reasonix-compact.mjs
```

脚本会：

1. 拉取 `esengine/DeepSeek-Reasonix` 的 `main-v2`；
2. 更新 `vendor/reasonix/compact/`；
3. 重新生成 `src/generated/reasonix-constants.ts`；
4. 如果 constants/prompt 有变化，需要手动 review 并提交。

GitHub Action `.github/workflows/sync-reasonix-compact.yml` 每周日 03:00 UTC
运行，也支持手动触发，并会在本仓库 `main` 有 push 时运行。同步后先验证
typecheck、build 和 tests，再根据 `git status --porcelain --untracked-files=all`
判断是否有变化；该判断包含新增的未跟踪快照文件。有变化时创建或更新 PR。

### 3. 发布到 GitHub

```bash
cd compaction-reasonix
gh auth login        # 如果还没登录
./scripts/publish.sh dsh-compaction-cacheaware
```

脚本会创建 public repo、push，并添加 `dsh-plugin` / `deepseek-harness` / `reasonix`
三个 topic，DSH 创意工坊会自动扫描 `dsh-plugin` topic。

## 设计约束

- **不侵入其他插件**：本插件只注册 `ctx.compaction` 和自身监听器。
- **canonical transcript 不 rewrite**：DSH session log 是事实源，surface replace
  只改变 model-visible projection。
- **有界 summary 尝试**：每次事务按候选 provider/model 有界尝试，
  `invalid_prompt` 时回退到 provider-neutral transcript；不引入无界 retry 循环。
- **缓存友好**：summarizer 请求 replay conversation prefix，尽量复用 provider KV cache。

## 已知近似

DSH 的 surface `replace` 只能替换一个连续区间，因此 Reasonix 的
“在 projection 中保留中间 user turn / error message”能力被近似为：

- 不单独保留 fold 区域中间的散点消息，整个 fold 区间一次性进入 summary。

上游在 `2a2dbbea` 之后也收紧了策略：`pinnedPrefixLen` 只保留 system message，
旧的 first-user-turn pin、kept-user-turn、`[[keep]]` 保护层已删除，因此
`[[keep]]` user turn 与 error tool result 现在**随 fold 区间一起进入 summary**，
不再被移入 recent tail。

如果后续需要完全等价，需要扩展 DSH compaction seam 或实现多段 replace。

## 与上游保持同步

`scripts/sync-reasonix-compact.mjs` 每次运行都会：刷新 `vendor/reasonix/compact/`、
重写 `src/generated/reasonix-constants.ts`、生成
`docs/UPSTREAM_SYNC_REPORT.md`。它不再因为上游结构变化而**静默产零改动**——
之前那种行为会让 CI 不开 PR，导致 vendor 快照腐烂数周而无人察觉。

- 文件清单由上游目录**自动发现**（`internal/agent/compact*.go` / `context*.go`，
  排除 `_test.go`），新增文件会被自动纳入。
- 上游删除的常量进入 `REASONIX_UPSTREAM_REMOVED_CONSTANTS`，并保留最后的本地值
  仅为让包能编译；**必须人工决定是删除概念还是从新设计重新推导**。
- 无 git 网络时可用 `--from <dir>` 指向已抓取的上游树。

同步候选文件目前是在 `internal/agent/` 根目录匹配
`compact*.go` / `context*.go`，排除 `_test.go`；不要把 Action PR 描述理解成
“兼容性门禁会跳过上游结构变化”。结构变化也会进入快照和 drift report，合并前
仍需人工判断 DSH 侧是否要迁移这些机制。

## npm 发版流程

`scripts/publish-npm.sh` 接受一个固定目标版本，例如 `0.2.0`；不会 bump 版本，
也不会自行创建 commit、tag 或 push。运行前必须：

1. 将 `package.json` 版本设为目标值并提交完整 release tree；tag commit 必须含
   `src/`、`lib/`、`tests/`、`docs/`、`vendor/reasonix/compact/` 和 bundle patch；
2. 将 release branch 推送，并将对应 `vX.Y.Z` tag 推送到同一 GitHub remote；
3. 确认当前工作区 clean，再运行该脚本。

脚本会先检查 local/remote branch 与 tag 是否都指向当前完整提交，再运行
typecheck、build、test 和 npm pack dry-run，最后才调用 `npm publish`。这样 npm 发布
之前已经验证 release commit 与 Git push/tag 状态；发布后没有 Git 操作。
所有 npm 命令默认使用仓库忽略的 `.tmp/npm-cache`，绕过本机只读全局 cache；可用
`NPM_RELEASE_CACHE` 指定其他可写目录。

## 发布检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] `pnpm test` 通过（selection + DSH engine integration scenarios）
- [ ] `npm pack --dry-run --json` 的文件清单包含 `lib/` 入口与 migration guide
- [ ] npm tarball 的 `lib/` 已由当前 `src/` 构建，且 release commit 包含完整
      `src/`、测试、文档、patch 和上游快照
- [ ] `docs/UPSTREAM_SYNC_REPORT.md` 的漂移项已人工处理；不要为普通 release
      重新运行会重写 vendor snapshot 的 sync 脚本
- [ ] README 已更新
- [ ] `npm whoami` 成功，目标版本尚未发布
- [ ] release branch 已 push，`vX.Y.Z` tag 已 push，且两者指向同一 release commit
- [ ] `./scripts/publish-npm.sh X.Y.Z` 所有预检通过后才执行 npm publish
