import path from "node:path";

import { CONFIG_DIR } from "../config.js";
import { createClaudeThreadStore } from "./claude-threads.js";

/**
 * WO-06: OpenCode 的线程存储。
 * OpenCode CLI 每次 `run` 都是独立进程，续聊要带 `--session <id>`；
 * sessionId 与消息摘要必须由桥端自己落盘，否则切换 driver 后只剩空白。
 * 存储结构与 Claude 完全一致，直接复用同一份工厂，避免两份重复实现。
 */
export const opencodeThreadStore = createClaudeThreadStore({ filePath: path.join(CONFIG_DIR, "opencode-threads.json") });
