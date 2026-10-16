import { expect, test } from "bun:test";

import enUS from "../src/i18n/locales/en-US";
import zhCN from "../src/i18n/locales/zh-CN";
import {
    CANVAS_EDGE_TYPES,
    DEFAULT_EDGE_TYPE,
    contractSignature,
    edgeDisplayLabel,
    edgeStyle,
    edgeTypeLabelKey,
    normalizeEdgeType,
    readEdgeConnection,
} from "../src/lib/canvas/canvas-edge-utils";
import { CANVAS_NODE_STAGES, normalizeStage, stageColor, stageLabelKey } from "../src/lib/canvas/canvas-stage-utils";
import { formatCommitSummary, isAbsoluteRepoPath, readRepoMetadata, repoDisplayName, repoMetadataPatch } from "../src/lib/canvas/repo-node-utils";
import { SERVICE_DEFAULT_HEALTH_PATH, buildHealthUrl, normalizePort, readServiceMetadata, serviceMetadataPatch } from "../src/lib/canvas/service-node-utils";

// --- edge semantics -------------------------------------------------------------------------

test("normalizeEdgeType keeps known types and falls back to flow", () => {
    for (const type of CANVAS_EDGE_TYPES) expect(normalizeEdgeType(type)).toBe(type);
    expect(normalizeEdgeType("depends-on")).toBe("depends-on");
    expect(normalizeEdgeType("nope")).toBe(DEFAULT_EDGE_TYPE);
    expect(normalizeEdgeType(undefined)).toBe("flow");
    expect(normalizeEdgeType(null)).toBe("flow");
    expect(normalizeEdgeType(42)).toBe("flow");
    expect(DEFAULT_EDGE_TYPE).toBe("flow");
});

test("edgeTypeLabelKey maps unknown types onto the flow key", () => {
    expect(edgeTypeLabelKey("http")).toBe("canvas.edge.types.http");
    expect(edgeTypeLabelKey("depends-on")).toBe("canvas.edge.types.depends-on");
    expect(edgeTypeLabelKey("garbage")).toBe("canvas.edge.types.flow");
});

test("edgeStyle returns a distinct color per type and a dashed stroke only for depends-on", () => {
    const flow = edgeStyle("flow");
    const http = edgeStyle("http");
    expect(flow.color).not.toBe(http.color);
    expect(edgeStyle("depends-on").dash).toBeTruthy();
    expect(edgeStyle("flow").dash).toBeUndefined();
    expect(edgeStyle("unknown").color).toBe(flow.color);
});

test("contractSignature requires both method and path", () => {
    expect(contractSignature({ method: "get", path: "/api/users", request: "", response: "", notes: "" })).toBe("GET /api/users");
    expect(contractSignature({ method: "POST", path: " /orders ", request: "", response: "", notes: "" })).toBe("POST /orders");
    expect(contractSignature({ method: "GET", path: "", request: "", response: "", notes: "" })).toBe("");
    expect(contractSignature({ method: "", path: "/x", request: "", response: "", notes: "" })).toBe("");
    expect(contractSignature(null)).toBe("");
});

test("edgeDisplayLabel prefers an explicit label over the contract signature", () => {
    const contract = { method: "get", path: "/health", request: "", response: "", notes: "" };
    expect(edgeDisplayLabel({ label: " 用户查询 ", metadata: { contract } })).toBe("用户查询");
    expect(edgeDisplayLabel({ label: "", metadata: { contract } })).toBe("GET /health");
    expect(edgeDisplayLabel({ label: "", metadata: {} })).toBe("");
    expect(edgeDisplayLabel(null)).toBe("");
});

test("readEdgeConnection normalizes type, label, and contract fields", () => {
    const view = readEdgeConnection({ type: "bogus", label: " x ", metadata: { contract: { method: "post", path: "/y" } } });
    expect(view.type).toBe("flow");
    expect(view.label).toBe("x");
    expect(view.contract.method).toBe("post");
    expect(view.contract.path).toBe("/y");
    expect(view.contract.notes).toBe("");
});

// --- stage badge ----------------------------------------------------------------------------

