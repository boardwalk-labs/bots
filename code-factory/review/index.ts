// code-factory-review — the quality gate: a skeptical reviewer who did not write the code.
//
// This is the "checker" half of the maker/checker pattern. It runs as its own workflow with its own
// fresh agent, so the reviewer has no stake in the implementation and no memory of the choices that
// produced it. It judges the unified diff against the plan and returns a structured verdict the
// orchestrator can branch on (approve vs request_changes) and show to a human.

import { phase, agent, input, output, type WorkflowMeta } from "@boardwalk-labs/workflow";

export const meta = {
  slug: "code-factory-review",
  title: "Code Factory · Review",
  description: "Skeptically review a diff against its plan; return a structured verdict.",
  triggers: [{ kind: "manual" }],
  input_schema: {
    type: "object",
    properties: {
      diff: { type: "string" },
      plan: { type: "object" },
      issue: { type: "object" },
    },
    required: ["diff", "plan"],
  },
  budget: { max_usd: 2 },
} satisfies WorkflowMeta;

interface ReviewInput {
  diff: string;
  plan: { summary: string; approach: string; risks: string[] };
  issue?: { title: string; body: string };
}
const { diff, plan, issue } = input as ReviewInput;

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string", description: "One or two sentences on the overall state of the change." },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["blocker", "major", "minor"] },
          file: { type: "string" },
          note: { type: "string" },
        },
        required: ["severity", "file", "note"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
} as const;

phase("Review");
const review = await agent(
  `You are a strict, skeptical code reviewer. You did NOT write this change and you owe it no charity.
Load the "reviewer" skill for the rubric before you start, and apply it to the diff below.

What the change was supposed to do:
${issue?.title ? `Issue: ${issue.title}\n` : ""}Plan summary: ${plan.summary}
Approach: ${plan.approach}
Flagged risks: ${plan.risks.join("; ") || "none"}

Unified diff under review:
${diff || "(empty diff — the build produced no changes)"}

Judge correctness, security, test coverage, and whether it actually solves the issue without
unrelated churn. Return verdict "request_changes" if there is any blocker or major finding, or if the
diff is empty. Default to "request_changes" when you are genuinely unsure. Cite the file for each
finding. Be specific; do not invent problems that are not in the diff.`,
  { skills: ["reviewer"], reasoning: "high", schema: REVIEW_SCHEMA },
);

output(review);
