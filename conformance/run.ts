import { readFileSync } from "node:fs";
import { type DecisionRequest, Paidwen } from "../src/index.ts";

interface Plan {
  base_url: string;
  cases: { name: string; api_key: string; request: DecisionRequest }[];
}

const planPath = process.argv[2];
if (!planPath) {
  throw new Error("usage: node conformance/run.ts <plan.json>");
}
const plan = JSON.parse(readFileSync(planPath, "utf8")) as Plan;
const results = [];
for (const entry of plan.cases) {
  const paidwen = new Paidwen({ apiKey: entry.api_key, baseUrl: plan.base_url });
  results.push({ name: entry.name, decision: await paidwen.decide(entry.request) });
}
process.stdout.write(`${JSON.stringify({ results })}\n`);
