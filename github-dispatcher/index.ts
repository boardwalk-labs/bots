// github-dispatcher — one GitHub App webhook in, fan out to the workflow that handles each event.
//
// A GitHub App has a single webhook URL, and every event it is subscribed to is delivered there. This
// workflow is that single front door: point the App's webhook at THIS workflow's URL, subscribe the
// App to the events you care about, and the dispatcher routes each delivery to the right workflow via
// workflows.run (fire-and-forget). Adding a new GitHub bot is one new entry in ROUTES below.
//
// It distinguishes events by the payload shape (issues carry `issue`, PRs carry `pull_request`),
// since the webhook body is what reaches `input`. No secrets and no GitHub API calls: it only reads
// the delivery and dispatches.

import { input, output, workflows, type WorkflowMeta } from "@boardwalk-labs/workflow";

export const meta = {
  slug: "github-dispatcher",
  title: "GitHub Dispatcher",
  description: "Single GitHub App webhook entry; routes each event to the workflow that handles it.",
  triggers: [{ kind: "webhook", auth: "token" }],
  budget: { max_duration_seconds: 60 },
} satisfies WorkflowMeta;

interface GitHubEvent {
  action?: string;
  issue?: { number?: number };
  pull_request?: { number?: number };
  repository?: { full_name?: string };
}

// Each route: a predicate over the GitHub event body -> the slug of the workflow that handles it.
// The first matching route wins. To add the PR reviewer, build a `pr-review` workflow and uncomment.
const ROUTES: { label: string; slug: string; match: (e: GitHubEvent) => boolean }[] = [
  {
    label: "issue -> code-factory",
    slug: "code-factory",
    match: (e) => e.issue !== undefined && ["opened", "reopened", "labeled"].includes(e.action ?? ""),
  },
  {
    // opened = new PR; synchronize = a new commit pushed to the PR; reopened.
    label: "pull_request -> pr-review",
    slug: "pr-review",
    match: (e) => e.pull_request !== undefined && ["opened", "reopened", "synchronize"].includes(e.action ?? ""),
  },
];

const e = input as GitHubEvent;
const repo = e.repository?.full_name ?? "(unknown repo)";
const kind = e.issue !== undefined ? "issue" : e.pull_request !== undefined ? "pull_request" : "other";
console.log(`github-dispatcher: received ${kind} event (action=${e.action ?? "?"}, repo=${repo})`);
if (kind === "other") {
  // Tells apart ping / installation / unrelated deliveries when nothing routes.
  console.log(`github-dispatcher: unrecognized payload, top-level keys=[${Object.keys(e).join(", ")}]`);
}

const route = ROUTES.find((r) => r.match(e));
if (route) {
  const runId = await workflows.run(route.slug, e); // fire-and-forget; returns the new run's id
  console.log(`github-dispatcher: routed ${kind} -> ${route.slug} (run ${runId})`);
  output({ routed_to: route.slug, run_id: runId, action: e.action ?? null, repo });
} else {
  console.log(`github-dispatcher: no matching route (${kind}, action=${e.action ?? "?"})`);
  output({ routed_to: null, reason: `no route for action "${e.action ?? "?"}"`, repo });
}