test("normalizeStage accepts known stages and rejects everything else", () => {
    for (const stage of CANVAS_NODE_STAGES) expect(normalizeStage(stage)).toBe(stage);
    expect(normalizeStage("unknown")).toBeUndefined();
    expect(normalizeStage(undefined)).toBeUndefined();
    expect(normalizeStage(7)).toBeUndefined();
});

test("stageColor and stageLabelKey agree with normalizeStage", () => {
    expect(stageColor("requirement")).toMatch(/^#/);
    expect(stageColor("runtime")).not.toBe(stageColor("requirement"));
    expect(stageLabelKey("design")).toBe("canvas.stage.design");
    expect(stageLabelKey("nope")).toBeNull();
    expect(stageLabelKey(undefined)).toBeNull();
});

// --- repo node ------------------------------------------------------------------------------

test("isAbsoluteRepoPath accepts POSIX, drive-letter, and UNC paths", () => {
    expect(isAbsoluteRepoPath("/Users/me/repo")).toBe(true);
    expect(isAbsoluteRepoPath("C:\\code\\repo")).toBe(true);
    expect(isAbsoluteRepoPath("c:/code/repo")).toBe(true);
    expect(isAbsoluteRepoPath("\\\\host\\share\\repo")).toBe(true);
    expect(isAbsoluteRepoPath("relative/repo")).toBe(false);
    expect(isAbsoluteRepoPath("")).toBe(false);
    expect(isAbsoluteRepoPath("   ")).toBe(false);
});

test("repoDisplayName falls back from name to path basename to repoId", () => {
    expect(repoDisplayName({ name: "My Repo", path: "/tmp/other", repoId: "id-1" })).toBe("My Repo");
    expect(repoDisplayName({ name: "", path: "/Users/me/projects/alpha", repoId: "id-1" })).toBe("alpha");
    expect(repoDisplayName({ name: "", path: "", repoId: "id-1" })).toBe("id-1");
});

test("formatCommitSummary compacts sha to seven chars and keeps the subject", () => {
    expect(formatCommitSummary({ sha: "0123456789abcdef", subject: "fix: bug" })).toBe("0123456 fix: bug");
    expect(formatCommitSummary({ sha: "abc", subject: "" })).toBe("abc");
    expect(formatCommitSummary({ sha: "", subject: "orphan subject" })).toBe("orphan subject");
    expect(formatCommitSummary(null)).toBe("");
});

test("readRepoMetadata and repoMetadataPatch round-trip cleanly", () => {
    const state = readRepoMetadata({ repo: { repoId: " id ", name: "n", path: "/p", isGit: true, branch: "main", dirty: true, lastCommit: "abc1234 msg" } });
    expect(state.repoId).toBe("id");
    expect(state.isGit).toBe(true);
    expect(state.dirty).toBe(true);

    const patch = repoMetadataPatch(state, { dirty: false });
    expect(patch.dirty).toBeUndefined();
    expect(patch.branch).toBe("main");
    const empty = repoMetadataPatch(readRepoMetadata({ repo: {} }));
    expect(Object.values(empty).every((value) => value === undefined)).toBe(true);
});

// --- service node ---------------------------------------------------------------------------

test("normalizePort accepts 1..65535 integers and rejects everything else", () => {
    expect(normalizePort(5173)).toBe(5173);
    expect(normalizePort("8080")).toBe(8080);
    expect(normalizePort(" 3000 ")).toBe(3000);
    expect(normalizePort(0)).toBeNull();
    expect(normalizePort(65536)).toBeNull();
    expect(normalizePort(-1)).toBeNull();
    expect(normalizePort(1.5)).toBeNull();
    expect(normalizePort("abc")).toBeNull();
    expect(normalizePort("")).toBeNull();
    expect(normalizePort(undefined)).toBeNull();
});

test("buildHealthUrl defaults to '/' and normalizes the leading slash", () => {
    expect(buildHealthUrl(5173)).toBe("http://127.0.0.1:5173/");
    expect(buildHealthUrl(5173, "")).toBe("http://127.0.0.1:5173/");
    expect(buildHealthUrl("5173", "health")).toBe("http://127.0.0.1:5173/health");
    expect(buildHealthUrl(5173, "/health")).toBe("http://127.0.0.1:5173/health");
    expect(SERVICE_DEFAULT_HEALTH_PATH).toBe("/");
});

test("buildHealthUrl returns an empty string without a valid port", () => {
    expect(buildHealthUrl(null)).toBe("");
    expect(buildHealthUrl(undefined, "/health")).toBe("");
    expect(buildHealthUrl(0, "/health")).toBe("");
    expect(buildHealthUrl(70000, "/health")).toBe("");
    expect(buildHealthUrl("nope", "/health")).toBe("");
});

test("readServiceMetadata defaults status to probing and drops invalid ports", () => {
    const state = readServiceMetadata({ service: { name: " api ", port: "9000", healthPath: "health", status: "ready" } });
    expect(state.name).toBe("api");
    expect(state.port).toBe(9000);
    expect(state.status).toBe("ready");

    const fallback = readServiceMetadata({ service: { port: "bogus", status: "weird" } });
    expect(fallback.port).toBeNull();
    expect(fallback.status).toBe("probing");
});

test("serviceMetadataPatch drops empties and preserves valid status", () => {
    const state = readServiceMetadata({ service: { name: "api", port: 9000, healthPath: "/health", status: "ready" } });
    const patch = serviceMetadataPatch(state, { name: "" });
    expect(patch.name).toBeUndefined();
    expect(patch.port).toBe(9000);
    expect(patch.status).toBe("ready");
});

// --- i18n parity ----------------------------------------------------------------------------

function flattenKeys(value: unknown, prefix = ""): string[] {
    if (typeof value !== "object" || value === null) return [prefix];
    return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => flattenKeys(child, prefix ? `${prefix}.${key}` : key));
}

