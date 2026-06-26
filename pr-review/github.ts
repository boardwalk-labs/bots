// GitHub App auth for the trusted program layer: mint a short-lived installation token from the
// app's id + private key, plus a thin REST helper. The credentials live only here (secrets.get +
// process.env), never in an agent's prompt or tools.
//
// This file is intentionally duplicated in each deployable package that talks to GitHub so every
// package stays self-contained and bundles cleanly. Keep the copies in sync.

import { createSign } from "node:crypto";
import { secrets } from "@boardwalk-labs/workflow";

const API = "https://api.github.com";

export async function gh(path: string, token: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "boardwalk-code-factory",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub ${init?.method ?? "GET"} ${path} -> ${String(res.status)}: ${await res.text()}`);
  }
  return res.json();
}

// Mint an installation access token scoped to `repo` ("owner/name"). It is short-lived (about an
// hour), so mint it fresh right before you need it rather than memoizing it.
export async function installationToken(repo: string): Promise<string> {
  // GITHUB_APP_ID is a non-secret environment variable (injected from the run's environment); only
  // the private key is a secret. The key is used verbatim — store it as a valid PEM.
  const appId = process.env.GITHUB_APP_ID;
  if (appId === undefined || appId === "") {
    throw new Error("GITHUB_APP_ID is not set — expected as an environment variable in the run's environment.");
  }
  const jwt = appJwt(appId, await secrets.get("GITHUB_APP_PRIVATE_KEY"));
  const install = (await gh(`/repos/${repo}/installation`, jwt)) as { id: number };
  const token = (await gh(`/app/installations/${String(install.id)}/access_tokens`, jwt, {
    method: "POST",
  })) as { token: string };
  return token.token;
}

function appJwt(appId: string, pem: string): string {
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", typ: "JWT" });
  // iat backdated 60s for clock skew; GitHub caps app JWT lifetime at 10 minutes.
  const body = enc({ iat: now - 60, exp: now + 9 * 60, iss: appId });
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem).toString("base64url");
  return `${head}.${body}.${sig}`;
}
