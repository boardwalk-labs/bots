// pr-review — review a pull request and post the verdict back as a GitHub review.
//
// Triggered by github-dispatcher on pull_request events: `opened` (a new PR) and `synchronize` (a new
// commit pushed to the PR), plus `reopened`. It fetches the PR's diff with the GitHub App token, runs
// a skeptical reviewer (the same rubric as the code-factory checker), and posts ONE review.
//
// It posts the review as a COMMENT, not REQUEST_CHANGES/APPROVE, on purpose: this bot re-reviews on
// every commit, and a REQUEST_CHANGES review is "sticky" (it keeps blocking merge until dismissed,
// even after a later clean review), while an APPROVE could stand in for a required human review. A
// COMMENT surfaces the verdict + findings on every push without ever blocking or auto-approving. To
// make it gate merges instead, change EVENT below (and accept the stickiness across commits).

import { phase, agent, input, output, step, type WorkflowMeta } from "@boardwalk-labs/workflow";
import { gh, installationToken } from "./github.js";

export const meta = {
  slug: "pr-review",
  title: "PR Review",
  description: "Review a pull request diff and post the verdict back as a GitHub review.",
  triggers: [{ kind: "manual" }],
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string", description: "owner/name." },
      pr_number: { type: "integer", minimum: 1 },
      // GitHub pull_request webhook fields (used if repo / pr_number are absent).
      action: { type: "string" },
      number: { type: "integer" },
      pull_request: { type: "object" },
      repository: { type: "object" },
    },
  },
  permissions: { secrets: [{ name: "GITHUB_APP_PRIVATE_KEY" }] },
  budget: { max_usd: 2, max_duration_seconds: 600 },
} satisfies WorkflowMeta;

const EVENT = "COMMENT" as const; // COMMENT | REQUEST_CHANGES | APPROVE — see header note.

interface PrEvent {
  repo?: string;
  pr_number?: number;
  number?: number;
  pull_request?: { number?: number };
  repository?: { full_name?: string };
}
const ev = input as PrEvent;
const repo = ev.repo ?? ev.repository?.full_name;
const prNumber = ev.pr_number ?? ev.pull_request?.number ?? ev.number;
if (typeof repo !== "string" || typeof prNumber !== "number") {
  throw new Error("pr-review needs { repo: 'owner/name', pr_number } (or a GitHub pull_request webhook body).");
}

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["approve", "request_changes"] },
    summary: { type: "string", description: "One or two sentences on the overall state of the PR." },
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

interface Review {
  verdict: "approve" | "request_changes";
  summary: string;
  findings: { severity: "blocker" | "major" | "minor"; file: string; note: string }[];
}

const token = await installationToken(repo);

// ── Fetch the PR metadata and its per-file patches (assembled into a diff) ───────────────────────
phase("Fetch");
const pr = await step.run("fetch-pr", async () => {
  const head = (await gh(`/repos/${repo}/pulls/${String(prNumber)}`, token)) as { title: string; body: string | null };
  const files = (await gh(`/repos/${repo}/pulls/${String(prNumber)}/files?per_page=100`, token)) as {
    filename: string;
    status: string;
    patch?: string;
  }[];
  const diff = files
    .map((f) => `### ${f.filename} (${f.status})\n${f.patch ?? "(no textual diff — binary or too large)"}`)
    .join("\n\n")
    .slice(0, 200_000);
  return { title: head.title, body: head.body ?? "", diff, fileCount: files.length };
});

// ── Review: a skeptical reviewer over the diff (the same rubric as code-factory's checker) ────────
phase("Review");
const review = (await agent(
  `You are a strict, skeptical code reviewer reviewing a pull request. You did NOT write this change
and you owe it no charity. Load the "reviewer" skill for the rubric before you start.

Pull request: ${pr.title}
${pr.body || "(no description)"}

Diff (per-file patches):
${pr.diff || "(empty diff)"}

Judge correctness, security, test coverage, and whether it does what it claims without unrelated
churn. Return verdict "request_changes" if there is any blocker or major finding; default to
"request_changes" when you are genuinely unsure. Cite the file for each finding. Be specific; do not
invent problems that are not in the diff.`,
  { skills: ["reviewer"], reasoning: "high", schema: REVIEW_SCHEMA },
)) as Review;

// ── Post the review back to the PR ───────────────────────────────────────────────────────────────
phase("Post");
await step.run("post-review", () =>
  gh(`/repos/${repo}/pulls/${String(prNumber)}/reviews`, token, {
    method: "POST",
    body: JSON.stringify({ event: EVENT, body: reviewBody(review) }),
  }),
);

output({
  repo,
  pr_number: prNumber,
  verdict: review.verdict,
  findings: review.findings.length,
  files_reviewed: pr.fileCount,
  posted_as: EVENT,
});

function reviewBody(r: Review): string {
  const findings = r.findings.length === 0
    ? "_No findings._"
    : r.findings.map((f) => `- **${f.severity}** \`${f.file}\`: ${f.note}`).join("\n");
  return [
    `### Automated review: ${r.verdict === "approve" ? "looks good" : "changes suggested"}`,
    ``,
    r.summary,
    ``,
    `**Findings**`,
    findings,
    ``,
    `_Posted by the Boardwalk PR reviewer (non-blocking)._`,
  ].join("\n");
}
