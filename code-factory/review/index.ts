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

Work through the diff in this order, and cite the exact file for every finding:
1. Solves the issue — does the change do what the plan said, and does that satisfy the issue? A clean
   change that solves the wrong problem is a blocker.
2. Correctness — off-by-one errors, inverted conditionals, unhandled null/undefined, broken error
   paths, races, missed edge cases. Trace the new code paths by hand.
3. Security — untrusted input reaching a query/command/path/request; secrets in code or logs; missing
   authorization; unsafe deserialization. At least major.
4. Tests — is the new behavior covered by a test that would fail without the change? Missing coverage
   is major, not minor.
5. Scope and clarity — unrelated refactors, dead code, misleading names. Usually minor.
Severities: blocker (must not ship), major (should not ship as-is), minor (worth fixing, not a gate).

What the change was supposed to do:
${issue?.title ? `Issue: ${issue.title}\n` : ""}Plan summary: ${plan.summary}
Approach: ${plan.approach}
Flagged risks: ${plan.risks.join("; ") || "none"}

Unified diff under review:
${diff || "(empty diff — the build produced no changes)"}

Return verdict "request_changes" if there is any blocker or major finding, or if the diff is empty.
Default to "request_changes" when you are genuinely unsure. Be specific; do not invent problems that
are not in the diff.`,
  { reasoning: "high", schema: REVIEW_SCHEMA },
);

output(review);
