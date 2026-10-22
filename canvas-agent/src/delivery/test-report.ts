/**
 * M2: 测试报告解析（Playwright / Vitest JSON）。
 *
 * 判定原则：AC 不是靠人手工勾选的，而是靠用例标题/标签里的 `@AC-04` 锚点回填。
 * 这里只做纯函数解析，不跑测试、不读文件——运行器与文件读取由调用方负责，
 * 这样解析规则可以单独单测，换运行器也不用重写状态机。
 */

export type ParsedTestResult = {
    acId?: string;
    title: string;
    result: "pass" | "fail" | "skip";
    message?: string;
    /** 用例所在文件；报告里没写就是空。只用于回指，不参与判定。 */
    file?: string;
};

const AC_TAG = /@(AC-\d+)/g;

/** 从任意文本（标题、标签、注解）里抽取 AC 编号，去重且保持出现顺序。 */
export function extractAcIds(...texts: (string | undefined)[]): string[] {
    const found: string[] = [];
    for (const text of texts) {
        if (!text) continue;
        for (const match of text.matchAll(AC_TAG)) {
            const id = match[1];
            if (!found.includes(id)) found.push(id);
        }
    }
    return found;
}

/** Playwright JSON reporter 输出 → 扁平结果。 */
export function parsePlaywrightReport(report: unknown): ParsedTestResult[] {
    const results: ParsedTestResult[] = [];
    const visitSuite = (suite: unknown, inheritedFile = "") => {
        if (!suite || typeof suite !== "object") return;
        const node = suite as Record<string, unknown>;
        const suiteFile = typeof node.file === "string" && node.file ? node.file : inheritedFile;
        const specs = Array.isArray(node.specs) ? node.specs : [];
        for (const rawSpec of specs) {
            if (!rawSpec || typeof rawSpec !== "object") continue;
            const spec = rawSpec as Record<string, unknown>;
            const title = typeof spec.title === "string" ? spec.title : "";
            const tags = Array.isArray(spec.tags) ? spec.tags.filter((tag): tag is string => typeof tag === "string") : [];
            const acIds = extractAcIds(title, ...tags);
            const status = specStatus(spec);
            const message = specErrorMessage(spec);
            const file = typeof spec.file === "string" && spec.file ? spec.file : suiteFile;
            const entry: ParsedTestResult = { title, result: status, ...(message ? { message } : {}), ...(file ? { file } : {}) };
            if (acIds.length === 0) results.push(entry);
            // 一条用例覆盖多条 AC 时，每条 AC 各记一份结果（覆盖率才不会被漏算）。
            for (const acId of acIds) results.push({ ...entry, acId });
        }
        const suites = Array.isArray(node.suites) ? node.suites : [];
        for (const child of suites) visitSuite(child, suiteFile);
    };
    if (report && typeof report === "object") {
        const root = report as Record<string, unknown>;
        if (Array.isArray(root.suites)) for (const suite of root.suites) visitSuite(suite);
    }
    return results;
}

function specStatus(spec: Record<string, unknown>): ParsedTestResult["result"] {
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    let sawSkip = false;
    for (const rawTest of tests) {
        if (!rawTest || typeof rawTest !== "object") continue;
        const test = rawTest as Record<string, unknown>;
        const status = typeof test.status === "string" ? test.status : undefined;
        if (status === "unexpected" || status === "failed") return "fail";
        if (status === "skipped") sawSkip = true;
        const runResults = Array.isArray(test.results) ? test.results : [];
        for (const rawResult of runResults) {
            if (!rawResult || typeof rawResult !== "object") continue;
            const resultStatus = (rawResult as Record<string, unknown>).status;
            if (resultStatus === "failed" || resultStatus === "timedOut" || resultStatus === "interrupted") return "fail";
            if (resultStatus === "skipped") sawSkip = true;
        }
    }
    if (spec.ok === true) return "pass";
    if (spec.ok === false) return "fail";
    return sawSkip ? "skip" : "pass";
}

