// code-factory — the assembly line: a GitHub issue in, a reviewed PR out.
//
// This is the orchestrator station. It does no LLM work itself; it threads a feature request through
// three worker workflows and gates the result on a human:
//
//   intake  ->  code-factory-plan  ->  code-factory-build  ->  code-factory-review  ->  [human]  ->  open PR
//                 (planner)             (implement + test)        (skeptical checker)    (gate)
//
// Boardwalk pieces this leans on:
//   workflows.call  each station is a durable child run (billed + visible separately, idempotent).
//   humanInput      the run SUSPENDS at the approval gate (task released, no idle billing) and
//                   resumes when a person answers in the web, CLI, MCP, or REST.
//   GitHub App      a short-lived installation token is minted from the app credentials (see
//                   github.ts); the secret never reaches an agent's context.
//   step.run        GitHub writes are memoized, so a crash-restart re-attaches instead of re-firing.

import { phase, input, output, workflows, humanInput, step, type WorkflowMeta } from "@boardwalk-labs/workflow";
import { gh, installationToken } from "./github.js";

export const meta = {
  slug: "code-factory",
  title: "Code Factory",
  description: "Turn a GitHub issue into a reviewed, tested pull request, with a human approval gate.",
  // manual: pass { repo, issue_number }. webhook: point the GitHub App's `issues` webhook here; the
  // body's repository.full_name + issue.number are read below, so both paths converge.
  triggers: [{ kind: "manual" }, { kind: "webhook", auth: "token" }],
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string", description: 'owner/name, e.g. "acme/widgets".' },
      issue_number: { type: "integer", minimum: 1 },
      base_branch: { type: "string", description: "Branch to cut the work from.", default: "main" },
      // GitHub webhook fields (used only if repo / issue_number are absent).
      action: { type: "string" },
      repository: { type: "object" },
      issue: { type: "object" },
    },
  },
  permissions: { secrets: [{ name: "GITHUB_APP_ID" }, { name: "GITHUB_APP_PRIVATE_KEY" }] },
  // The orchestrator itself spends almost nothing (no agent() calls); the workers carry the real
  // caps. deadline_seconds is wall-clock and INCLUDES the human wait, so give the gate room: if no
  // one responds within 7 days the run fails on the deadline rather than hanging forever.
  budget: { max_usd: 0.25, deadline_seconds: 604800 }, // 7 days (literal: meta allows no expressions)
} satisfies WorkflowMeta;

const MAX_AUTO_REVISIONS = 2; // skeptical-reviewer rounds before a human ever sees it
const MAX_HUMAN_REVISIONS = 3; // "request changes" rounds a person may ask for

// ── Resolve the trigger into { repo, issueNumber, base } from either shape ──────────────────────
interface Trigger {
  repo?: string;
  issue_number?: number;
  base_branch?: string;
  action?: string;
  repository?: { full_name?: string };
  issue?: { number?: number };
}
const t = input as Trigger;
const repo = t.repo ?? t.repository?.full_name;
const issueNumber = t.issue_number ?? t.issue?.number;
const base = t.base_branch ?? "main";
if (typeof repo !== "string" || typeof issueNumber !== "number") {
  throw new Error("code-factory needs { repo: 'owner/name', issue_number } (or a GitHub issues webhook body).");
}
const branch = `code-factory/issue-${String(issueNumber)}`;

// Webhook deliveries fire on every issue action; only act on the ones that mean "new work".
const ACTIONABLE = new Set(["opened", "reopened", "labeled"]);
if (t.action !== undefined && !ACTIONABLE.has(t.action)) {
  output({ status: "skipped", reason: `ignoring issue action "${t.action}"`, repo, issue_number: issueNumber });
} else {
  await runFactory();
}

