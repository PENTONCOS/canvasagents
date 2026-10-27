import assert from "node:assert/strict";
import { test } from "node:test";

import { getSkillPreset, SKILL_PRESETS } from "./presets.js";

test("三套流程 Skill 都在，id 与名称唯一", () => {
    assert.deepEqual(SKILL_PRESETS.map((preset) => preset.id), ["feature", "develop", "bug"]);
    const names = SKILL_PRESETS.map((preset) => preset.name);
    assert.equal(new Set(names).size, names.length);
});

test("每套都覆盖质量三角三问，且短描述符合面板长度", () => {
    for (const preset of SKILL_PRESETS) {
        for (const keyword of ["定义正确", "验证正确", "失败可恢复"]) {
            assert.ok(preset.instructions.includes(keyword), `${preset.id} 缺少 ${keyword}`);
        }
        assert.ok(preset.shortDescription.length >= 25 && preset.shortDescription.length <= 64, `${preset.id} 短描述长度 ${preset.shortDescription.length}`);
        assert.ok(preset.defaultPrompt.length > 0);
    }
});

test("按 id 取预设返回同一对象，未知 id 返回 undefined", () => {
    assert.equal(getSkillPreset("bug")?.name, "canvas-bug-fix");
    assert.equal(getSkillPreset("nope" as never), undefined);
});
