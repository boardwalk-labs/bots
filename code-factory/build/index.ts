// code-factory-build — the workshop station: clone, implement the plan, prove it, push a branch.
//
// This is the ONE station that owns a working copy of the repo. A workflows.call child runs on its
// own task with its own workspace, so the clone -> implement -> test -> push loop has to live in one
// run. The split that matters for quality is preserved anyway: the agent that WRITES the code here is
// never the agent that REVIEWS it (that is code-factory-review).
//
// Secret hygiene: a short-lived GitHub App installation token is minted in the trusted program (see
// github.ts). git clone / push embed it in a one-shot URL and the on-disk remote is reset to a
// token-free URL, so the token never lands in .git/config and never reaches the agent's context.
//
// Build is STATELESS with respect to the remote branch: every round clones the base fresh and
// force-pushes `branch`. On a revision round the prior diff + feedback are handed to the agent as
// context, so it regenerates an improved change from a clean base. That keeps the run idempotent and
// avoids fragile "fetch the half-finished branch" logic.

import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import { phase, agent, input, output, step, type WorkflowMeta } from "@boardwalk-labs/workflow";
import { installationToken } from "./github.js";

const execFileAsync = promisify(execFile);

export const meta = {
  slug: "code-factory-build",
  title: "Code Factory · Build",
  description: "Clone a repo, implement a plan, run its tests, and push a branch.",
  triggers: [{ kind: "manual" }],
  input_schema: {
    type: "object",
    properties: {
      repo: { type: "string" },
      base: { type: "string" },
      branch: { type: "string" },
      plan: { type: "object" },
      issue: { type: "object" },
      prior_diff: { type: "string", description: "Previous attempt, on a revision round." },
      feedback: { type: "string", description: "Reviewer or human change requests, on a revision round." },
    },
    required: ["repo", "base", "branch", "plan", "issue"],
  },
  // GITHUB_APP_ID is a non-secret environment variable; only the private key is a secret.
  permissions: { secrets: [{ name: "GITHUB_APP_PRIVATE_KEY" }] },
  // A coding run can legitimately take a while; cap active compute and dollars, not wall-clock.
  budget: { max_usd: 6, max_duration_seconds: 1800 },
} satisfies WorkflowMeta;

interface BuildInput {
  repo: string;
  base: string;
  branch: string;
  plan: { summary: string; files_to_touch: string[]; approach: string; test_command: string; risks: string[] };
  issue: { title: string; body: string };
  prior_diff?: string;
  feedback?: string;
}
const { repo, base, branch, plan, issue, prior_diff, feedback } = input as BuildInput;

const token = await installationToken(repo);
const authUrl = `https://x-access-token:${token}@github.com/${repo}.git`;
const cleanUrl = `https://github.com/${repo}.git`;
// Clone into the run's writable workspace (the program's own cwd is read-only). The agent's tools are
// rooted at the same workspace, so it sees the checkout as ./repo (AGENT_DIR).
const WORKSPACE = process.env.WORKSPACE_ROOT ?? "/workspace";
const DIR = `${WORKSPACE}/repo`;
const AGENT_DIR = "repo";

// The install token is minted at runtime (not a registered secret), so engine redaction won't catch
// it — scrub it from any exec output so it can never reach the run's error / logs.
function redactToken(s: string): string {
  return token.length === 0 ? s : s.split(token).join("x-access-token:***");
}