async function runFactory(): Promise<void> {
  // ── Intake: the issue and a shallow file tree (so the planner is grounded without a clone) ──────
  phase("Intake");
  const intakeToken = await installationToken(repo as string);
  const issueData = await step.run("fetch-issue", async () => {
    const raw = (await gh(`/repos/${repo}/issues/${String(issueNumber)}`, intakeToken)) as {
      title: string;
      body: string | null;
    };
    return { title: raw.title, body: raw.body ?? "" };
  });
  const tree = await step.run("fetch-tree", async () => {
    const br = (await gh(`/repos/${repo}/branches/${base}`, intakeToken)) as {
      commit: { commit: { tree: { sha: string } } };
    };
    const data = (await gh(`/repos/${repo}/git/trees/${br.commit.commit.tree.sha}?recursive=1`, intakeToken)) as {
      tree: { path: string; type: string }[];
    };
    return data.tree.filter((n) => n.type === "blob").map((n) => n.path).slice(0, 300);
  });

  // ── Plan ──────────────────────────────────────────────────────────────────────────────────────
  phase("Plan");
  const plan = asPlan(await workflows.call("code-factory-plan", { repo, issue: issueData, tree }));

  // ── Build, then skeptical review; auto-revise a bounded number of times ─────────────────────────
  phase("Build");
  let buildResult = asBuild(
    await workflows.call("code-factory-build", { repo, base, branch, plan, issue: issueData }),
  );

  phase("Review");
  let review = asReview(await workflows.call("code-factory-review", { diff: buildResult.diff, plan, issue: issueData }));

  let autoRounds = 0;
  while (review.verdict === "request_changes" && autoRounds < MAX_AUTO_REVISIONS) {
    autoRounds += 1;
    buildResult = asBuild(
      await workflows.call("code-factory-build", {
        repo, base, branch, plan, issue: issueData,
        prior_diff: buildResult.diff,
        feedback: review.findings.map((f) => `[${f.severity}] ${f.file}: ${f.note}`).join("\n"),
      }),
    );
    review = asReview(await workflows.call("code-factory-review", { diff: buildResult.diff, plan, issue: issueData }));
  }

  // ── Human gate: the run suspends here until a person decides ───────────────────────────────────
  phase("Approve");
  let humanRounds = 0;
  let finalStatus: "pr-opened" | "rejected" | "abandoned" = "abandoned";
  let prUrl: string | null = null;

  for (;;) {
    const gate = await humanInput({
      key: `approve-${String(issueNumber)}-${String(humanRounds)}`,
      prompt: renderGateSummary(issueData.title, plan.summary, buildResult, review),
      input: { kind: "choice", options: ["Approve & open PR", "Request changes", "Reject"], allowOther: false },
    });

    if (gate.value === "Approve & open PR") {
      phase("Ship");
      const shipToken = await installationToken(repo as string);
      prUrl = await step.run(`open-pr-${String(humanRounds)}`, () =>
        openOrGetPr(shipToken, {
          title: `${issueData.title} (closes #${String(issueNumber)})`,
          head: branch,
          base,
          body: prBody(issueNumber as number, plan.summary, review, buildResult),
        }),
      );
      await step.run(`comment-${String(humanRounds)}`, () =>
        gh(`/repos/${repo}/issues/${String(issueNumber)}/comments`, shipToken, {
          method: "POST",
          body: JSON.stringify({ body: `The code factory opened a PR: ${prUrl ?? ""}` }),
        }),
      );
      finalStatus = "pr-opened";
      break;
    }

    if (gate.value === "Reject" || humanRounds >= MAX_HUMAN_REVISIONS) {
      finalStatus = gate.value === "Reject" ? "rejected" : "abandoned";
      break;
    }

    // Request changes: capture free-text guidance, run one more build + review round, re-gate.
    humanRounds += 1;
    const notes = await humanInput({
      key: `changes-${String(issueNumber)}-${String(humanRounds)}`,
      prompt: "What should change before this can ship?",
      input: { kind: "text", multiline: true, required: true },
    });
    buildResult = asBuild(
      await workflows.call("code-factory-build", {
        repo, base, branch, plan, issue: issueData, prior_diff: buildResult.diff, feedback: notes.value,
      }),
    );
    review = asReview(await workflows.call("code-factory-review", { diff: buildResult.diff, plan, issue: issueData }));
  }

  output({
    status: finalStatus,
    pr_url: prUrl,
    repo,
    issue_number: issueNumber,
    branch,
    auto_revisions: autoRounds,
    human_revisions: humanRounds,
    tests_passed: buildResult.tests_passed,
    review_verdict: review.verdict,
  });
}

