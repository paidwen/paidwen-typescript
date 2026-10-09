import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { context, trace } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { DeniedError, Paidwen } from "../src/index.ts";
import { bodyOf, decision, FakePaidwen, until } from "./fake.ts";

describe("the journal of the SDK", () => {
  const fake = new FakePaidwen();

  before(async () => {
    await fake.start();
  });

  after(async () => {
    await fake.stop();
  });

  beforeEach(() => {
    fake.decisions.length = 0;
    fake.traces.length = 0;
    fake.answer = (request) => decision(request, "allow");
  });

  it("sends each tool call as an execute_tool span with the key of the agent", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    await paidwen.tool("payments.refund", async () => "ok")({ amount: 12 });
    fake.answer = (request) => decision(request, "block", { rule_id: "no-refunds" });
    await assert.rejects(
      paidwen.tool("payments.refund", async () => "ok")({ amount: 13 }),
      DeniedError,
    );
    await paidwen.flush();
    await until("the spans", () => fake.spans().length === 2);
    assert.equal(fake.traces[0]?.headers.authorization, "Bearer pw_test_key");
    assert.equal(fake.traces[0]?.headers["content-type"], "application/json");
    const [allowed, denied] = fake.spans();
    assert.equal(allowed?.name, "execute_tool payments.refund");
    assert.equal(allowed?.attributes["gen_ai.operation.name"], "execute_tool");
    assert.equal(allowed?.attributes["gen_ai.tool.name"], "payments.refund");
    assert.equal(allowed?.attributes["paidwen.tool.kind"], "function");
    assert.equal(
      allowed?.attributes["paidwen.action.id"],
      bodyOf<{ action_id: string }>(fake.decisions[0]).action_id,
    );
    assert.deepEqual(allowed?.events, ["paidwen.action.started"]);
    assert.equal(allowed?.status, 1);
    assert.deepEqual(denied?.events, []);
    assert.equal(denied?.status, 2);
    assert.equal(denied?.attributes["error.type"], "DeniedError");
    const header = String(fake.decisions[0]?.headers.traceparent);
    assert.equal(header.split("-")[2], allowed?.spanId);
    await paidwen.shutdown();
  });

  it("sends the spans with the agent token of the identity federation", async () => {
    const paidwen = new Paidwen({ identityToken: () => "platform-token", baseUrl: fake.url });
    await paidwen.tool("payments.refund", async () => "ok")({ amount: 12 });
    await paidwen.flush();
    await until("the spans", () => fake.spans().length === 1);
    assert.equal(fake.decisions[0]?.headers.authorization, "Bearer agent-token-1");
    assert.equal(fake.traces[0]?.headers.authorization, "Bearer agent-token-1");
    assert.equal(fake.exchanges.length, 1);
    assert.equal(fake.exchanges[0]?.get("subject_token"), "platform-token");
    await paidwen.shutdown();
  });

  it("sends a model call at once, and its next question waits for it", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    const provider = new BasicTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
    const tracer = provider.getTracer("an-instrumentation");
    const model = tracer.startSpan("chat gpt-4o-mini", {
      attributes: {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": "openai",
        "gen_ai.request.model": "gpt-4o-mini",
        "gen_ai.usage.input_tokens": 10_000,
        "gen_ai.usage.output_tokens": 1_000,
      },
    });
    model.end();
    tracer.startSpan("GET /health", { attributes: { "http.request.method": "GET" } }).end();
    await paidwen.decide({ tool: { name: "search", kind: "function" } });
    const sent = fake.traces.at(-1);
    assert.ok(
      sent && sent.at <= (fake.decisions[0]?.at ?? 0),
      "the model call left before the question",
    );
    const spans = fake.spans();
    assert.equal(spans.length, 1, "only the model call is sent");
    assert.equal(spans[0]?.attributes["gen_ai.request.model"], "gpt-4o-mini");
    await provider.shutdown();
    await paidwen.shutdown();
  });

  it("gives the session of the context to the tool call", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    await paidwen.context({ sessionId: "session-4821" }, () =>
      paidwen.tool("search", async () => undefined)({}),
    );
    await paidwen.flush();
    await until("the span", () => fake.spans().length === 1);
    assert.equal(fake.spans()[0]?.attributes["gen_ai.conversation.id"], "session-4821");
    await paidwen.shutdown();
  });

  it("gives the session of the context to the copy of the model call it sends", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    const own = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [paidwen.spanProcessor(), new SimpleSpanProcessor(own)],
    });
    paidwen.context({ sessionId: "session-4821" }, () =>
      provider
        .getTracer("an-instrumentation")
        .startSpan("chat gpt-4o-mini", {
          attributes: { "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o-mini" },
        })
        .end(),
    );
    await provider.forceFlush();
    await until("the model call", () => fake.spans().length === 1);
    const [sent] = fake.spans();
    const [kept] = own.getFinishedSpans();
    assert.equal(sent?.attributes["gen_ai.conversation.id"], "session-4821");
    assert.equal(sent?.attributes["gen_ai.request.model"], "gpt-4o-mini");
    assert.equal(sent?.name, "chat gpt-4o-mini");
    assert.equal(sent?.traceId, kept?.spanContext().traceId);
    assert.equal(sent?.spanId, kept?.spanContext().spanId);
    assert.equal(kept?.attributes["gen_ai.conversation.id"], undefined);
    await provider.shutdown();
    await paidwen.shutdown();
  });

  it("keeps the session that a model call already carries", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    const provider = new BasicTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
    paidwen.context({ sessionId: "session-4821" }, () =>
      provider
        .getTracer("an-instrumentation")
        .startSpan("chat gpt-4o-mini", {
          attributes: { "gen_ai.operation.name": "chat", "gen_ai.conversation.id": "thread-17" },
        })
        .end(),
    );
    await provider.forceFlush();
    await until("the model call", () => fake.spans().length === 1);
    assert.equal(fake.spans()[0]?.attributes["gen_ai.conversation.id"], "thread-17");
    await provider.shutdown();
    await paidwen.shutdown();
  });

  it("gives no session to any span outside a context", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    const provider = new BasicTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
    provider
      .getTracer("an-instrumentation")
      .startSpan("chat gpt-4o-mini", { attributes: { "gen_ai.operation.name": "chat" } })
      .end();
    await paidwen.tool("search", async () => undefined)({});
    await paidwen.flush();
    await until("the spans", () => fake.spans().length === 2);
    for (const span of fake.spans()) {
      assert.equal(span.attributes["gen_ai.conversation.id"], undefined);
    }
    await provider.shutdown();
    await paidwen.shutdown();
  });

  it("makes the tool call a child of the active span of the agent", async () => {
    const manager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(manager);
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    const provider = new BasicTracerProvider();
    const parent = provider.getTracer("agent").startSpan("conversation");
    await context.with(trace.setSpan(context.active(), parent), () =>
      paidwen.tool("search", async () => undefined)({}),
    );
    parent.end();
    context.disable();
    await paidwen.flush();
    await until("the span", () => fake.spans().length === 1);
    assert.equal(fake.spans()[0]?.traceId, parent.spanContext().traceId);
    await paidwen.shutdown();
  });

  it("sends nothing with journal false", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url, journal: false });
    await paidwen.tool("search", async () => undefined)({});
    await paidwen.flush();
    assert.equal(fake.traces.length, 0);
  });
});
