import { Paidwen } from "../src/index.ts";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set.`);
  return value;
}

const audience = required("PAIDWEN_AUDIENCE");

async function githubToken(): Promise<string> {
  const url = new URL(required("ACTIONS_ID_TOKEN_REQUEST_URL"));
  url.searchParams.set("audience", audience);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${required("ACTIONS_ID_TOKEN_REQUEST_TOKEN")}` },
  });
  if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status}.`);
  const { value } = (await response.json()) as { value: string };
  return value;
}

const paidwen = new Paidwen({ baseUrl: required("PAIDWEN_BASE_URL"), identityToken: githubToken });
const started = performance.now();
const decision = await paidwen.decide({
  tool: { name: "release.publish", kind: "function" },
  params: { repository: process.env.GITHUB_REPOSITORY, run: process.env.GITHUB_RUN_ID },
});
const elapsed = Math.round(performance.now() - started);
const release = paidwen.tool("release.publish", async (params: { version: string }) => params);
await release({ version: "0.0.0" });
await paidwen.shutdown();
console.log(
  JSON.stringify({ language: "TypeScript", verdict: decision.verdict, elapsed_ms: elapsed }),
);
if (decision.verdict !== "allow") process.exit(1);
