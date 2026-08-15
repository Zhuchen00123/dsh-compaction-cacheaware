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

GitHub Action `.github/workflows/sync-reasonix-compact.yml` 会每 6 小时自动跑一次，
有变化时自动开 PR。

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
- **单次 summary 事务**：不引入 application-layer retry 循环。
- **缓存友好**：summarizer 请求 replay conversation prefix，尽量复用 provider KV cache。

## 已知近似

DSH 的 surface `replace` 只能替换一个连续区间，因此 Reasonix 的
“在 projection 中保留中间 user turn / error message”能力被近似为：

- 将 `[[keep]]` user turn / error tool result 移入 recent tail；
- 不单独保留 fold 区域中间的散点消息。

如果后续需要完全等价，需要扩展 DSH compaction seam 或实现多段 replace。

## 发布检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm build` 通过
- [ ] `node scripts/sync-reasonix-compact.mjs` 可运行
- [ ] README 已更新
- [ ] `gh auth status` 已登录
- [ ] `./scripts/publish.sh dsh-compaction-cacheaware` 成功
- [ ] GitHub repo 有 `dsh-plugin` topic
