import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { DeniedError, Paidwen, PaidwenError, PendingError, type Verdict } from "../src/index.ts";
import { AGENT_ID, CLIENT_TRACEPARENT, FakePaidwen, until } from "./fake.ts";

interface Asked {
  tool: { name: string; kind: string; server?: string };
  params: Record<string, unknown>;
}

async function connect(served: string[], metas: unknown[] = []): Promise<Client> {
  const server = new Server(
    { name: "payments", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: "refund", inputSchema: { type: "object" } }],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    served.push(request.params.name);
    metas.push(request.params._meta);
    return { content: [{ type: "text", text: `refunded ${request.params.arguments?.amount}` }] };
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: "agent", version: "1.0.0" });
  await client.connect(clientSide);
  return client;
}

function answering(verdict: Verdict, asked: Asked[]): Paidwen {
  return new Paidwen({
    apiKey: "pw_test_key",
    baseUrl: "https://api.example.test",
    journal: false,
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      asked.push({ tool: request.tool, params: request.params });
      const decision = {
        action_id: request.action_id,
        verdict,
        rule_id: verdict === "allow" ? null : "rule-1",
        observed: [],
        decided_at: "2026-10-05T09:00:00Z",
      };
      return new Response(JSON.stringify(decision), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
}

describe("mcp", () => {
  it("asks Paidwen before each tool call of every client of the class", async () => {
    const asked: Asked[] = [];
    const served: string[] = [];
    const release = answering("allow", asked).mcp(Client);
    try {
      const client = await connect(served);
      await client.listTools();
      const result = await client.callTool({
        name: "refund",
        arguments: { order: "4821", amount: 120 },
      });
      assert.deepEqual(result.content, [{ type: "text", text: "refunded 120" }]);
      assert.deepEqual(asked, [
        {
          tool: { name: "refund", kind: "mcp", server: "payments" },
          params: { order: "4821", amount: 120 },
        },
      ]);
      assert.deepEqual(served, ["refund"]);
    } finally {
      release();
    }
  });

  it("puts the trace and the baggage of the tool in params._meta, and keeps the values of the client", async () => {
    const decided: string[] = [];
    const paidwen = new Paidwen({
      apiKey: "pw_test_key",
      baseUrl: "https://api.example.test",
      journal: false,
      fetch: async (_url, init) => {
        decided.push(new Headers(init?.headers).get("traceparent") ?? "");
        const request = JSON.parse(String(init?.body));
        const decision = {
          action_id: request.action_id,
          agent_id: AGENT_ID,
          verdict: "allow",
          rule_id: null,
          observed: [],
          decided_at: "2026-10-05T09:00:00Z",
        };
        return new Response(JSON.stringify(decision), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    const metas: unknown[] = [];
    const release = paidwen.mcp(Client);
    try {
      const client = await connect([], metas);
      await client.callTool({ name: "refund", arguments: { amount: 5 } });
      await client.callTool({
        name: "refund",
        arguments: { amount: 6 },
        _meta: { traceparent: CLIENT_TRACEPARENT, tenant: "acme" },
      });
    } finally {
      release();
    }
    const own = `paidwen.agent.id=${AGENT_ID}`;
    assert.deepEqual(metas, [
      { traceparent: decided[0], baggage: own },
      { traceparent: CLIENT_TRACEPARENT, tenant: "acme", baggage: own },
    ]);
  });

  it("sends the answer of a captured tools/call as the result of its span", async () => {
    const fake = await new FakePaidwen().start();
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url });
    delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    const client = await connect([]);
    const release = paidwen.mcp(client);
    try {
      await client.callTool({ name: "refund", arguments: { amount: 120 } });
      await paidwen.flush();
      await until("the span", () => fake.spans().length === 1);
      assert.equal(
        fake.spans()[0]?.attributes["gen_ai.tool.call.result"],
        '{"content":[{"type":"text","text":"refunded 120"}]}',
      );
    } finally {
      release();
      await paidwen.shutdown();
      await fake.stop();
    }
  });

  it("never sends a refused call to the server", async () => {
    const cases: [Verdict, typeof DeniedError | typeof PendingError][] = [
      ["block", DeniedError],
      ["quarantine", DeniedError],
      ["require_approval", PendingError],
      ["escalate", PendingError],
    ];
    for (const [verdict, error] of cases) {
      const served: string[] = [];
      const release = answering(verdict, []).mcp(Client);
      try {
        const client = await connect(served);
        await assert.rejects(
          client.callTool({ name: "refund", arguments: { amount: 2500 } }),
          (raised: unknown) => raised instanceof error && raised.decision.verdict === verdict,
        );
        assert.deepEqual(served, []);
      } finally {
        release();
      }
    }
  });

  it("captures one client without touching the others", async () => {
    const asked: Asked[] = [];
    const served: string[] = [];
    const captured = await connect(served);
    const other = await connect(served);
    const release = answering("block", asked).mcp(captured);
    try {
      await assert.rejects(captured.callTool({ name: "refund", arguments: {} }), DeniedError);
      await other.callTool({ name: "refund", arguments: { amount: 5 } });
      assert.equal(asked.length, 1);
      assert.deepEqual(served, ["refund"]);
    } finally {
      release();
    }
  });

  it("removes the capture and refuses a second one", async () => {
    const asked: Asked[] = [];
    const paidwen = answering("allow", asked);
    const release = paidwen.mcp(Client);
    assert.throws(() => paidwen.mcp(Client), PaidwenError);
    release();
    const client = await connect([]);
    await client.callTool({ name: "refund", arguments: {} });
    assert.equal(asked.length, 0);
    assert.equal(Object.hasOwn(Client.prototype, "request"), false);
    paidwen.mcp(Client)();
  });

  it("refuses a target that is not an MCP client", () => {
    const paidwen = answering("allow", []);
    for (const target of [{}, { request: "no" }, class Empty {}]) {
      assert.throws(() => paidwen.mcp(target as never), PaidwenError);
    }
  });
});