interface ExecOut {
  stdout: string;
  stderr: string;
}
async function run(
  file: string,
  args: readonly string[],
  opts: { maxBuffer?: number; timeout?: number } = {},
): Promise<ExecOut> {
  try {
    const { stdout, stderr } = await execFileAsync(file, [...args], {
      maxBuffer: 32 * 1024 * 1024,
      ...opts,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  } catch (err) {
    const e = err as { message?: string; stdout?: string | Buffer; stderr?: string | Buffer };
    throw Object.assign(new Error(redactToken(e.message ?? "command failed")), {
      stdout: redactToken(String(e.stdout ?? "")),
      stderr: redactToken(String(e.stderr ?? "")),
    });
  }
}

async function git(args: readonly string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", DIR, ...args]);
  return stdout;
}

// ── Clone the base and cut the work branch (token used only here, then scrubbed from the remote) ──
console.log(`code-factory-build: cloning ${repo}@${base} -> ${branch}${feedback !== undefined ? " (revision)" : ""}`);
phase("Clone");
await step.run("clone", async () => {
  await run("rm", ["-rf", DIR]);
  await run("git", ["clone", "--depth", "1", "--branch", base, authUrl, DIR], { maxBuffer: 32 * 1024 * 1024 });
  await git(["remote", "set-url", "origin", cleanUrl]); // drop the token from .git/config
  await git(["config", "user.email", "code-factory@boardwalk.sh"]);
  await git(["config", "user.name", "Code Factory"]);
  await git(["checkout", "-b", branch]);
});

// ── Revision: re-apply the previous attempt so the agent FIXES it incrementally instead of
// re-implementing from scratch (the real token saver). Falls back to a from-scratch re-implement if
// the patch doesn't apply cleanly.
let priorApplied = false;
if (feedback !== undefined && prior_diff !== undefined && prior_diff.trim() !== "") {
  priorApplied = await step.run("apply-prior", async () => {
    const patchPath = `${WORKSPACE}/code-factory-prior.patch`;
    writeFileSync(patchPath, prior_diff ?? "");
    try {
      await git(["apply", "--whitespace=nowarn", patchPath]);
      return true;
    } catch {
      return false;
    }
  });
  console.log(
    `code-factory-build: prior change ${priorApplied ? "re-applied (incremental fix)" : "did not apply; re-implementing"}`,
  );
}

// ── Setup: install dependencies DETERMINISTICALLY before the agent runs ──────────────────────────
// The trusted program prepares a ready workspace; the agent does the creative work. This is why the
// test command (a typecheck/test) can resolve imports without the planner having to remember an
// install step. Installs every package.json in the repo (this repo uses per-package deps).
phase("Setup");
const setup = await step.run("install-deps", async () => {
  const found = await run("bash", [
    "-lc",
    `cd ${DIR} && find . -name package.json -not -path '*/node_modules/*' -not -path './.git/*'`,
  ]);
  const pkgDirs = found.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => p.replace(/\/?package\.json$/, "") || ".");
  for (const d of pkgDirs) {
    // --no-package-lock: don't write a lockfile into the working tree (it'd pollute the diff).
    // --no-save @types/node: install the package's deps PLUS Node type defs (the packages use
    // node: builtins / process / Buffer) without touching package.json, so the typecheck resolves.
    await run(
      "bash",
      ["-lc", `cd ${DIR}/${d} && npm install --no-audit --no-fund --no-package-lock --no-save @types/node --loglevel=error`],
      { timeout: 10 * 60 * 1000 },
    );
  }
  return { packages: pkgDirs };
});
console.log(`code-factory-build: installed deps in ${String(setup.packages.length)} package(s)`);

// ── Implement: the agent edits files in the ready checkout ───────────────────────────────────────
phase("Implement");
const revisionNote =
  feedback === undefined
    ? ""
    : priorApplied
      ? `\n\nThis is a REVISION. Your previous change is ALREADY APPLIED to the working tree — read the current files to see it. The reviewer asked for these changes:\n${feedback}\n\nMake ONLY the targeted fixes the feedback calls for. Do not redo the rest of the change.`
      : `\n\nThis is a REVISION. Re-implement the change, addressing this feedback:\n${feedback}\n\nYour previous diff (for reference):\n${(prior_diff ?? "").slice(0, 12_000)}`;

await agent(
  `You are implementing a change in a git checkout located in the ./${AGENT_DIR} directory. Operate
ONLY inside ./${AGENT_DIR}.

Issue: ${issue.title}
${issue.body}

Implementation plan:
- Summary: ${plan.summary}
- Approach: ${plan.approach}
- Files to touch: ${plan.files_to_touch.join(", ")}
- Test command: ${plan.test_command}
- Known risks: ${plan.risks.join("; ") || "none noted"}${revisionNote}

Steps:
1. Read the relevant files first; match the codebase's existing style and conventions.
2. Make the change. Keep it minimal and focused on the issue. Do NOT refactor unrelated code.
3. If the package already has a test setup, add or update a test that covers the change.
Do NOT run the test command, package installs, or any build yourself — the surrounding program runs
\`${plan.test_command}\` after you finish, and version control is handled for you. Keep your tool use
focused: read only what you need, make the edit, then stop (you have a limited tool budget). Do not
run git, push, or any network/auth commands.`,
  { builtins: "all", reasoning: "high" },
);

// ── Prove it: the PROGRAM runs the test command, so pass/fail is objective, not self-reported ─────
phase("Test");
const testRun = await step.run("run-tests", async () => {
  const cmd = plan.test_command.trim();
  if (cmd === "") return { passed: true, output: "(no test command provided)" };
  try {
    const { stdout, stderr } = await run("bash", ["-lc", `cd ${DIR} && ${cmd}`], {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15 * 60 * 1000,
    });
    return { passed: true, output: tail(stdout + stderr) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { passed: false, output: tail((e.stdout ?? "") + (e.stderr ?? "") + (e.message ?? "")) };
  }
});
console.log(`code-factory-build: tests ${testRun.passed ? "passed" : "failed"}`);

// ── Commit, force-push the branch, and report the diff back to the orchestrator ──────────────────
phase("Push");
const result = await step.run("commit-and-push", async () => {
  await git(["add", "-A"]);
  const status = await git(["status", "--porcelain"]);
  if (status.trim() === "") {
    return { branch, diff: "", files_changed: [], pushed: false };
  }
  await git(["commit", "-m", `${issue.title}\n\n${plan.summary}`]);
  const diff = await git(["diff", `origin/${base}...HEAD`]);
  const names = (await git(["diff", "--name-only", `origin/${base}...HEAD`]))
    .split("\n").map((s) => s.trim()).filter(Boolean);
  // Push with a one-shot token URL so the token is never persisted on disk. Plain --force is correct
  // here: we own the code-factory/* branch namespace and regenerate it from base on every round, and
  // an explicit-URL push has no remote-tracking ref for --force-with-lease to lease against.
  await run("git", ["-C", DIR, "push", "--force", authUrl, `HEAD:${branch}`], { maxBuffer: 32 * 1024 * 1024 });
  // The reviewer must see the WHOLE change — this cap is only a guardrail against a pathological diff.
  return { branch, diff: diff.slice(0, 400_000), files_changed: names, pushed: true };
});
console.log(
  result.pushed
    ? `code-factory-build: pushed ${String(result.files_changed.length)} file(s) to ${branch}`
    : `code-factory-build: no changes to push`,
);

output({
  branch: result.branch,
  diff: result.diff,
  files_changed: result.files_changed,
  pushed: result.pushed,
  tests_passed: testRun.passed,
  test_output: testRun.output,
});

function tail(s: string, n = 6000): string {
  return s.length <= n ? s : `...(truncated)...\n${s.slice(-n)}`;
}
