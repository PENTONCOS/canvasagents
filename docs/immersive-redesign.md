# CanvasAgents 沉浸式改造 — 设计开发文档

> 版本 v1.0 · 2026-10-12 · 基线：CanvasAgents 独立演进分支 + canvas-agent 0.6.0（本地源码构建，launchd 常驻）
> 目标用户：少爷（单用户，桌面端优先；多端监控后置）

---

## 1. 背景与问题

现有底子（继承自 MIT 许可的既有代码）画布能力强，但产品形态偏离了「沉浸式创作工作台」：

| 问题 | 现状证据 |
|---|---|
| 入口过多 | 8 个平级路由：`/`、`/image`、`/video`、`/assets`、`/prompts`、`/canvas`、`/canvas/:id`、`/config` |
| 配置上浮 | Agent 面板裸露 地址/token/模型/推理力度/权限模式；API key 散落 image/video 各自页面 |
| 干活不可见 | agent 干活只有日志 tab，没有「哪个节点它在动、做了什么」的时间线 |
| 效果不可见 | 生成的网页要去外部浏览器看，心流断裂 |

对齐目标：canvasagents.dev 的核心体验——**画布即产品，指挥、过程、结果全在一张画布里**。

## 2. 产品原则

1. **唯一入口**：进站即画布。生成/素材/Prompt 都是画布内的能力，不是平级页面。
2. **配置三级下沉**：首次向导（一次性）→ ⌘K 命令面板（功能入口）→ 设置抽屉（专业参数，平时不可见）。
3. **一切皆节点**：agent 的每一步产出都落节点；节点状态徽章 + 时间线可见；网页产出 iframe 预览。
4. **零配置开始**：本机 agent（127.0.0.1:17371）默认自动连接，不填地址不填 token。

## 3. 里程碑与工作量

| # | 里程碑 | 内容 | 验收标准 | 工作量 |
|---|---|---|---|---|
| **M1** | 沉浸式骨架 | 路由收敛（进站即画布）、首次向导、⌘K 面板、配置抽屉、零配置直连 | 新开浏览器 → 3 步内开始第一次 agent 对话；无任何专业字段可见 | 2-3 晚 |
| **M2** | 终端 window | tmux 会话管理 + ttyd iframe 节点 + 每画布绑定 window + codex approval 流 | 画布内开 2 个 window 并行跑 codex 任务，权限确认在画布内完成 | 1-2 晚 |
| **M3** | 节点时间线 | agent 事件 → 节点元数据；节点侧栏「它做了什么」 | 让 agent 建一个生成流，每个节点可回放操作序列 | 1 晚 |
| **M4** | 网页预览节点 | dev server 探测 + iframe 实时预览 + 「截图投喂回 agent」 | agent 改代码 → 预览节点自动刷新 → 截图作为上下文继续投喂 | 1 晚 |
| **M5** | 任务队列聚合 | 跨画布任务状态页（等待输入/权限确认/干活中/空闲） | 同时跑 3 个任务，队列页一眼看出谁在等谁 | 1 晚 |
| 后置 | 多端监控 | Tailscale + ntfy 推送（原 P1/P2 方案整体平移） | 手机看到同一队列 | 待桌面闭环后 |

依赖关系：M2 依赖 M1 的画布内 UI 骨架；M3/M4 并行；M5 依赖 M2 的会话模型。

## 4. M1 详细设计（本次开工）

### 4.1 路由收敛

```
现状：8 个平级路由
目标：
  /                → 重定向到 /canvas（或上次的画布）
  /canvas/:id      → 主工作台（唯一页面）
  /image /video /assets /prompts → 删除页面，能力并入画布（重定向兼容旧链接）
  /config          → 改为抽屉组件（Drawer），不再占路由
```

改动点：`web/src/router.tsx`、删除 `pages/{image,video,assets,prompts,home}`、`layouts/user-layout` 侧边导航收敛为画布项目列表。

### 4.2 首次运行向导（一次性）

触发条件：`localStorage` 无 `ic_onboarded` 标记。
步骤（单屏完成，不做多步向导）：
1. 填一个 AI API key（或跳过——只用本机 agent 则不需要）
2. 显示本机 agent 状态：`canvas-agent 运行中 ✓`（launchd 常驻，自动连接）
3. 「开始创作」按钮 → 进入画布，写入 `ic_onboarded`

### 4.3 ⌘K 命令面板

