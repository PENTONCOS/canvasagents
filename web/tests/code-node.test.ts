import { expect, test } from "bun:test";

import {
    baseName,
    classifyDiffLine,
    codeMetadataPatch,
    detectLanguageName,
    diffStats,
    formatBytes,
    isAbsoluteRepoPath,
    mergeTreeEntries,
    parseUnifiedDiff,
    readCodeMetadata,
    repoRelativePath,
    scopeTreeEntries,
    sortTreeEntries,
    type CodeTreeEntry,
} from "../src/lib/canvas/code-node-utils";

const SAMPLE_DIFF = [
    "diff --git a/src/app.ts b/src/app.ts",
    "index 1111111..2222222 100644",
    "--- a/src/app.ts",
    "+++ b/src/app.ts",
    "@@ -1,3 +1,4 @@",
    " const keep = 1;",
    "-const removed = 2;",
    "+const added = 3;",
    "+const extra = 4;",
].join("\n");

test("reads metadata.code with safe defaults and rejects an unknown view", () => {
    expect(readCodeMetadata(undefined)).toEqual({ repoId: "", rootPath: "", activePath: "", view: "tree" });
    expect(readCodeMetadata({ code: { view: "file" } })).toEqual({ repoId: "", rootPath: "", activePath: "", view: "file" });
    expect(readCodeMetadata({ code: { repoId: " r1 ", rootPath: " /tmp/repo ", activePath: " src/a.ts ", view: "diff" } })).toEqual({
        repoId: "r1",
        rootPath: "/tmp/repo",
        activePath: "src/a.ts",
        view: "diff",
    });
    // A canvas edited by hand may carry a stale view value; fall back instead of crashing.
    expect(readCodeMetadata(JSON.parse('{"code":{"view":"preview"}}')).view).toBe("tree");
});

test("writes metadata.code without empty strings so unbound state round-trips", () => {
    const unbound = codeMetadataPatch({ repoId: "r1", rootPath: "/tmp/repo", activePath: "src/a.ts", view: "file" }, { repoId: "", rootPath: "", activePath: "", view: "tree" });
    expect(unbound).toEqual({ repoId: undefined, rootPath: undefined, activePath: undefined, view: "tree" });
    const bound = codeMetadataPatch({ repoId: "", rootPath: "", activePath: "", view: "tree" }, { repoId: "r2", rootPath: "/tmp/other" });
    expect(bound).toEqual({ repoId: "r2", rootPath: "/tmp/other", activePath: undefined, view: "tree" });
});

test("detects absolute repository paths and normalizes repo-relative ones", () => {
    expect(isAbsoluteRepoPath(" /tmp/repo ")).toBe(true);
    expect(isAbsoluteRepoPath("C:\\repo")).toBe(true);
    expect(isAbsoluteRepoPath("\\\\server\\share")).toBe(true);
    expect(isAbsoluteRepoPath("relative/dir")).toBe(false);
    expect(isAbsoluteRepoPath("")).toBe(false);

    expect(repoRelativePath("/src/./app.ts/")).toBe("src/app.ts");
    expect(repoRelativePath("./src/app.ts")).toBe("src/app.ts");
    expect(repoRelativePath("\\src\\app.ts")).toBe("src/app.ts");
    expect(repoRelativePath(".")).toBe("");
    expect(repoRelativePath("")).toBe("");
    expect(baseName("src/components/app.tsx")).toBe("app.tsx");
});

test("sorts directories first and merges lazy directory loads idempotently", () => {
    const entries: CodeTreeEntry[] = [
        { path: "src/zeta.ts", name: "zeta.ts", type: "file" },
        { path: "README.md", name: "README.md", type: "file" },
        { path: "src", name: "src", type: "dir" },
        { path: "apps", name: "apps", type: "dir" },
        { path: "src/alpha.ts", name: "alpha.ts", type: "file" },
    ];
    const sorted = sortTreeEntries(entries);
    expect(sorted.map((entry) => entry.path)).toEqual(["apps", "src", "src/alpha.ts", "README.md", "src/zeta.ts"]);
    expect(sorted).not.toBe(entries);

    const firstLoad: CodeTreeEntry[] = [{ path: "src", name: "src", type: "dir" }];
    const secondLoad: CodeTreeEntry[] = [
        { path: "src", name: "src", type: "dir" },
        { path: "lib", name: "lib", type: "dir" },
    ];
    const merged = mergeTreeEntries(firstLoad, secondLoad);
    expect(merged.map((entry) => entry.path)).toEqual(["lib", "src"]);
    expect(mergeTreeEntries(merged, secondLoad)).toHaveLength(2);
});

test("scopes a directory listing to repo-relative paths either way the agent answers", () => {
    // Contract shape: /repo/tree already returns repo-relative paths.
    const repoRelative = scopeTreeEntries([{ path: "src/app.ts", name: "app.ts", type: "file" }], "src");
    expect(repoRelative).toEqual([{ path: "src/app.ts", name: "app.ts", type: "file", size: undefined }]);

    // Tolerated shape: paths relative to the requested directory get the prefix added once.
    const requestRelative = scopeTreeEntries(
        [
            { path: "app.ts", type: "file" },
            { path: "components", type: "dir" },
            { path: "src/nested.ts", type: "file" },
        ],
        "src",
    );
    expect(requestRelative.map((entry) => entry.path)).toEqual(["src/app.ts", "src/components", "src/nested.ts"]);
    expect(scopeTreeEntries([{ path: "src", name: "src", type: "dir" }], "src")).toEqual([{ path: "src", name: "src", type: "dir", size: undefined }]);
    // Root listings never gain a prefix.
    expect(scopeTreeEntries([{ path: "README.md", name: "README.md", type: "file" }], "")[0].path).toBe("README.md");
});

test("classifies unified diff lines and counts additions and removals", () => {
    expect(classifyDiffLine("+++ b/src/app.ts")).toBe("meta");
    expect(classifyDiffLine("--- a/src/app.ts")).toBe("meta");
    expect(classifyDiffLine("@@ -1,3 +1,4 @@")).toBe("hunk");
    expect(classifyDiffLine("index 1111111..2222222 100644")).toBe("meta");
    expect(classifyDiffLine("+const added = 3;")).toBe("add");
    expect(classifyDiffLine("-const removed = 2;")).toBe("del");
    expect(classifyDiffLine(" const keep = 1;")).toBe("context");

    const lines = parseUnifiedDiff(SAMPLE_DIFF);
    expect(lines).toHaveLength(9);
    expect(lines[0]).toEqual({ kind: "meta", text: "diff --git a/src/app.ts b/src/app.ts" });
    expect(diffStats(lines)).toEqual({ added: 2, removed: 1 });

    expect(parseUnifiedDiff("")).toEqual([]);
    expect(parseUnifiedDiff("   \n")).toEqual([]);
    expect(parseUnifiedDiff("+one\r\n-two\r\n")).toEqual([
        { kind: "add", text: "+one" },
        { kind: "del", text: "-two" },
    ]);
});

test("labels common source files and formats byte sizes", () => {
    expect(detectLanguageName("src/app.tsx")).toBe("TSX");
    expect(detectLanguageName("py/main.py")).toBe("Python");
    expect(detectLanguageName("go.mod")).toBe("");
    expect(detectLanguageName("Dockerfile")).toBe("Docker");
    expect(detectLanguageName("README")).toBe("");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(formatBytes(undefined)).toBe("");
});
