# CanvasAgents

> 画布即产品的 Agent 工作台：把「指挥 agent 干活 → 过程可见 → 结果可见」全部收进一张无限画布，做成沉浸式的单端完整体验。

## 这是什么

一张无限画布，同时是三种东西：

1. **多模态创作工作台** —— 文字 / 图片 / 视频 / 音频节点 + 生成流 + 参考图混合 + 图像编辑（裁剪/放大/遮罩/多图融合），AI 请求由浏览器直连你自己配置的 API，不过服务器
2. **Agent 的手和脚** —— 内置 [canvas-agent](./canvas-agent) 桥接 Codex app-server，暴露 34 个画布 MCP 工具（建节点/连线/批量排版/生成流编排…），agent 的每一步产出实时落成画布节点
3. **研发工作台** —— 终端 window、节点级操作时间线、网页实时预览节点、任务队列聚合，见[设计文档](./docs/immersive-redesign.md)

## 仓库结构

```
web/           前端（React + Vite + TypeScript + antd + zustand）
canvas-agent/  本地 agent 桥（Node/TS，SSE + token 鉴权，桥接 Codex app-server）
canvas-proxy/  本地 API 代理（Node/TS，解决浏览器直连跨域/CORS）
docs/          设计文档（immersive-redesign.md 为当前改造蓝图）
```

## 快速开始

前置：Node 20+；Codex CLI 已登录（agent 功能需要，纯画布使用不需要）

```bash
# 前端
cd web
bun install        # 或 npm install / pnpm install
npm run dev        # http://localhost:3000

# 本地 agent 桥（可选，画布单独用不需要）
cd canvas-agent
npm install
npm run dev        # 127.0.0.1:17371
```

前端 `设置 → Agent` 填入 `http://127.0.0.1:17371`（token 首连自动发现），即可在画布里指挥 agent。

## 开发命令

| 位置 | 命令 | 说明 |
|---|---|---|
| `web/` | `npm run dev` / `npm run build` / `npm run typecheck` | 开发 / 构建 / 类型检查 |
| `web/` | `bun test` | 单测（bun） |
| `canvas-agent/` | `npm run dev` / `npm run build` / `npm test` | 桥服务开发 / 构建 / 测试 |
| `canvas-proxy/` | 见 `canvas-proxy/package.json` | 本地代理开发 / 构建 |

## Docker

```bash
docker compose up -d          # 本地构建并启动，http://localhost:3000
```

## 路线图

M1–M3（沉浸式骨架 / 配置下沉 / 命令面板与直连）已落地，M4/M5 进行中。
完整 M1-M5 规划与验收标准见 [docs/immersive-redesign.md](./docs/immersive-redesign.md)。

## 许可

[MIT](./LICENSE)。本项目基于上游 infinite-canvas（MIT）二次开发演进，保留原版权致谢。
