interface GitHubAccount {
  login?: string;
  type?: string;
}

export interface GitHubEvent {
  action?: string;
  issue?: { number?: number };
  pull_request?: { number?: number; user?: GitHubAccount };
  repository?: { full_name?: string };
  sender?: GitHubAccount;
}

export interface Route {
  label: string;
  slug: string;
  match: (e: GitHubEvent) => boolean;
}

function isBotAccount(account?: GitHubAccount): boolean {
  return account?.type === "Bot" || account?.login?.endsWith("[bot]") === true;
}

// Each route: a predicate over the GitHub event body -> the slug of the workflow that handles it.
// The first matching route wins. To add the PR reviewer, build a `pr-review` workflow and uncomment.
export const ROUTES: Route[] = [
  {
    label: "issue -> code-factory",
    slug: "code-factory",
    match: (e) => e.issue !== undefined && ["opened", "reopened", "labeled"].includes(e.action ?? ""),
  },
  {
    // opened = new PR; synchronize = a new commit pushed to the PR; reopened.
    label: "pull_request -> pr-review",
    slug: "pr-review",
    match: (e) =>
      e.pull_request !== undefined &&
      ["opened", "reopened", "synchronize"].includes(e.action ?? "") &&
      !isBotAccount(e.pull_request.user) &&
      !isBotAccount(e.sender),
  },
];

export function routeForEvent(e: GitHubEvent): Route | undefined {
  return ROUTES.find((r) => r.match(e));
}
