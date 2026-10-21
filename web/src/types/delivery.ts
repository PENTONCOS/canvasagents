// M0: delivery domain entities (dev plan §1.1 of canvasagents-开发方案-M0.md).
// Entities are the source of truth; canvas nodes are views that reference them by id.

export type AcStatus = "draft" | "ready" | "failing" | "passing" | "blocked";

export type TestCaseResult = "pass" | "fail" | "skip";

export type DeliveryTestCase = {
    id: string;
    acId: string;
    title: string;
    file?: string; // test file path
    selector?: string; // test name / tag anchor ("@AC-04")
    lastResult?: TestCaseResult;
};

export type AcceptanceCriterion = {
    id: string; // "AC-04", unique within project
    statement: string;
    journeyIds: string[];
    stepIds: string[];
    testCaseIds: string[];
    status: AcStatus;
    lastRunId?: string;
    nodeId?: string; // canvas view node
};

// --- M1: journey & design variant ------------------------------------------------------------

export type Journey = {
    id: string; // "J-01"
    title: string;
    requirementId?: string; // requirement node/entity id this journey derives from
    stepIds: string[];
    nodeId?: string; // canvas view node
};

export type JourneyStep = {
    id: string; // "J-01-S1"
    journeyId: string;
    order: number;
    title: string;
    nodeId?: string; // canvas view node (journey.step)
};

export type DesignVariant = {
    id: string; // "D-01-A"
    journeyId?: string;
    label: string; // "A" | "B" | "C"
    style?: string; // free-form palette/layout note
    selected: boolean; // at most one selected per journey
    nodeId?: string; // canvas view node (design)
};

/** 旅程下的步骤 id：J-01 -> J-01-S1 / S2 …（按已有编号顺延）。 */
export function nextStepId(journeyId: string, existing: string[]): string {
    const re = new RegExp(`^${journeyId}-S(\\d+)$`);
    let max = 0;
    for (const id of existing) {
        const match = re.exec(id);
        if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    }
    return `${journeyId}-S${max + 1}`;
}

/** 设计版本 id：D-01 + A/B/C…（按已有编号顺延到下一个字母）。 */
export function nextVariantId(existing: string[]): string {
    const re = /^D-(\d+)-([A-Z])$/;
    let maxSeq = 0;
    let used = new Set<string>();
    for (const id of existing) {
        const match = re.exec(id);
        if (!match) continue;
        maxSeq = Math.max(maxSeq, Number.parseInt(match[1], 10));
        used.add(match[2]);
    }
    const seq = maxSeq || 1;
    const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
    const label = letters.find((letter) => !used.has(letter)) || "A";
    return `D-${String(seq).padStart(2, "0")}-${label}`;
}

export type BugSeverity = "P0" | "P1" | "P2" | "P3";

export type BugStatus = "open" | "fixing" | "fixed" | "verified" | "wontfix";

export type DeliveryBug = {
    id: string; // "BUG-03", unique within project
    title: string;
    severity: BugSeverity;
    violates: string[]; // AC ids
    repro?: string;
    status: BugStatus;
    fixRunIds: string[];
    nodeId?: string;
};

export type VerificationRunStatus = "running" | "passed" | "failed" | "error";

export type DeliveryRun = {
    id: string;
    kind: "test" | "deploy";
    command: string;
    cwd: string;
    startedAt: string;
    finishedAt?: string;
    status: VerificationRunStatus;
    results: { acId?: string; testCaseId?: string; result: TestCaseResult; message?: string }[];
    logsPath?: string;
    envId?: string;
};

export type DeliveryEnvironment = {
    id: string;
    name: string; // "staging" | "production" | custom
    url: string;
    version?: string;
    status: "unknown" | "healthy" | "unhealthy";
    deployedAt?: string;
    nodeId?: string;
};

// --- AC state machine ----------------------------------------------------------------------

// Allowed transitions: draft -> ready; ready -> passing|failing|blocked; failing -> passing|blocked;
// passing -> failing|blocked|ready; blocked -> ready|failing|passing.
// ready -> passing 允许：回归用例首次运行就可能通过，若强制先红再绿，AC 永远无法从 ready 变绿。
// 「必须先失败」属于运行级约束（一次运行里从未出现过失败 → 该次运行可疑），由运行器判定，不在 AC 状态机里。
const AC_TRANSITIONS: Record<AcStatus, AcStatus[]> = {
    draft: ["ready"],
    ready: ["passing", "failing", "blocked"],
    failing: ["passing", "blocked"],
    passing: ["failing", "blocked", "ready"],
    blocked: ["ready", "failing", "passing"],
};

export function canTransitionAc(from: AcStatus, to: AcStatus): boolean {
    return from === to || AC_TRANSITIONS[from].includes(to);
}

export function transitionAc(current: AcStatus, to: AcStatus): { ok: true; status: AcStatus } | { ok: false; error: string } {
    if (!canTransitionAc(current, to)) {
        return { ok: false, error: `illegal AC transition ${current} -> ${to}` };
    }
    return { ok: true, status: to };
}

// Human-readable AC/BUG id allocation: max existing numeric suffix + 1, padded to 2 digits.
export function nextEntityId(existing: string[], prefix: string): string {
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    let max = 0;
    for (const id of existing) {
        const match = re.exec(id);
        if (match) max = Math.max(max, Number.parseInt(match[1], 10));
    }
    return `${prefix}-${String(max + 1).padStart(2, "0")}`;
}
