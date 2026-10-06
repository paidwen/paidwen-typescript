import assert from "node:assert/strict";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import {
  type Decision,
  DeniedError,
  Paidwen,
  PaidwenError,
  type PaidwenOptions,
  PendingError,
  RequestError,
  type Verdict,
} from "../src/index.ts";
import { DISABLED } from "./fake.ts";

const ACTION_ID = "6f1c2a7e-3b5d-4c8e-9a10-2f4b6d8e0a12";
const INCIDENT_ID = "3c7e5a10-9b2d-4f6e-8a1c-5d4b3a2f1e0d";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const QUOTA_CAUSE =
  "Paidwen answered HTTP 503 because the organization reached the events its plan allows this month";
const QUOTA = {
  type: "https://paidwen.com/problems/quota-exceeded",
  title: "The organization reached the events its plan allows this month.",
  status: 503,
  detail: "The organization used the 5000 events of the Free plan in October 2026.",
};

interface Call {
  url: string;
  init: RequestInit;
}

function decision(verdict: Verdict, ruleId: string | null = null): Decision {
  return {
    action_id: ACTION_ID,
    verdict,
    rule_id: ruleId,
    observed: [],
    decided_at: "2026-10-05T09:00:00Z",
  };
}

function server(status: number, body: unknown, calls: Call[] = []): typeof fetch {
  return async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  };
}

function client(transport: typeof fetch, options: PaidwenOptions = {}): Paidwen {
  return new Paidwen({
    apiKey: "pw_test_key",
    baseUrl: "https://api.example.test/",
    fetch: transport,
    journal: false,
    ...options,
  });
}

const hanging: typeof fetch = (_url, init) =>
  new Promise((_resolve, reject) => {
    const openConnection = setTimeout(() => undefined, 60_000);
    init?.signal?.addEventListener("abort", () => {
      clearTimeout(openConnection);
      reject(init.signal?.reason);
    });
  });

