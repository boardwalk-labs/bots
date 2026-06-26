// Helpers for talking to a repo's git remote from the build station.

import { execSync } from "node:child_process";

/**
 * Return the open pull requests for `repo` (an "owner/name" pair taken from the webhook payload),
 * as the raw `gh` output.
 */
export function listOpenPrs(repo: string): string {
  return execSync(`gh pr list --repo ${repo} --state open`).toString();
}

/** Return the last `n` lines of some command output. */
export function lastLines(output: string, n: number): string[] {
  const lines = output.split("\n");
  return lines.slice(lines.length - n);
}
