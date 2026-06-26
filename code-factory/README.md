# code-factory

A software factory built on Boardwalk: a GitHub issue goes in, a reviewed and tested pull request
comes out, with a human approval gate in the middle.

A "software factory" is an assembly line for software: standardized, automated stations wired into a
pipeline so every output is deployment worthy. The modern version makes the stations autonomous
agents covering the work (plan, build, test, review). Boardwalk is the control plane for agent
workflows, so each station here is a workflow and the line is composed with `workflows.call`.

## The line

```
  GitHub issue
       |
       v
  code-factory             orchestrator: no LLM work, just routing + the human gate
       |
       +->  code-factory-plan      planner: issue + file tree -> a concrete, buildable plan
       |
       +->  code-factory-build     workshop: clone, implement the plan, RUN the tests, push a branch
       |
       +->  code-factory-review    checker: a skeptical reviewer (never the author) grades the diff
       |          |
       |          +- request_changes --> back to build  (bounded auto-revision)
       |
       +->  humanInput              approval gate: the run SUSPENDS until a person decides
       |          |
       |          +- approve --------------> open PR + comment on the issue
       |          +- request changes ------> back to build  (bounded human revision)
       |          +- reject ---------------> stop, leave the branch
       |
       v
  pull request
```

## Why it is split this way

- **`build` is the only station that touches the codebase.** A `workflows.call` child runs on its own
  task with its own workspace, so the clone -> implement -> test -> push loop has to live in one run.
  The pure data-transform stations (`plan`, `review`) are separate workflows, so the line is genuinely
  composed and each station is independently runnable and re-runnable.
- **Maker is never checker.** The agent that writes the code in `build` is a different agent, in a
  different run, from the one that reviews it in `review`. The reviewer has no stake in the change.
- **The program proves the tests, not the agent.** `build` runs the test command itself in `step.run`
  and reports an objective pass/fail, rather than trusting the implementer's self-report.
- **The human gate is durable.** `humanInput()` suspends the run (the task is released, idle wait is
  not billed) and resumes when someone answers in the web, CLI, MCP, or REST. A crash restarts from
  the top and re-attaches to the already-finished child runs via `workflows.call` idempotency.

## Set up the GitHub App

This bot authenticates as a GitHub App, not a personal token. The App installs per repo, mints
short-lived tokens, acts as its own identity (`boardwalk-code-factory[bot]` shows as the PR author and
issue commenter), and delivers the issue webhooks. The trusted program mints an installation token
from the App's id + private key; the secret never reaches an agent (see `orchestrator/github.ts`).

1. **Create the App.** Go to your org's App settings:
   `https://github.com/organizations/<your-org>/settings/apps/new`. Use the values in
   [`app-manifest.json`](./app-manifest.json):
   - Permissions: Contents read/write, Pull requests read/write, Issues read/write, Metadata read.
   - Subscribe to events: Issues.
   - Webhook: leave the URL as a placeholder for now; you will set it after deploying.
2. **Generate a private key** on the App's page and download the `.pem`.
3. **Store the secrets** in Boardwalk (dashboard for hosted, or `.env` per package for `boardwalk
   dev`, see [`.env.example`](./.env.example)):
   - `GITHUB_APP_ID` (the App's numeric ID)
   - `GITHUB_APP_PRIVATE_KEY` (the PEM)
4. **Install the App** on the repositories you want the factory to work on.

### Webhook auth, honestly

GitHub signs webhook deliveries with an HMAC (`X-Hub-Signature-256`). Boardwalk's native GitHub
signature verification is still on the roadmap, so today you wire the App's webhook to this bot's
**webhook trigger URL** (which carries an unguessable token, `auth: "token"`). The orchestrator reads
`repository.full_name` + `issue.number` straight off the GitHub body and only acts on the `opened`,
`reopened`, and `labeled` actions. Until then, you can also just trigger it manually (below).

## Deploy

Each station is its own deployable workflow. From this directory:

```bash
boardwalk deploy ./plan/index.ts
boardwalk deploy ./build/index.ts          # bundles its github.ts helper
boardwalk deploy ./review/index.ts         # bundles skills/ alongside index.ts
boardwalk deploy ./orchestrator/index.ts   # bundles its github.ts helper
```

After deploying, copy the `code-factory` workflow's webhook URL into the GitHub App's webhook
settings.

## Run

```bash
# kick off the whole line for one issue
boardwalk run --org <your-org> \
  --input '{ "repo": "owner/name", "issue_number": 42, "base_branch": "main" }' \
  ./orchestrator/index.ts
```

The run pauses at the approval gate. Respond from the web run view or the CLI to approve, request
changes, or reject. On approve, it opens the PR and comments the link on the issue.

## Stations

| Workflow | Role | Secrets | Budget |
| --- | --- | --- | --- |
| `code-factory` | Orchestrator + human gate + PR | App id + key | `$0.25`, 7-day deadline |
| `code-factory-plan` | Issue + tree -> plan | none | `$1` |
| `code-factory-build` | Clone, implement, test, push | App id + key | `$6`, 30-min compute |
| `code-factory-review` | Skeptical review of the diff | none | `$2` |

Models are left to the managed routing lane (no `model` set), so each `agent()` call routes
automatically; set a `model` per call to pin one.

## Trade-offs and where to take it next

- **One clone per build round.** Each revision round re-clones the base and force-pushes the branch,
  which keeps `build` stateless and idempotent at the cost of a fresh clone. For large repos, switch
  to a persistent workspace (`workspace.persist`) keyed per issue.
- **Test command is inferred by the planner.** Good for conventional repos; for anything exotic pass
  it through `input`/`config` instead of inferring it.
- **No merge.** The factory opens a PR and stops, by design. Auto-merge on green CI, or a
  CI-failure repair loop, would be natural next stations gated behind a stricter policy.