function specErrorMessage(spec: Record<string, unknown>): string | undefined {
    const tests = Array.isArray(spec.tests) ? spec.tests : [];
    for (const rawTest of tests) {
        if (!rawTest || typeof rawTest !== "object") continue;
        const runResults = Array.isArray((rawTest as Record<string, unknown>).results) ? ((rawTest as Record<string, unknown>).results as unknown[]) : [];
        for (const rawResult of runResults) {
            if (!rawResult || typeof rawResult !== "object") continue;
            const error = (rawResult as Record<string, unknown>).error;
            if (error && typeof error === "object") {
                const message = (error as Record<string, unknown>).message;
                if (typeof message === "string" && message.trim()) return message.trim();
            }
        }
    }
    return undefined;
}

/** Vitest JSON reporter 输出 → 扁平结果。 */
export function parseVitestReport(report: unknown): ParsedTestResult[] {
    const results: ParsedTestResult[] = [];
    if (!report || typeof report !== "object") return results;
    const root = report as Record<string, unknown>;
    const testResults = Array.isArray(root.testResults) ? root.testResults : [];
    for (const rawFile of testResults) {
        if (!rawFile || typeof rawFile !== "object") continue;
        const assertions = Array.isArray((rawFile as Record<string, unknown>).assertionResults)
            ? ((rawFile as Record<string, unknown>).assertionResults as unknown[])
            : [];
        for (const rawAssertion of assertions) {
            if (!rawAssertion || typeof rawAssertion !== "object") continue;
            const assertion = rawAssertion as Record<string, unknown>;
            const title = typeof assertion.fullName === "string"
                ? assertion.fullName
                : typeof assertion.title === "string" ? assertion.title : "";
            const ancestors = Array.isArray(assertion.ancestorTitles)
                ? assertion.ancestorTitles.filter((item): item is string => typeof item === "string")
                : [];
            const acIds = extractAcIds(title, ...ancestors);
            const status = assertion.status === "passed" ? "pass" : assertion.status === "failed" ? "fail" : "skip";
            const failureMessages = Array.isArray(assertion.failureMessages)
                ? assertion.failureMessages.filter((item): item is string => typeof item === "string")
                : [];
            const file = typeof (rawFile as Record<string, unknown>).name === "string" ? String((rawFile as Record<string, unknown>).name) : "";
            const entry: ParsedTestResult = { title, result: status, ...(failureMessages.length ? { message: failureMessages[0] } : {}), ...(file ? { file } : {}) };
            if (acIds.length === 0) results.push(entry);
            for (const acId of acIds) results.push({ ...entry, acId });
        }
    }
    return results;
}

export type ReportType = "playwright" | "vitest";

/**
 * 按报告类型分发。放在这里而不是 http 路由里，是因为「Vitest 报告长什么样」
 * 属于解析知识，不该让路由层知道。
 */
export function parseReport(type: ReportType, report: unknown): ParsedTestResult[] {
    return type === "vitest" ? parseVitestReport(report) : parsePlaywrightReport(report);
}

/** 未知类型不静默当成 Playwright：静默兜底会把 Vitest 报告解析成 0 条结果，看起来像「全绿」。 */
export function isReportType(value: string): value is ReportType {
    return value === "playwright" || value === "vitest";
}

/**
 * 汇总到 AC 粒度：任一失败即失败（回归没通过就不能算绿），
 * 否则有通过即通过，全跳过则跳过。
 */
export function summarizeAcResults(results: ParsedTestResult[]): { acId: string; result: "pass" | "fail" | "skip" }[] {
    const merged = new Map<string, "pass" | "fail" | "skip">();
    for (const item of results) {
        if (!item.acId) continue;
        const previous = merged.get(item.acId);
        if (previous === "fail" || item.result === "fail") merged.set(item.acId, "fail");
        else if (previous === "pass" || item.result === "pass") merged.set(item.acId, "pass");
        else merged.set(item.acId, "skip");
    }
    return [...merged.entries()].map(([acId, result]) => ({ acId, result }));
}
