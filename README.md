# bots

Real, installable bots built on [Boardwalk](https://boardwalk.sh). Each one listens to a platform
(GitHub, Slack, and so on) and does a whole job end to end: not a single prompt, but a durable
assembly line of agent workflows with human approval gates where they matter.

Where [`examples`](https://github.com/boardwalk-labs/examples) teaches one primitive at a time, this
repo is the finished product: bots you can deploy and install.

## The bots

| Bot | What it does | Listens to |
| --- | --- | --- |
| [`code-factory`](./code-factory) | Turns a GitHub issue into a reviewed, tested pull request | GitHub issues |
| [`pr-review`](./pr-review) | Reviews every PR (and re-reviews on each new commit) | GitHub pull requests |
| `slack-assistant` | (planned) Answers questions in Slack from your own context | Slack messages |

### The GitHub front door

A GitHub App has a single webhook URL, and every event it subscribes to is delivered there. So
[`github-dispatcher`](./github-dispatcher) is the one place the App's webhook points: it reads each
delivery and routes it to the workflow that handles it (issues to `code-factory`, pull requests to
`pr-review`) via `workflows.run`. Adding a GitHub bot is one new entry in its `ROUTES`. Point the App
at the dispatcher's webhook URL, not at any individual bot.

## How a bot is laid out

A bot is a folder. Inside it, each workflow is a self-contained, separately deployable package (its
own `index.ts` + `package.json`), the same convention the `examples` repo uses:

```
code-factory/
  orchestrator/   the assembly line + the human gate   (slug: code-factory)
  plan/           issue -> implementation plan          (slug: code-factory-plan)
  build/          clone, implement, test, push          (slug: code-factory-build)
  review/         skeptical review of the diff          (slug: code-factory-review)
  README.md       what it does + how to set it up
```

Workflow slugs are unique per Boardwalk org, so each bot prefixes its slugs with its own name. That
keeps `code-factory-plan` from colliding with a future `slack-assistant-plan`.

## Running one

Each bot's README has its own setup, but the shape is always: create the platform app (a GitHub App,
a Slack app), store its credentials as Boardwalk secrets, deploy the workflows, and point the app's
webhook at the bot's entry workflow.

## License

MIT. See [LICENSE](./LICENSE).
