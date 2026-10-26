import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOpencodeLine } from "./opencode.js";

test("解析会话 id 事件", () => {
    const events = parseOpencodeLine('{"type":"session","sessionID":"ses_abc"}');
    assert.deepEqual(events, [{ kind: "session", sessionId: "ses_abc" }]);
});

test("错误事件透传 CLI 的原始信息，不编造成功", () => {
    const events = parseOpencodeLine('{"type":"error","sessionID":"ses_1","error":{"name":"UnknownError","data":{"message":"Unexpected server error"}}}');
    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { kind: "session", sessionId: "ses_1" });
    assert.deepEqual(events[1], { kind: "error", message: "Unexpected server error" });
});

test("文本与增量事件按类型映射", () => {
    assert.deepEqual(parseOpencodeLine('{"type":"text","text":"完成"}'), [{ kind: "text", text: "完成" }]);
    assert.deepEqual(parseOpencodeLine('{"type":"assistant_delta","text":"你"}'), [{ kind: "delta", text: "你" }]);
});

test("工具事件带名字", () => {
    const events = parseOpencodeLine('{"type":"tool_use","name":"bash","input":{"cmd":"ls"}}');
    assert.deepEqual(events, [{ kind: "tool", name: "bash", input: { cmd: "ls" } }]);
});

test("非 JSON 行被忽略，不抛", () => {
    assert.deepEqual(parseOpencodeLine("not json"), []);
    assert.deepEqual(parseOpencodeLine(""), []);
});
