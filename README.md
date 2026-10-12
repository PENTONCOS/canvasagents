# CanvasAgents · 画布即产品的 Agent 工作台

> 基于 [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) (v0.20.0, MIT) 二次开发。
> 目标：把「指挥 coding agent 干活 → 过程可见 → 结果可见」全部收进一张无限画布，做成沉浸式的单端完整体验。

## 这是什么

一张无限画布，同时是三种东西：

1. **多模态创作工作台** —— 文字 / 图片 / 视频 / 音频节点 + 生成流 + 参考图混合 + 图像编辑（裁剪/放大/遮罩/多图融合），AI 请求由浏览器直连你自己配置的 API，不过服务器
2. **Agent 的手和脚** —— 内置 [canvas-agent](./canvas-agent) 桥接 Codex app-server，暴露 34 个画布 MCP 工具（建节点/连线/批量排版/生成流编排…），agent 的每一步产出实时落成画布节点
3. **研发工作台**（建设中）—— 终端 window、节点级操作时间线、网页实时预览节点、任务队列聚合，见[设计文档](./docs/immersive-redesign.md)

## 仓库结构

```
web/          前端（React + Vite + TypeScript + antd + zustand）
canvas-agent/ 本地 agent 桥（Node/TS，SSE + token 鉴权，桥接 Codex app-server）
plugins/      画布插件（markdown/sticky-note/html/svg/template/panorama + Codex app 插件）
docs/         设计与开发文档（immersive-redesign.md 为当前改造蓝图）
```

## 快速开始

前置：Node 20+、pnpm（前端）、Codex CLI 已登录（agent 功能需要）

```bash
# 前端
cd web
pnpm install
pnpm dev            # http://localhost:3000

# agent 桥（可选，画布单独用不需要）
cd canvas-agent
npm install
npm run dev         # 127.0.0.1:17371
```

前端 `设置 → Agent` 填入 `http://127.0.0.1:17371`（token 首连自动发现），即可在画布里指挥 agent。

## 开发命令

| 位置 | 命令 | 说明 |
|---|---|---|
| `web/` | `pnpm dev` / `pnpm build` / `pnpm typecheck` | 开发 / 构建 / 类型检查 |
| `web/` | `bun test` | 单测（bun） |
| `canvas-agent/` | `npm run dev` / `npm run build` / `npm test` | 桥服务开发 / 构建 / 测试 |

## 路线图

当前处于 **M1（沉浸式骨架）** 改造中：进站即画布、配置三级下沉、⌘K 命令面板、agent 零配置直连。
完整 M1-M5 规划与验收标准见 [docs/immersive-redesign.md](./docs/immersive-redesign.md)。

## 许可与致谢

- 本仓库遵循 [MIT](./LICENSE)；原始版权与致谢归 [basketikun](https://github.com/basketikun/infinite-canvas) 及其贡献者
- 与上游的差异（沉浸式改造、agent 深度集成等）在本仓库内维护，不向上游 PR
