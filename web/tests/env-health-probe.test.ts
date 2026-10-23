import { describe, expect, test } from "bun:test";

import {
    ENV_HEALTH_COLOR,
    ENV_PROBE_INTERVAL_MS,
    envHealthFromProbe,
    envHealthLabelKey,
    envHealthMetadataPatch,
    formatHttpStatus,
    formatProbeClock,
    portFromUrl,
    probeEnvironmentHealth,
    readEnvHealth,
    resolveEnvProbeTarget,
    type ProbeFetch,
} from "@/lib/delivery/health-probe";

/**
 * G3：环境节点健康探测的纯函数与状态映射。
 * 这里不碰 DOM：目标解析、HTTP 码 → 三态、时间格式化、旧 metadata 兼容、探测失败分类。
 */

describe("探测目标解析（复用 buildHealthUrl 语义）", () => {
    test("显式端口 + 缺省健康路径 → 127.0.0.1:port/", () => {
        const target = resolveEnvProbeTarget({ envHealthPort: 5173 });
        expect(target.port).toBe(5173);
        expect(target.healthPath).toBe("/");
        expect(target.url).toBe("http://127.0.0.1:5173/");
    });

    test("健康路径没有前导斜杠时自动补上", () => {
        expect(resolveEnvProbeTarget({ envHealthPort: 8080, envHealthPath: "health" }).url).toBe("http://127.0.0.1:8080/health");
    });

    test("没有显式端口时从回环 URL 推导端口", () => {
        expect(portFromUrl("http://127.0.0.1:3100")).toBe(3100);
        expect(resolveEnvProbeTarget({ url: "http://localhost:4100/app", envHealthPath: "/health" }).url).toBe("http://127.0.0.1:4100/health");
    });

    test("显式端口优先于 URL 里的端口", () => {
        expect(resolveEnvProbeTarget({ url: "http://127.0.0.1:3100", envHealthPort: 5100 }).port).toBe(5100);
    });

    test("公网域名不探测，也不编造目标 URL", () => {
        expect(portFromUrl("https://staging.example.com")).toBeNull();
        const target = resolveEnvProbeTarget({ url: "https://staging.example.com" });
        expect(target.port).toBeNull();
        expect(target.url).toBe("");
    });

    test("非法端口视为没有端口", () => {
        expect(resolveEnvProbeTarget({ envHealthPort: 70000 }).url).toBe("");
        expect(resolveEnvProbeTarget({ envHealthPort: "abc" }).url).toBe("");
    });
});

describe("探测结果 → 三态", () => {
    const at = "2026-10-23T11:05:07.000Z";

    test("200 健康并保留状态码", () => {
        const health = envHealthFromProbe({ checkedAt: at, httpStatus: 200 });
        expect(health).toEqual({ status: "healthy", httpStatus: 200, checkedAt: at });
    });

    test("3xx 也算可达", () => {
        expect(envHealthFromProbe({ checkedAt: at, httpStatus: 302 }).status).toBe("healthy");
    });

    test("5xx 不健康，错误里带真实状态码", () => {
        const health = envHealthFromProbe({ checkedAt: at, httpStatus: 503 });
        expect(health.status).toBe("unhealthy");
        expect(health.httpStatus).toBe(503);
        expect(health.error).toBe("HTTP 503");
    });

    test("网络错误不健康，保留原始原因", () => {
        const health = envHealthFromProbe({ checkedAt: at, error: "Failed to fetch" });
        expect(health.status).toBe("unhealthy");
        expect(health.error).toBe("Failed to fetch");
    });

    test("没有状态码也没有错误（no-cors 回退）按可达处理，不假造 200", () => {
        const health = envHealthFromProbe({ checkedAt: at });
        expect(health.status).toBe("healthy");
        expect(health.httpStatus).toBeUndefined();
    });

    test("非法状态码不会写成 HTTP 0", () => {
        expect(envHealthFromProbe({ checkedAt: at, httpStatus: 0 }).httpStatus).toBeUndefined();
        expect(formatHttpStatus(0)).toBe("");
        expect(formatHttpStatus(200)).toBe("HTTP 200");
    });
});