- 新组件 `CommandPalette`，挂全局 keydown（⌘K / Ctrl+K）
- 命令源：新建节点（文本/图片/视频/音频/配置/分组）、新建终端 window（M2 后）、打开设置、切换画布、投喂选中内容给 agent
- 依托：cmdk 或自实现（项目已有 radix-ui 依赖族，优先 cmdk）

### 4.4 配置抽屉

- `ConfigPage` 的内容迁入 `SettingsDrawer`（右侧抽屉）
- Agent 面板专业字段（模型/推理力度/权限模式/地址/token）移入抽屉的「Agent」分区
- 默认值策略：地址 `http://127.0.0.1:17371`，token 自动从 agent 侧取（已有本机 token 发放机制），模型取引擎默认

### 4.5 零配置直连

`LocalAgentPanel` 已支持 `autoConnect` prop——在画布页挂载时以 `autoConnect` 模式常驻右下角指挥入口；连接状态用小圆点呈现（绿=已连，黄=等待，红=断开），**不弹任何配置框**。

## 5. M2-M5 技术要点（概要）

- **M2 终端**：agent 侧新增 `/tmux` 管理 API（new/list/attach）；ttyd 编译进 launchd 依赖（或 brew 安装）；画布侧新节点类型 `plugin:terminal:window`（iframe 指向 ttyd 端口，按画布 ID 绑定 tmux session 名 `canvas-<id>-<n>`）
- **M2 本机 Codex 生图入口（B 方案，低耦合）**：生图面板新增独立入口「用本机 Codex 生图」，**仅在探测到 canvas-agent 在线时显示**；取当前提示词（可选参考图）透传给 canvas-agent，触发一个 agent 回合调用 Codex 内置 `imagegen`，结果由 agent 经现有 `canvas_*` 工具落回当前画布节点。透传参数：`prompt`、比例/尺寸、参考图（可选，UI 标注支持范围）、落点（选中节点/新节点）。
  - **边界（刻意不做）**：不进模型选择器；不改 `image.ts` 的同步 HTTP 语义；不实现批量出图/取消。UI 明确标注「本机 Codex · 慢」，与渠道生图（快）分开展示——两种生成器代价不同，不混进同一个下拉框。
  - **验收**：入口可见性依赖 canvas-agent 健康探测；一次成功生成并落入画布节点；渠道生图路径零回归。
  - **备选 C（暂不做）**：独立 generation backend 抽象（`channel` 同步 / `local-agent` 异步），模型选择器按 backend 分组、异步路径带进度态——仅当「本机 Codex 生图」升级为卖点级能力时再投入。
- **M3 时间线**：canvas-agent 的 SSE 事件流里已含 tool call 事件；按 `nodeId` 关联落 `node.metadata.timeline[]`（截断保留最近 50 条）
- **M4 预览**：agent 侧探测 workspace 内 `npm run dev` 端口（解析 vite/next 输出）；前端 iframe 节点 + 手动「截图」按钮（html2canvas 或 CDP）→ 转 attachment 投喂
- **M5 队列**：agent 侧聚合所有 thread 状态（已有 threads + eventLogs 数据源），新增 `/queue` API；前端全局队列页（可从 ⌘K 进入）

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| 删除页面导致旧链接/书签失效 | 全部 301 式重定向到画布 |
| ttyd/tmux 依赖安装失败 | 回退方案：仅 terminal iframe 面板（不进画布节点体系） |
| iframe 预览 X-Frame-Options 拦截 | 本地 dev server 默认无此头；如遇则加代理路径 |
| agent token 自动发放的安全边界 | 仅绑 127.0.0.1 回环 + Origin 白名单（已预置），公网域名访问时仍要求手动 token |

## 7. 工程规约

- 提交纪律：每里程碑一串原子 commit，消息格式 `feat(m1): ...`
- 质量红线：TypeScript strict 不降级；不用 `as any`/`@ts-ignore`；改完跑 `pnpm build` + 现有 tests
- 部署验证：本地 3000 端口刷新即见（vite HMR）；launchd 服务不动
- 回归底线：现有画布功能（生成流/参考图/图像编辑/插件）零破坏

## 8. 当前状态

- [x] Git 仓库初始化，首次 commit `b480280`（506 文件）
- [x] GitHub 远程推送（`origin` = `git@github.com:PENTONCOS/canvasagents.git`，SSH 认证已通；已推至 `110cf73`——原「阻塞」记录系 repo/remote 建立前的陈旧结论，`gh` CLI 未装不影响 SSH push）
- [x] 本设计文档
- [ ] M1 开工
