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

// --- M3: annotation (screenshot markup) ------------------------------------------------------

export type AnnotationShape = "rect" | "arrow";

/**
 * 截图圈注。坐标统一归一化到 0..1（相对所属图片节点），
 * 这样节点缩放、画布缩放、换分辨率都不会让圈注跑位。
 */
export type DeliveryAnnotation = {
    id: string; // "AN-01"
    nodeId: string; // 所属图片节点
    shape: AnnotationShape;
    from: { x: number; y: number };
    to: { x: number; y: number };
    label: number; // 画布内递增编号（1,2,3…），对应截图上的数字标记
    acId?: string; // 圈注针对的验收标准
    bugId?: string; // 由该圈注生成的问题单
    note?: string;
    createdAt: number;
};

export function clampNormalized(value: number): number {
    if (!Number.isFinite(value)) return 0;
    return Math.min(1, Math.max(0, value));
}

/** 归一化坐标 → 节点内像素矩形（左上角 + 宽高，保证非负）。 */
export function annotationRect(
    annotation: Pick<DeliveryAnnotation, "from" | "to">,
    size: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
    const x1 = clampNormalized(annotation.from.x) * size.width;
    const y1 = clampNormalized(annotation.from.y) * size.height;
    const x2 = clampNormalized(annotation.to.x) * size.width;
    const y2 = clampNormalized(annotation.to.y) * size.height;
    return {
        x: Math.min(x1, x2),
        y: Math.min(y1, y2),
        width: Math.abs(x2 - x1),
        height: Math.abs(y2 - y1),
    };
}

/** 下一个圈注编号：画布内 1 开始递增，删除中间编号也不复用，避免截图与单号错位。 */
export function nextAnnotationLabel(existing: number[]): number {
    return existing.reduce((max, value) => (Number.isFinite(value) && value > max ? value : max), 0) + 1;
}

/** 由圈注生成问题单标题：编号 + 违反的 AC，保证每个问题单都能追溯到验收标准。 */
export function annotationBugTitle(annotation: Pick<DeliveryAnnotation, "label" | "acId" | "note">): string {
    const note = annotation.note?.trim();
    if (note) return note;
    if (annotation.acId) return `#${annotation.label} 违反 ${annotation.acId}`;
    return `#${annotation.label} 圈注问题`;
}
