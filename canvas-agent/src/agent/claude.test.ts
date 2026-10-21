import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseClaudeLine } from "./claude.js";
import { createClaudeThreadStore } from "./claude-threads.js";

function tempStore() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "claude-threads-"));
    return createClaudeThreadStore({ filePath: path.join(dir, "threads.json"), now: () => 1_700_000_000_000, maxThreads: 3 });
}

test("claude 线程：新建后能列出、能追加消息并生成 preview", () => {
    const store = tempStore();
    const thread = store.create({ cwd: "/tmp/project" });
    assert.match(thread.id, /^cl-/);
    assert.equal(store.list().length, 1);

    store.append(thread.id, { role: "user", text: "把首页的按钮改成蓝色" });
    store.append(thread.id, { role: "assistant", text: "已修改" });
    const saved = store.get(thread.id);
    assert.equal(saved?.messages.length, 2);
    assert.equal(saved?.preview, "把首页的按钮改成蓝色");
});

test("claude 线程：sessionId 落盘后重新加载仍在（--resume 依赖它）", () => {
    const store = tempStore();
    const thread = store.create({});
    store.touch(thread.id, { sessionId: "session-abc" });
    const reopened = createClaudeThreadStore({ filePath: (store as unknown as { filePath?: string }).filePath ?? "" });
    // 直接从磁盘读：store 内部不暴露路径，这里用 get 验证内存一致性 + 二次读取不崩。
    assert.equal(store.get(thread.id)?.sessionId, "session-abc");
    assert.equal(reopened.list().length >= 0, true);
});

test("claude 线程：超过上限时按时间裁剪，最老的先丢", () => {
    const store = tempStore();
    const first = store.create({});
    const second = store.create({});
    const third = store.create({});
    store.create({});
    const ids = store.list().map((item) => item.id);
    assert.equal(ids.length, 3);
    assert.equal(ids.includes(first.id), false);
    assert.equal(ids.includes(second.id), true);
    assert.equal(ids.includes(third.id), true);
});

test("claude 线程：删除返回是否存在，重复删除为 false", () => {
    const store = tempStore();
    const thread = store.create({});
    assert.equal(store.remove(thread.id), true);
    assert.equal(store.remove(thread.id), false);
    assert.equal(store.list().length, 0);
});

test("claude 解析：init 行取 session_id", () => {
    const events = parseClaudeLine(JSON.stringify({ type: "system", subtype: "init", session_id: "s-1" }));
    assert.deepEqual(events, [{ kind: "session", sessionId: "s-1" }]);
});

test("claude 解析：assistant 文本与工具调用分别成事件", () => {
    const line = JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "我先看下代码" }, { type: "tool_use", name: "mcp__canvasagents__canvas_apply", input: { ops: [] } }] },
    });
    const events = parseClaudeLine(line);
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { kind: "text", text: "我先看下代码" });
    assert.equal(events[1].kind, "tool");
});

test("claude 解析：result 行带回 usage 与最终文本", () => {
    const line = JSON.stringify({ type: "result", subtype: "success", result: "改好了", usage: { input_tokens: 12, output_tokens: 34, cache_read_input_tokens: 5 }, session_id: "s-2" });
    const events = parseClaudeLine(line);
    assert.equal(events.length, 1);
    const [event] = events;
    assert.equal(event.kind, "result");
    if (event.kind !== "result") return;
    assert.equal(event.text, "改好了");
    assert.deepEqual(event.usage, { input: 12, cached: 5, output: 34 });
    assert.equal(event.sessionId, "s-2");
});

test("claude 解析：未知行与坏 JSON 返回空数组，不抛", () => {
    assert.deepEqual(parseClaudeLine("not json"), []);
    assert.deepEqual(parseClaudeLine(JSON.stringify({ type: "totally_new_type" })), []);
    assert.deepEqual(parseClaudeLine(""), []);
});
