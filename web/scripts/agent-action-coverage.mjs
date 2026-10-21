/**
 * 结构性检查：store 里的每个动作，界面上是否真有入口。
 *
 * 起因：`renameWindow` 在 store 里完整实现了，界面上 0 个引用——会话窗永远改不了名。
 * 单测测的是 store 纯逻辑，tsc 只看类型，build 照样通过，没有任何一道门禁会发现
 * 「功能写好了但没人能点到」。这个脚本专门盯这一种缺口。
 *
 * 判定标准：
 * - 动作 = AgentStore 类型里以函数形式声明的字段；
 * - 入口 = 该动作名出现在 src/components 或 src/pages 里（用户能点到的地方）；
 * - 只在 store/lib 内部调用而界面确实不需要的，必须写进 INTERNAL_ONLY 并给出理由。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STORE_FILE = join(ROOT, "src/stores/use-agent-store.ts");
const UI_DIRS = [join(ROOT, "src/components"), join(ROOT, "src/pages")];

/** 确实是内部调用、界面不需要单独入口的动作。新增条目必须写清理由。 */
const INTERNAL_ONLY = new Map([
    ["disconnectAgent", "由 clearAgentSession / 连接开关内部调用，界面入口是同一个「连接设置」按钮"],
    ["noteWindowOutput", "SSE 收到输出时由事件处理写入未读，属于数据流副作用，不该有按钮"],
    ["addEventLog", "写日志属于运行时副作用，界面上对应的是只读的「日志」tab"],
    ["addMessage", "追加消息由 SSE/发送流程调用，界面入口是输入框本身"],
    ["setAgentState", "通用的底层 setter，界面通过具体动作间接使用，不单独暴露"],
]);

function walk(dir, out = []) {
    // 目录可能被改名或裁剪掉；缺目录不该让整个检查崩在 readdirSync 上
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir)) {
        const target = join(dir, entry);
        const stat = statSync(target);
        if (stat.isDirectory()) walk(target, out);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(target);
    }
    return out;
}

function collectActions() {
    const source = readFileSync(STORE_FILE, "utf8");
    const start = source.indexOf("type AgentStore = {");
    if (start < 0) throw new Error("没找到 AgentStore 类型定义");
    const end = source.indexOf("\n};", start);
    const block = source.slice(start, end);
    const actions = [];
    for (const line of block.split("\n")) {
        // 只取「字段名: (...) => 返回值」这种函数声明，状态字段没有箭头函数
        const match = line.match(/^\s{4}(\w+):\s*(<[^>]+>)?\s*\([^)]*\)\s*=>/);
        if (match) actions.push(match[1]);
    }
    return [...new Set(actions)].sort();
}

function countUiEntries(action) {
    const pattern = new RegExp(`\\b${action}\\b`);
    const hits = [];
    for (const dir of UI_DIRS) {
        for (const file of walk(dir)) {
            if (pattern.test(readFileSync(file, "utf8"))) hits.push(relative(ROOT, file));
        }
    }
    return hits;
}

const actions = collectActions();
if (!actions.length) {
    console.error("一个动作都没解析出来，说明解析规则跟 store 的写法对不上了");
    process.exitCode = 1;
}

const missing = [];
const internal = [];
const covered = [];

for (const action of actions) {
    const hits = countUiEntries(action);
    if (hits.length) covered.push({ action, hits });
    else if (INTERNAL_ONLY.has(action)) internal.push({ action, reason: INTERNAL_ONLY.get(action) });
    else missing.push(action);
}

const pad = (text, width) => text.padEnd(width, " ");
const width = Math.max(...actions.map((action) => action.length));

console.log(`store 动作 ${actions.length} 个：界面有入口 ${covered.length} / 内部专用 ${internal.length} / 缺失 ${missing.length}\n`);
for (const { action, hits } of covered) console.log(`  ✓ ${pad(action, width)}  ${hits.length} 处，例如 ${hits[0]}`);
for (const { action, reason } of internal) console.log(`  - ${pad(action, width)}  内部专用：${reason}`);

if (missing.length) {
    console.log("\n以下动作在 store 里有实现，但界面上没有任何引用——用户点不到：");
    for (const action of missing) console.log(`  ✗ ${action}`);
    console.log("\n修法二选一：补 UI 入口；或确认它是内部副作用，写进 scripts/agent-action-coverage.mjs 的 INTERNAL_ONLY 并给出理由。");
    process.exitCode = 1;
} else {
    console.log("\n全部动作都有去处。");
}
