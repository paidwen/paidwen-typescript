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

function conversationTurn(
  provider: BasicTracerProvider,
  input: Record<string, unknown>[],
  output: Record<string, unknown>[],
): void {
  const span = provider.getTracer("reference-agent").startSpan(`chat ${MODEL}`, {
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "openai",
      "gen_ai.request.model": MODEL,
    },
  });
  span.setAttributes({
    "gen_ai.response.model": MODEL,
    "gen_ai.usage.input_tokens": 1_200,
    "gen_ai.usage.output_tokens": 180,
    "gen_ai.system_instructions": JSON.stringify([
      { type: "text", content: "You help the customers of the shop." },
    ]),
    "gen_ai.input.messages": JSON.stringify(input),
    "gen_ai.output.messages": JSON.stringify(output),
  });
  span.end();
}

async function session(sessionId: string): Promise<void> {
  const paidwen = new Paidwen({
    onWait: (wait) => emit({ event: "waiting", approval_id: wait.approvalId, at: now() }),
  });
  const provider = new BasicTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
  const payments = paidwen.tool(
    "payments.refund",
    async (params: { order: string; amount: number; reason: string }) => ({
      refund: `re_${params.order}`,
    }),
    { cost: { estimated_usd: 0.3 } },
  );
  const question = {
    role: "user",
    parts: [
      { type: "text", content: "My parcel for order 4821 never arrived. Can I get a refund?" },
    ],
  };
  const plan = {
    role: "assistant",
    parts: [
      {
        type: "reasoning",
        content: "The carrier lost the parcel, so a full refund fits the policy.",
      },
      {
        type: "tool_call",
        id: "call_4821",
        name: "payments.refund",
        arguments: { order: "ord_4821", amount: 2500, reason: "lost parcel" },
      },
    ],
    finish_reason: "tool_call",
  };
  const actionId = randomUUID();
  emit({ event: "asking", action_id: actionId, session_id: sessionId, at: now() });
  const result = await paidwen.context({ actionId, sessionId }, async () => {
    conversationTurn(provider, [question], [plan]);
    const refunded = await payments({ order: "ord_4821", amount: 2500, reason: "lost parcel" });
    const answer = {
      role: "tool",
      parts: [{ type: "tool_call_response", id: "call_4821", response: refunded }],
    };
    const reply = {
      role: "assistant",
      parts: [{ type: "text", content: "Your refund of 25.00 USD is on its way." }],
      finish_reason: "stop",
    };
    conversationTurn(provider, [question, plan, answer], [reply]);
    return refunded;
  });
  emit({ event: "done", action_id: actionId, session_id: sessionId, result });
  await provider.shutdown();
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

async function httpCalls(
  target: string,
  calls: number,
  warmup: number,
  captured: boolean,
): Promise<void> {
  const paidwen = captured ? new Paidwen() : undefined;
  const release = paidwen?.http();
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
  const durations = await series(calls);
  release?.();
  await paidwen?.shutdown();
  emit({ event: "measured", durations });
}

const [mode, argument, extra, variant] = process.argv.slice(2);
if (mode === "refund") {
  await refund();
} else if (mode === "session" && argument) {
  await session(argument);
} else if (mode === "loop") {
  await loop(Number(argument ?? "1"));
} else if (mode === "http" && argument) {
  await httpCalls(argument, Number(extra ?? "1000"), 100, variant === "captured");
} else {
  throw new Error(
    "usage: node proof/agent.ts refund | session <id> | loop [parallel] | http <url> [calls] [plain|captured]",
  );
}
