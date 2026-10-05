import { randomUUID } from "node:crypto";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { DeniedError, Paidwen } from "../src/index.ts";

const MODEL = "gpt-4o-mini";

function now(): number {
  return performance.timeOrigin + performance.now();
}

function emit(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

function fakeModel(provider: BasicTracerProvider, turn: number): string {
  const span = provider.getTracer("reference-agent").startSpan(`chat ${MODEL}`, {
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": MODEL,
    },
  });
  span.setAttributes({
    "gen_ai.response.model": MODEL,
    "gen_ai.usage.input_tokens": 10_000,
    "gen_ai.usage.output_tokens": 1_000,
  });
  span.end();
  return `search the web for turn ${turn}`;
}

async function refund(): Promise<void> {
  let departedAt: number | undefined;
  const paidwen = new Paidwen({
    onWait: (wait) =>
      emit({ event: "waiting", approval_id: wait.approvalId, interval: wait.interval, at: now() }),
  });
  const payments = paidwen.tool(
    "payments.refund",
    async (params: { order: string; amount: number; reason: string }) => {
      departedAt = now();
      return { refund: `re_${params.order}` };
    },
    { cost: { estimated_usd: 0.3 } },
  );
  const actionId = randomUUID();
  emit({ event: "asking", action_id: actionId, at: now() });
  try {
    const result = await paidwen.context({ actionId, sessionId: `proof-${actionId}` }, () =>
      payments({ order: "ord_4821", amount: 2500, reason: "lost parcel" }),
    );
    emit({ event: "done", action_id: actionId, departed_at: departedAt, result });
  } catch (error) {
    if (!(error instanceof DeniedError)) throw error;
    emit({ event: "denied", action_id: actionId, message: error.message });
  }
  await paidwen.shutdown();
}

async function loop(parallel: number): Promise<void> {
  const paidwen = new Paidwen();
  const provider = new BasicTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
  const search = paidwen.tool("search.web", async (params: { query: string }) => [params.query], {
    cost: { estimated_usd: 0.001 },
  });
  const run = async (worker: number) => {
    let turns = 0;
    for (;;) {
      const query = fakeModel(provider, turns);
      try {
        await search({ query });
        turns += 1;
      } catch (error) {
        if (!(error instanceof DeniedError)) throw error;
        return { worker, turns, budget: error.decision.budget ?? null };
      }
    }
  };
  const workers = await Promise.all(Array.from({ length: parallel }, (_, worker) => run(worker)));
  emit({ event: "stopped", workers });
  await provider.shutdown();
  await paidwen.shutdown();
}

async function httpCalls(target: string, calls: number, warmup: number): Promise<void> {
  const body = JSON.stringify({ amount: 2500, currency: "usd", order: "ord_4821" });
  const series = async (count: number) => {
    const durations: number[] = [];
    for (let index = 0; index < count; index += 1) {
      const started = performance.now();
      const response = await fetch(`${target}/v1/refunds`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      await response.arrayBuffer();
      durations.push(performance.now() - started);
    }
    return durations;
  };
  await series(warmup);
  const plain = await series(calls);
  const paidwen = new Paidwen();
  const release = paidwen.http();
  await series(warmup);
  const captured = await series(calls);
  release();
  await paidwen.shutdown();
  emit({ event: "measured", plain, captured });
}

const [mode, argument, extra] = process.argv.slice(2);
if (mode === "refund") {
  await refund();
} else if (mode === "loop") {
  await loop(Number(argument ?? "1"));
} else if (mode === "http" && argument) {
  await httpCalls(argument, Number(extra ?? "1000"), 100);
} else {
  throw new Error("usage: node proof/agent.ts refund | loop [parallel] | http <url> [calls]");
}
