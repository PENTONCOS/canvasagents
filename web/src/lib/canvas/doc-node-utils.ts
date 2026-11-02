export const DOC_NODE_TYPE = "doc";

/**
 * F4: 文档节点的分节排版（对齐参考产品的 Spec Doc：左边目录、右边一节一节往下排）。
 *
 * 分节规则刻意简单、可预测：
 * ・Markdown 的一级/二级标题开新节（`#` / `##`），其余行归到当前节正文；
 * ・标题前的行归到「前言」节，不为它编造标题；
 * ・没有标题时整篇算一节，标题留空由界面兜底显示；
 * ・空节不保留，避免目录里出现一排没内容的条目。
 */
export type DocSection = { id: string; title: string; body: string };

const HEADING = /^#{1,2}\s+(.+?)\s*$/;

export function splitDocSections(text: string): DocSection[] {
    const lines = text.split(/\r?\n/);
    const sections: DocSection[] = [];
    let current: DocSection | null = null;
    let preamble: string[] = [];

    for (const line of lines) {
        const heading = HEADING.exec(line);
        if (heading) {
            if (current) sections.push(current);
            else if (preamble.join("\n").trim()) sections.push({ id: "preamble", title: "", body: preamble.join("\n").trim() });
            preamble = [];
            current = { id: `s${sections.length + 1}`, title: heading[1], body: "" };
            continue;
        }
        if (current) current.body = current.body ? `${current.body}\n${line}` : line;
        else preamble.push(line);
    }

    if (current) sections.push(current);
    else if (preamble.join("\n").trim()) sections.push({ id: "s1", title: "", body: preamble.join("\n").trim() });

    return sections
        .map((section) => ({ ...section, body: section.body.trim() }))
        .filter((section) => section.title.trim() || section.body);
}

export function docOutline(sections: DocSection[]): { id: string; title: string; index: number }[] {
    return sections.map((section, index) => ({ id: section.id, title: section.title, index: index + 1 }));
}

/** 目录用：没有标题的节用「第 N 节」占位，不让目录里出现空行。 */
export function docSectionLabel(section: DocSection, index: number): string {
    return section.title.trim() || `第 ${index + 1} 节`;
}

export function docStats(sections: DocSection[]): { sections: number; chars: number } {
    return {
        sections: sections.filter((section) => section.title.trim() || section.body.trim()).length,
        chars: sections.reduce((sum, section) => sum + section.body.replace(/\s/g, "").length, 0),
    };
}
