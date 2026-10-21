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

// Allowed transitions: draft -> ready; ready -> failing|blocked; failing -> passing|blocked;
// passing -> failing|blocked|ready; blocked -> ready|failing|passing.
const AC_TRANSITIONS: Record<AcStatus, AcStatus[]> = {
    draft: ["ready"],
    ready: ["failing", "blocked"],
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
