// code-factory-plan — the planning station.
//
// Given the issue text and a shallow file tree of the repo, produce a concrete implementation plan:
// which files to touch, the approach, and the exact command that proves the change works. It writes
// no code and clones nothing; it turns a request into a buildable spec. Keeping this separate from
// the build station means the plan is a durable, inspectable artifact a person can read before any
// code is written, and it can be re-run on its own.

import { phase, agent, input, output, type WorkflowMeta } from "@boardwalk-labs/workflow";

export const meta = {
  slug: "code-factory-plan",
  title: "Code Factory · Plan",
  description: "Turn a GitHub issue + repo file tree into a concrete implementation plan.",
  triggers: [{ kind: "manual" }],
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      issue: {
        type: "object",
        properties: { title: { type: "string" }, body: { type: "string" } },
        required: ["title", "body"],
      },
      tree: { type: "array", items: { type: "string" }, description: "Repo file paths." },
    },
    required: ["repo", "issue", "tree"],
  },
  budget: { max_usd: 1 },
} satisfies WorkflowMeta;

interface PlanInput {
  repo: string;
  issue: { title: string; body: string };
  tree: string[];
}
const { repo, issue, tree } = input as PlanInput;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One paragraph: what we will change and why." },
    files_to_touch: { type: "array", items: { type: "string" }, description: "Existing or new paths." },
    approach: { type: "string", description: "The implementation approach, in a few sentences." },
    test_command: {
      type: "string",
      description: "The single shell command that proves the change works, e.g. `npm test` or `pytest -q`. Infer it from the repo's files.",
    },
    risks: { type: "array", items: { type: "string" }, description: "What could go wrong or break." },
  },
  required: ["summary", "files_to_touch", "approach", "test_command", "risks"],
} as const;

phase("Plan");
const plan = await agent(
  `You are a staff engineer scoping a change before anyone writes code.

Repository: ${repo}

Issue title: ${issue.title}
Issue body:
${issue.body || "(no description)"}

Repository file tree (truncated):
${tree.join("\n")}

Produce a tight, buildable plan. Name the SPECIFIC files to touch (reuse existing ones; only add
files when there is no home for the change). Infer the project's test command from the tree
(package.json scripts, a Makefile, pytest layout, go test, etc.) and give the exact command. Keep the
change minimal and focused on the issue; do not propose unrelated refactors.`,
  { reasoning: "high", schema: PLAN_SCHEMA },
);

output(plan);