describe("decide", () => {
  let warn: ReturnType<typeof mock.method>;

  beforeEach(() => {
    warn = mock.method(console, "warn", () => undefined);
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("asks the decision endpoint with the agent key", async () => {
    const calls: Call[] = [];
    const answer = decision("allow");
    const result = await client(server(200, answer, calls)).decide({
      tool: { name: "payments.refund", kind: "function" },
      params: { amount: 120 },
      cost: { estimated_usd: 0.01 },
    });
    assert.deepEqual(result, answer);
    assert.equal(calls.length, 1);
    const [call] = calls;
    assert.equal(call?.url, "https://api.example.test/v1/decisions");
    assert.equal(call?.init.method, "POST");
    const headers = new Headers(call?.init.headers);
    assert.equal(headers.get("authorization"), "Bearer pw_test_key");
    assert.equal(headers.get("content-type"), "application/json");
    const sent = JSON.parse(String(call?.init.body));
    assert.match(sent.action_id, UUID);
    assert.deepEqual(sent.tool, { name: "payments.refund", kind: "function" });
    assert.deepEqual(sent.params, { amount: 120 });
    assert.deepEqual(sent.cost, { estimated_usd: 0.01 });
  });

  it("keeps the action identifier given by the agent", async () => {
    const calls: Call[] = [];
    await client(server(200, decision("allow"), calls)).decide({
      action_id: ACTION_ID,
      tool: { name: "x", kind: "http" },
    });
    assert.equal(JSON.parse(String(calls[0]?.init.body)).action_id, ACTION_ID);
  });

  it("blocks by default when Paidwen does not answer in time", async () => {
    const started = Date.now();
    const result = await client(hanging, { timeoutMs: 50 }).decide({
      action_id: ACTION_ID,
      tool: { name: "x", kind: "function" },
    });
    assert.ok(Date.now() - started < 1000);
    assert.equal(result.verdict, "block");
    assert.equal(result.rule_id, null);
    assert.deepEqual(result.observed, []);
    assert.equal(result.action_id, ACTION_ID);
    assert.equal(warn.mock.callCount(), 1);
  });

  it("gives up on a silent server", async () => {
    const sockets = new Set<Socket>();
    const silent = createServer((socket) => sockets.add(socket));
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      const started = Date.now();
      const result = await new Paidwen({
        apiKey: "pw_test_key",
        baseUrl: `http://127.0.0.1:${port}`,
        timeoutMs: 200,
        journal: false,
      }).decide({ tool: { name: "x", kind: "function" } });
      const elapsed = Date.now() - started;
      assert.equal(result.verdict, "block");
      assert.ok(elapsed >= 190 && elapsed < 2000, `elapsed ${elapsed} ms`);
    } finally {
      for (const socket of sockets) socket.destroy();
      silent.close();
    }
  });

  it("allows when the agent chose so and Paidwen does not answer", async () => {
    const result = await client(hanging, { timeoutMs: 50, onUnavailable: "allow" }).decide({
      tool: { name: "x", kind: "function" },
    });
    assert.equal(result.verdict, "allow");
  });

  it("applies the fallback on a network error, a server error or an unreadable answer", async () => {
    const failures: (typeof fetch)[] = [
      async () => {
        throw new TypeError("fetch failed");
      },
      server(503, { title: "down" }),
      server(200, "<html>"),
    ];
    for (const failure of failures) {
      const result = await client(failure).decide({ tool: { name: "x", kind: "function" } });
      assert.equal(result.verdict, "block");
    }
    assert.equal(warn.mock.callCount(), failures.length);
  });

  it("throws a request error when Paidwen refuses the request", async () => {
    const problem = {
      type: "https://paidwen.com/problems/unauthorized",
      title: "The agent key is missing, malformed or unknown.",
      status: 401,
      detail: "The agent key is unknown.",
    };
    await assert.rejects(
      client(server(401, problem)).decide({ tool: { name: "x", kind: "function" } }),
      (error: unknown) =>
        error instanceof RequestError &&
        error.status === 401 &&
        error.message === "The agent key is unknown." &&
        error.problem?.type === problem.type,
    );
    assert.equal(warn.mock.callCount(), 0);
  });

  it("says that Paidwen refused the agent on a 403, and never retries nor falls back", async () => {
    const calls: Call[] = [];
    const ask = (body: unknown) =>
      client(server(403, body, calls), { onUnavailable: "allow" }).decide({
        tool: { name: "x", kind: "function" },
      });
    await assert.rejects(
      ask(DISABLED),
      (error: unknown) =>
        error instanceof RequestError &&
        error.status === 403 &&
        error.message ===
          "Paidwen refused the agent: The agent is disabled until someone enables it." &&
        error.problem?.type === "https://paidwen.com/problems/agent-disabled",
    );
    await assert.rejects(ask({ ...DISABLED, detail: undefined }), {
      message: "Paidwen refused the agent: The agent is disabled.",
    });
    await assert.rejects(ask(""), { message: "Paidwen refused the agent with HTTP 403." });
    assert.equal(calls.length, 3);
    assert.equal(warn.mock.callCount(), 0);
  });

  it("applies onUnavailable when the organization reached its quota, and names the cause", async () => {
    const blocked = await client(server(503, QUOTA)).decide({
      tool: { name: "x", kind: "function" },
    });
    const allowed = await client(server(503, QUOTA), { onUnavailable: "allow" }).decide({
      tool: { name: "x", kind: "function" },
    });
    assert.equal(blocked.verdict, "block");
    assert.equal(allowed.verdict, "allow");
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments[0]),
      [
        `${QUOTA_CAUSE}, so the SDK applies onUnavailable "block": ${QUOTA.detail}`,
        `${QUOTA_CAUSE}, so the SDK applies onUnavailable "allow": ${QUOTA.detail}`,
      ],
    );
  });

  it("repeats the problem of a server error in its warning", async () => {
    const starting = {
      type: "https://paidwen.com/problems/unavailable",
      title: "The service cannot answer yet.",
      status: 503,
    };
    await client(server(503, starting)).decide({ tool: { name: "x", kind: "function" } });
    await client(server(502, "<html>")).decide({ tool: { name: "x", kind: "function" } });
    assert.deepEqual(
      warn.mock.calls.map((call) => call.arguments[0]),
      [
        'Paidwen answered HTTP 503, so the SDK applies onUnavailable "block": The service cannot answer yet.',
        'Paidwen answered HTTP 502, so the SDK applies onUnavailable "block".',
      ],
    );
  });
});

