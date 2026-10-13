# 自动部署（CanvasAgents）

push 到 `main` 即自动构建并发布到 **https://canvas-agents.surge.sh**。

## 两条腿（互补）

### 1. 本机事件驱动钩子（毫秒级）
- launchd 常驻 `ai.canvasagents.autodeploy` 运行 `~/rea-lab/bin/canvasagents-watch.js`。
- 用 `fs.watch` 监听 `.git/refs/heads`、`.git/refs/remotes/origin`、`.git/HEAD`、`.git/packed-refs`；
  事件去抖 2.5s 后调用 `~/rea-lab/bin/canvasagents-autodeploy.sh`。
- 另装 git `post-commit` / `post-merge` 钩子，本地提交即触发。
- 部署脚本仅当 HEAD 在 `main` 且工作区干净时动作，并带并发锁（`~/rea-lab/.autodeploy.lock`）。

### 2. GitHub Actions（跨机器）
- `.github/workflows/deploy-surge.yml`：`push` 到 `main` 触发，`workflow_dispatch` 可手动重发。
- 需要仓库 secret `SURGE_TOKEN`（Surge 账号 token）；未设置时该步骤自动跳过（不报错）。

```bash
homebrew: npx surge token        # 查看当前 Surge token
```

## 手动部署（兜底）

```bash
cd web && pnpm install && pnpm build
npx --yes surge dist canvas-agents.surge.sh
```

## 日志

- `~/rea-lab/logs/canvasagents-watch.log`
- `~/rea-lab/logs/canvasagents-autodeploy.log`

## 注意：SURGE_TOKEN 必须是 Surge token（32 位）

- Surge token = 32 位十六进制（`npx surge token` 可查；也可读 `~/.netrc` 中 `machine surge.surge.sh` 的 password）。
- 不要填 GitHub PAT（`ghp_…`，40 位）；否则 CI 报 `Invalid token`。