const zhKeys = new Set(flattenKeys(zhCN));
const enKeys = new Set(flattenKeys(enUS));

test("zh-CN and en-US expose exactly the same key paths", () => {
    const onlyZh = [...zhKeys].filter((key) => !enKeys.has(key));
    const onlyEn = [...enKeys].filter((key) => !zhKeys.has(key));
    expect(onlyZh).toEqual([]);
    expect(onlyEn).toEqual([]);
});

test("every M6 i18n key exists in both locales", () => {
    const required = [
        "canvas.nodeTypes.repo",
        "canvas.nodeTypes.service",
        "canvas.edge.title",
        "canvas.edge.type",
        "canvas.edge.label",
        "canvas.edge.labelPlaceholder",
        "canvas.edge.contract",
        "canvas.edge.method",
        "canvas.edge.path",
        "canvas.edge.request",
        "canvas.edge.response",
        "canvas.edge.notes",
        "canvas.edge.close",
        ...CANVAS_EDGE_TYPES.map((type) => `canvas.edge.types.${type}`),
        ...CANVAS_NODE_STAGES.map((stage) => `canvas.stage.${stage}`),
        "canvas.repo.description",
        "canvas.repo.bindTitle",
        "canvas.repo.selectRepo",
        "canvas.repo.switchRepo",
        "canvas.repo.refresh",
        "canvas.repo.loadingRepos",
        "canvas.repo.manualPathPlaceholder",
        "canvas.repo.register",
        "canvas.repo.registering",
        "canvas.repo.registerFailed",
        "canvas.repo.absolutePathRequired",
        "canvas.repo.notConnected",
        "canvas.repo.clean",
        "canvas.repo.dirty",
        "canvas.repo.noCommit",
        "canvas.service.description",
        "canvas.service.name",
        "canvas.service.port",
        "canvas.service.portPlaceholder",
        "canvas.service.portRequired",
        "canvas.service.healthPath",
        "canvas.service.healthPathPlaceholder",
        "canvas.service.probing",
        "canvas.service.ready",
        "canvas.service.failed",
        "canvas.service.retry",
        "canvas.service.untitled",
        "canvas.service.noTarget",
    ];
    expect(required.filter((key) => !zhKeys.has(key))).toEqual([]);
    expect(required.filter((key) => !enKeys.has(key))).toEqual([]);
});