describe("metadata 向后兼容", () => {
    test("旧节点没有 envHealth 字段 → null，不抛错", () => {
        expect(readEnvHealth(undefined)).toBeNull();
        expect(readEnvHealth({})).toBeNull();
        expect(readEnvHealth({ url: "http://127.0.0.1:3100", envVersion: "v1" })).toBeNull();
    });

    test("脏数据（状态不在三态里）→ null", () => {
        expect(readEnvHealth({ envHealth: { status: "weird" } })).toBeNull();
        expect(readEnvHealth({ envHealth: "healthy" })).toBeNull();
        expect(readEnvHealth({ envHealth: null })).toBeNull();
    });

    test("缺 checkedAt 的旧记录仍能读出状态，不补造时间", () => {
        const health = readEnvHealth({ envHealth: { status: "unhealthy", error: "HTTP 500" } });
        expect(health?.status).toBe("unhealthy");
        expect(health?.checkedAt).toBe("");
        expect(health?.error).toBe("HTTP 500");
    });

    test("写回时丢掉空错误与非法状态码，避免在 metadata 里留空字段", () => {
        const patch = envHealthMetadataPatch({ status: "healthy", checkedAt: "2026-10-23T11:05:07.000Z", error: "   " });
        expect(patch.envHealth.status).toBe("healthy");
        expect(patch.envHealth.error).toBeUndefined();
        expect(patch.envHealth.httpStatus).toBeUndefined();
        expect(readEnvHealth(patch)).toEqual({ status: "healthy", httpStatus: undefined, checkedAt: "2026-10-23T11:05:07.000Z", error: undefined });
    });
});

describe("展示辅助", () => {
    test("最近探测时间格式化为本地 HH:MM:SS", () => {
        const local = new Date(2026, 9, 23, 19, 5, 7);
        expect(formatProbeClock(local.toISOString())).toBe("19:05:07");
    });

    test("没有时间或时间非法 → 空串（UI 显示「尚未探测」）", () => {
        expect(formatProbeClock(undefined)).toBe("");
        expect(formatProbeClock("not-a-date")).toBe("");
        expect(formatProbeClock("")).toBe("");
    });

    test("三态配色与 service 节点同一套语义，标签键可翻译", () => {
        expect(ENV_HEALTH_COLOR.healthy).toBe("#22c55e");
        expect(ENV_HEALTH_COLOR.unhealthy).toBe("#ef4444");
        expect(ENV_HEALTH_COLOR.probing).toBe("#a8a29e");
        expect(envHealthLabelKey("healthy")).toBe("canvas.node.delivery.envHealth.healthy");
        expect(ENV_PROBE_INTERVAL_MS).toBe(30_000);
    });
});

describe("探测执行（注入 fetch，不碰网络）", () => {
    const okFetch: ProbeFetch = async () => ({ status: 200 });
    const failFetch: ProbeFetch = async () => {
        throw new TypeError("Failed to fetch");
    };

    test("成功时带回状态码", async () => {
        const outcome = await probeEnvironmentHealth("http://127.0.0.1:17399/probe-target", { fetchImpl: okFetch });
        expect(outcome.httpStatus).toBe(200);
        expect(outcome.error).toBeUndefined();
        expect(outcome.checkedAt).toBeTruthy();
    });

    test("CORS 失败后退回 no-cors 仍可达 → 不判失败", async () => {
        const calls: Array<"cors" | "no-cors"> = [];
        const fetchImpl: ProbeFetch = async (_url, init) => {
            calls.push(init.mode === "no-cors" ? "no-cors" : "cors");
            if (init.mode !== "no-cors") throw new TypeError("Failed to fetch");
            return { status: 0 };
        };
        const outcome = await probeEnvironmentHealth("http://127.0.0.1:17399/probe-target", { fetchImpl });
        expect(calls).toEqual(["cors", "no-cors"]);
        expect(outcome.error).toBeUndefined();
        expect(outcome.httpStatus).toBeUndefined();
    });

    test("两次都失败 → network，保留原因", async () => {
        const outcome = await probeEnvironmentHealth("http://127.0.0.1:17399/probe-target", { fetchImpl: failFetch });
        expect(outcome.failure).toBe("network");
        expect(outcome.error).toBe("Failed to fetch");
        expect(envHealthFromProbe(outcome).status).toBe("unhealthy");
    });

    test("超时由 SERVICE_PROBE_TIMEOUT_MS 语义控制（注入短超时）", async () => {
        const hanging: ProbeFetch = (_url, init) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
        const outcome = await probeEnvironmentHealth("http://127.0.0.1:17399/probe-target", { fetchImpl: hanging, timeoutMs: 5 });
        expect(outcome.failure).toBe("timeout");
        expect(envHealthFromProbe(outcome).error).toBe("timeout");
    });

    test("外部 abort（组件卸载）立即中止，不等到超时", async () => {
        const hanging: ProbeFetch = (_url, init) =>
            new Promise((_resolve, reject) => {
                init.signal.addEventListener("abort", () => reject(new Error("aborted")));
            });
        const controller = new AbortController();
        const pending = probeEnvironmentHealth("http://127.0.0.1:17399/probe-target", { fetchImpl: hanging, timeoutMs: 60_000, signal: controller.signal });
        controller.abort();
        expect((await pending).failure).toBe("aborted");
    });

    test("没有探测目标时不发请求，直接给 no-target", async () => {
        let called = false;
        const outcome = await probeEnvironmentHealth("", {
            fetchImpl: async () => {
                called = true;
                return { status: 200 };
            },
        });
        expect(called).toBe(false);
        expect(outcome.failure).toBe("no-target");
        expect(envHealthFromProbe(outcome).status).toBe("unhealthy");
    });
});