describe("tool", () => {
  afterEach(() => {
    mock.restoreAll();
  });

  it("runs the function when Paidwen allows it", async () => {
    const calls: Call[] = [];
    const refund = client(server(200, decision("allow"), calls)).tool(
      "payments.refund",
      async (params: { order: string; amount: number }) => `refunded ${params.amount}`,
    );
    assert.equal(await refund({ order: "4821", amount: 120 }), "refunded 120");
    const sent = JSON.parse(String(calls[0]?.init.body));
    assert.deepEqual(sent.tool, { name: "payments.refund", kind: "function" });
    assert.deepEqual(sent.params, { order: "4821", amount: 120 });
  });

  it("sends the cost that the agent estimates for the tool", async () => {
    const calls: Call[] = [];
    const paidwen = client(server(200, decision("allow"), calls));
    await paidwen.tool("search.web", async () => "found", { cost: { estimated_usd: 0.001 } })({});
    await paidwen.tool("payments.refund", async (params: { amount: number }) => params.amount, {
      cost: (params) => ({ estimated_usd: params.amount / 1000 }),
    })({ amount: 250 });
    await paidwen.tool("free", async () => "ok", { cost: () => undefined })({});
    const sent = calls.map((call) => JSON.parse(String(call.init.body)));
    assert.deepEqual(sent[0].cost, { estimated_usd: 0.001 });
    assert.deepEqual(sent[1].cost, { estimated_usd: 0.25 });
    assert.equal(sent[2].cost, undefined);
  });

  it("never runs the function when Paidwen denies it", async () => {
    for (const verdict of ["block", "quarantine"] as const) {
      const run = mock.fn(() => "done");
      const wrapped = client(server(200, decision(verdict, "rule-1"))).tool("x", run);
      await assert.rejects(
        wrapped({}),
        (error: unknown) =>
          error instanceof DeniedError &&
          error instanceof PaidwenError &&
          error.decision.verdict === verdict &&
          error.message === `Paidwen answered ${verdict} for action ${ACTION_ID} by rule rule-1.`,
      );
      assert.equal(run.mock.callCount(), 0);
    }
  });

  it("says when the permissions of the agent refuse the action", async () => {
    const refused: Decision = { ...decision("block"), permission: { allowed: false } };
    await assert.rejects(
      client(server(200, refused)).tool("x", () => "done")({}),
      (error: unknown) =>
        error instanceof DeniedError &&
        error.message ===
          `Paidwen answered block for action ${ACTION_ID} because the permissions of the agent do not allow it.`,
    );
  });

  it("says that the agent is in quarantine and names the incident", async () => {
    const incident = { id: INCIDENT_ID, kind: "quarantine" as const };
    const cases: [Decision, string][] = [
      [
        { ...decision("quarantine"), incident },
        `Paidwen answered quarantine for action ${ACTION_ID} because the agent is in quarantine (incident ${INCIDENT_ID}).`,
      ],
      [
        { ...decision("quarantine", "rule-7"), incident },
        `Paidwen answered quarantine for action ${ACTION_ID} by rule rule-7, and the agent is in quarantine (incident ${INCIDENT_ID}).`,
      ],
      [
        { ...decision("allow"), incident },
        `Paidwen answered allow for action ${ACTION_ID} because the agent is in quarantine (incident ${INCIDENT_ID}).`,
      ],
    ];
    for (const [answer, message] of cases) {
      const run = mock.fn(() => "done");
      await assert.rejects(client(server(200, answer)).tool("x", run)({}), (error: unknown) => {
        assert.ok(error instanceof DeniedError);
        assert.equal(error.message, message);
        assert.deepEqual(error.incident, incident);
        assert.deepEqual(error.decision.incident, incident);
        return true;
      });
      assert.equal(run.mock.callCount(), 0);
    }
  });

  it("never runs the function when Paidwen refuses the agent, even with onUnavailable allow", async () => {
    const calls: Call[] = [];
    const run = mock.fn(() => "done");
    const wrapped = client(server(403, DISABLED, calls), { onUnavailable: "allow" }).tool("x", run);
    await assert.rejects(wrapped({}), RequestError);
    assert.equal(run.mock.callCount(), 0);
    assert.equal(calls.length, 1);
  });

  it("runs the function when the quota is reached and the agent chose allow", async () => {
    mock.method(console, "warn", () => undefined);
    const run = mock.fn(() => "done");
    const wrapped = client(server(503, QUOTA), { onUnavailable: "allow" }).tool("x", run);
    assert.equal(await wrapped({}), "done");
    assert.equal(run.mock.callCount(), 1);
    await assert.rejects(client(server(503, QUOTA)).tool("x", run)({}), DeniedError);
    assert.equal(run.mock.callCount(), 1);
  });

  it("waits when Paidwen asks for a human answer", async () => {
    for (const verdict of ["require_approval", "escalate"] as const) {
      const run = mock.fn(() => "done");
      const wrapped = client(server(200, decision(verdict, "rule-1"))).tool("x", run);
      await assert.rejects(
        wrapped({}),
        (error: unknown) => error instanceof PendingError && error.decision.verdict === verdict,
      );
      assert.equal(run.mock.callCount(), 0);
    }
  });

  it("refuses the action when Paidwen is down and the agent blocks by default", async () => {
    mock.method(console, "warn", () => undefined);
    const run = mock.fn(() => "done");
    await assert.rejects(client(hanging, { timeoutMs: 20 }).tool("x", run)({}), DeniedError);
    assert.equal(run.mock.callCount(), 0);
  });
});

describe("the constructor", () => {
  afterEach(() => {
    delete process.env.PAIDWEN_API_KEY;
  });

  it("needs an agent key", () => {
    assert.throws(() => new Paidwen(), PaidwenError);
  });

  it("reads the agent key from the environment", async () => {
    process.env.PAIDWEN_API_KEY = "pw_test_from_env";
    const calls: Call[] = [];
    await new Paidwen({ fetch: server(200, decision("allow"), calls), journal: false }).decide({
      tool: { name: "x", kind: "function" },
    });
    assert.equal(calls[0]?.url, "https://api.paidwen.com/v1/decisions");
    assert.equal(
      new Headers(calls[0]?.init.headers).get("authorization"),
      "Bearer pw_test_from_env",
    );
  });

  it("checks its options", () => {
    assert.throws(
      () => new Paidwen({ apiKey: "k", onUnavailable: "maybe" as "allow" }),
      PaidwenError,
    );
    assert.throws(() => new Paidwen({ apiKey: "k", timeoutMs: 0 }), PaidwenError);
  });
});
