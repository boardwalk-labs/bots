import { routeForEvent, type GitHubEvent } from "./routing.js";

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${String(expected)}, received ${String(actual)}`);
  }
}

function pullRequestEvent(overrides: Partial<GitHubEvent> = {}): GitHubEvent {
  return {
    action: "opened",
    pull_request: {
      number: 1,
      user: { login: "octocat", type: "User" },
    },
    sender: { login: "octocat", type: "User" },
    ...overrides,
  };
}

for (const action of ["opened", "reopened", "synchronize"]) {
  assertEqual(
    routeForEvent(pullRequestEvent({ action }))?.slug,
    "pr-review",
    `routes human-authored ${action} pull requests to pr-review`,
  );
}

assertEqual(
  routeForEvent(
    pullRequestEvent({
      pull_request: {
        number: 1,
        user: { login: "code-factory", type: "Bot" },
      },
    }),
  )?.slug,
  undefined,
  "does not route pull requests authored by a Bot-typed account to pr-review",
);

assertEqual(
  routeForEvent(
    pullRequestEvent({
      pull_request: {
        number: 1,
        user: { login: "code-factory[bot]", type: "User" },
      },
    }),
  )?.slug,
  undefined,
  "does not route pull requests authored by a [bot] login to pr-review",
);

assertEqual(
  routeForEvent(
    pullRequestEvent({
      sender: { login: "dependabot[bot]", type: "Bot" },
    }),
  )?.slug,
  undefined,
  "does not route pull request events sent by bot accounts to pr-review",
);
