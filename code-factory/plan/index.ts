// code-factory-plan — the planning station.
//
// It fetches the issue and a shallow file tree itself (rather than receiving them from the
// orchestrator) so the orchestrator's call to this workflow carries only immutable, trigger-derived
// arguments. That keeps the orchestrator deterministic across the suspend/resume cycles it goes
// through while waiting on its child workflows. It returns the issue it fetched alongside the plan,
// so the orchestrator can reuse it downstream without fetching anything itself.

import { phase, agent, input, output, type WorkflowMeta } from "@boardwalk-labs/workflow";
import { gh, installationToken } from "./github.js";

export const meta = {
  slug: "code-factory-plan",
  title: "Code Factory · Plan",
  description: "Fetch a GitHub issue + repo file tree and turn them into a concrete implementation plan.",
  triggers: [{ kind: "manual" }],
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      issue_number: { type: "integer", minimum: 1 },
      base: { type: "string", default: "main" },
    },
    required: ["repo", "issue_number"],
  },
  permissions: { secrets: [{ name: "GITHUB_APP_PRIVATE_KEY" }] },
  budget: { max_usd: 1 },
} satisfies WorkflowMeta;

interface PlanInput {
  repo: string;
  issue_number: number;
  base?: string;
}
const { repo, issue_number, base = "main" } = input as PlanInput;

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string", description: "One paragraph: what we will change and why." },
    files_to_touch: { type: "array", items: { type: "string" }, description: "Existing or new paths." },
    approach: { type: "string", description: "The implementation approach, in a few sentences." },
    test_command: {
      type: "string",
      description: "The single shell command that proves the change works, e.g. `npm test`, `cd pkg && npx tsc --noEmit`, or `pytest -q`. Dependencies are ALREADY installed before this runs, so do NOT include an install step — just run the test/typecheck (cd into the right package if needed).",
    },
    risks: { type: "array", items: { type: "string" }, description: "What could go wrong or break." },
  },
  required: ["summary", "files_to_touch", "approach", "test_command", "risks"],
} as const;

interface PlanResult {
  summary: string;
  files_to_touch: string[];
  approach: string;
  test_command: string;
  risks: string[];
}

// ── Fetch the issue and a shallow file tree (the planner's own grounding) ────────────────────────
phase("Fetch");
const token = await installationToken(repo);
const raw = (await gh(`/repos/${repo}/issues/${String(issue_number)}`, token)) as {
  title: string;
  body: string | null;
};
const issue = { title: raw.title, body: raw.body ?? "" };
const br = (await gh(`/repos/${repo}/branches/${base}`, token)) as {
  commit: { commit: { tree: { sha: string } } };
};
const data = (await gh(`/repos/${repo}/git/trees/${br.commit.commit.tree.sha}?recursive=1`, token)) as {
  tree: { path: string; type: string }[];
};
const tree = data.tree.filter((n) => n.type === "blob").map((n) => n.path).slice(0, 300);

phase("Plan");
const plan = (await agent(
  `You are a staff engineer scoping a change before anyone writes code.

Repository: ${repo}

Issue title: ${issue.title}
Issue body:
${issue.body || "(no description)"}

Repository file tree (truncated):
${tree.join("\n")}

Produce a tight, buildable plan. Name the SPECIFIC files to touch (reuse existing ones; only add
files when there is no home for the change). Infer the project's test command from the tree
(package.json scripts, a Makefile, pytest layout, go test, etc.). Dependencies are installed for you
before the test runs, so the command should just run the test/typecheck (no install step), cd-ing
into the right package first if needed. Keep the change minimal and focused on the issue; do not
propose unrelated refactors.`,
  { reasoning: "high", schema: PLAN_SCHEMA },
)) as PlanResult;

// Return the issue alongside the plan so the orchestrator never has to fetch it itself.
output({ ...plan, issue });
