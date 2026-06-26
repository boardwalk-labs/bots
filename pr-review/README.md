# pr-review

Reviews every pull request and posts the verdict back as a GitHub review. Triggered by
[`github-dispatcher`](../github-dispatcher) on `pull_request` events:

- `opened` — a new PR is created
- `synchronize` — a new commit is pushed to the PR (so it re-reviews on every push)
- `reopened`

It fetches the PR's diff with the GitHub App token, runs a skeptical reviewer (the same rubric the
`code-factory` checker uses, in `skills/reviewer/`), and posts one review.

## How it posts

The review is posted as a **COMMENT** (event `COMMENT`), never `REQUEST_CHANGES` or `APPROVE`, on
purpose:

- This bot re-reviews on **every** commit. A `REQUEST_CHANGES` review is *sticky* in GitHub: it keeps
  blocking merge until it is dismissed, even after a later clean review, which is the wrong behavior
  for something that fires on each push.
- An `APPROVE` from the App could stand in for a required human review.

So it surfaces the verdict (`approve` / `request_changes`) and the findings in the comment body
without ever blocking a merge or auto-approving. To make it gate merges instead, change the `EVENT`
constant in `index.ts` (and accept that a `REQUEST_CHANGES` will persist across commits until
dismissed).

## Setup

It rides the same GitHub App and credentials as `code-factory` (see
[`../code-factory/README.md`](../code-factory/README.md)). Two things to add for PRs:

1. **Subscribe the GitHub App to "Pull requests"** events (the App already has the `pull_requests`
   permission from the manifest).
2. **Deploy + route.** Deploy this workflow and the dispatcher already routes `pull_request`
   deliveries here:

```bash
boardwalk deploy ./pr-review/index.ts
boardwalk deploy ./github-dispatcher/index.ts
```

The App credentials (`GITHUB_APP_ID` variable + `GITHUB_APP_PRIVATE_KEY` secret) live in the org base
environment, same as `code-factory`, because webhook-triggered runs use the base.
