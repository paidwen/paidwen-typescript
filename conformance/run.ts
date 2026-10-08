import { readFileSync } from "node:fs";
import { type DecisionRequest, type Fallback, Paidwen, RequestError } from "../src/index.ts";

interface Step {
  name: string;
  api_key?: string;
  identity_token_file?: string;
  request: DecisionRequest;
  timeout_ms?: number;
  on_unavailable?: Fallback;
}

interface Plan {
  base_url: string;
  steps: Step[];
}

const planPath = process.argv[2];
if (!planPath) {
  throw new Error("usage: node conformance/run.ts <plan.json>");
}
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const results = [];
for (const step of plan.steps) {
  const paidwen = new Paidwen({
    ...(step.api_key === undefined ? {} : { apiKey: step.api_key }),
    ...(step.identity_token_file === undefined
      ? {}
      : { identityTokenFile: step.identity_token_file }),
    baseUrl: plan.base_url,
    ...(step.timeout_ms === undefined ? {} : { timeoutMs: step.timeout_ms }),
    ...(step.on_unavailable === undefined ? {} : { onUnavailable: step.on_unavailable }),
  });
  const started = performance.now();
  try {
    const decision = await paidwen.decide(step.request);
    results.push({ name: step.name, decision, elapsed_ms: performance.now() - started });
  } catch (error) {
    if (!(error instanceof RequestError)) throw error;
    results.push({
      name: step.name,
      error: { status: error.status, type: error.problem?.type ?? null },
      elapsed_ms: performance.now() - started,
    });
  }
}
process.stdout.write(`${JSON.stringify({ results })}\n`);