// Open a PR, or return the existing open one for this branch (so re-triggering an issue is safe).
async function openOrGetPr(
  token: string,
  pr: { title: string; head: string; base: string; body: string },
): Promise<string> {
  try {
    const created = (await gh(`/repos/${repo}/pulls`, token, { method: "POST", body: JSON.stringify(pr) })) as {
      html_url: string;
    };
    return created.html_url;
  } catch {
    const owner = (repo as string).split("/")[0];
    const open = (await gh(`/repos/${repo}/pulls?head=${owner}:${pr.head}&state=open`, token)) as {
      html_url: string;
    }[];
    if (open.length > 0) return open[0].html_url;
    throw new Error(`Could not open or find a PR for ${pr.head}.`);
  }
}

// ── Narrowing helpers for the (typed-as-unknown) child results ──────────────────────────────────
interface Plan {
  summary: string;
  files_to_touch: string[];
  approach: string;
  test_command: string;
  risks: string[];
}
interface BuildResult {
  branch: string;
  diff: string;
  files_changed: string[];
  tests_passed: boolean;
  test_output: string;
}
interface Review {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: { severity: "blocker" | "major" | "minor"; file: string; note: string }[];
}

function asPlan(v: unknown): Plan {
  const o = v as Partial<Plan>;
  if (typeof o.summary !== "string" || typeof o.test_command !== "string" || !Array.isArray(o.files_to_touch)) {
    throw new Error(`code-factory-plan returned an unexpected shape: ${JSON.stringify(v).slice(0, 400)}`);
  }
  return {
    summary: o.summary,
    files_to_touch: o.files_to_touch,
    approach: o.approach ?? "",
    test_command: o.test_command,
    risks: o.risks ?? [],
  };
}
function asBuild(v: unknown): BuildResult {
  const o = v as Partial<BuildResult>;
  if (typeof o.diff !== "string" || typeof o.tests_passed !== "boolean") {
    throw new Error(`code-factory-build returned an unexpected shape: ${JSON.stringify(v).slice(0, 400)}`);
  }
  return {
    branch: o.branch ?? branch,
    diff: o.diff,
    files_changed: o.files_changed ?? [],
    tests_passed: o.tests_passed,
    test_output: o.test_output ?? "",
  };
}
function asReview(v: unknown): Review {
  const o = v as Partial<Review>;
  if (o.verdict !== "approve" && o.verdict !== "request_changes") {
    throw new Error(`code-factory-review returned an unexpected shape: ${JSON.stringify(v).slice(0, 400)}`);
  }
  return { verdict: o.verdict, summary: o.summary ?? "", findings: o.findings ?? [] };
}

function renderGateSummary(title: string, planSummary: string, b: BuildResult, r: Review): string {
  const findings = r.findings.length === 0
    ? "none"
    : r.findings.map((f) => `  - [${f.severity}] ${f.file}: ${f.note}`).join("\n");
  return [
    `Feature: ${title}`,
    ``,
    `Plan: ${planSummary}`,
    ``,
    `Build: ${String(b.files_changed.length)} file(s) changed; tests ${b.tests_passed ? "PASSED" : "FAILED"}.`,
    `Files: ${b.files_changed.join(", ") || "(none reported)"}`,
    ``,
    `Reviewer verdict: ${r.verdict.toUpperCase()}`,
    `Reviewer notes: ${r.summary}`,
    `Findings:\n${findings}`,
    ``,
    `Open a PR, ask for changes, or reject?`,
  ].join("\n");
}

function prBody(n: number, planSummary: string, r: Review, b: BuildResult): string {
  return [
    `Closes #${String(n)}.`,
    ``,
    `## What this does`,
    planSummary,
    ``,
    `## Tests`,
    b.tests_passed ? "Test suite passed in the factory run." : "Test suite did not pass cleanly; review carefully.",
    ``,
    `## Automated review`,
    `Verdict: **${r.verdict}**. ${r.summary}`,
    ``,
    `_Generated by the Boardwalk code factory._`,
  ].join("\n");
}
