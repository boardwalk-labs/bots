export interface Review {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: { severity: "blocker" | "major" | "minor"; file: string; note: string }[];
}

export function reviewBody(r: Review, filesReviewed: number): string {
  const findings = r.findings.length === 0
    ? "_No findings._"
    : r.findings.map((f) => `- **${f.severity}** \`${f.file}\`: ${f.note}`).join("\n");
  return [
    `### Automated review: ${r.verdict === "approve" ? "looks good" : "changes suggested"}`,
    ``,
    r.summary,
    ``,
    `Reviewed ${String(filesReviewed)} changed file(s).`,
    ``,
    `**Findings**`,
    findings,
    ``,
    `_Posted by the Boardwalk PR reviewer (non-blocking)._`,
  ].join("\n");
}