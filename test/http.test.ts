import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingHttpHeaders,
  type Server,
} from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { DeniedError, Paidwen, RequestError } from "../src/index.ts";
import {
  AGENT_ID,
  CALLER_ID,
  CLIENT_TRACEPARENT,
  DISABLED,
  decision,
  FakePaidwen,
} from "./fake.ts";

describe("the HTTP capture", () => {
  const fake = new FakePaidwen();
  const received: { method: string; url: string; body: string; headers: IncomingHttpHeaders }[] =
    [];
  let api: Server;
  let apiUrl = "";
  let release: (() => void) | undefined;

  before(async () => {
    await fake.start();
    api = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          method: request.method ?? "",
          url: request.url ?? "",
          body: Buffer.concat(chunks).toString(),
          headers: request.headers,
        });
        response.setHeader("content-type", "application/json");
        response.statusCode = request.url?.startsWith("/missing") ? 404 : 200;
        response.end('{"refund":"re_1"}');
      });
    });
    api.listen(0, "127.0.0.1");
    await once(api, "listening");
    apiUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;
  });

  after(async () => {
    api.closeAllConnections();
    api.close();
    await fake.stop();
  });

  beforeEach(() => {
    received.length = 0;
    fake.decisions.length = 0;
    fake.traces.length = 0;
    fake.answer = (request) => decision(request, "allow");
  });

  afterEach(() => {
    release?.();
    release = undefined;
  });

  function capture(options: Parameters<Paidwen["http"]>[0] = {}, journal = false): Paidwen {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url, journal });
    release = paidwen.http(options);
    return paidwen;
  }

  function got(url: string, headers: Record<string, string> = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      httpGet(url, { headers }, (response) => {
        response.resume();
        response.on("end", resolve);
      }).on("error", reject);
    });
  }

  function sent(): [string, unknown, unknown][] {
    return received.map((call) => [call.url, call.headers.traceparent, call.headers.baggage]);
  }

  it("asks before a fetch and reads the call as a tool", async () => {
    capture();
    const response = await fetch(`${apiUrl}/v1/refunds?expand=charge&sig=abc&tag=a&tag=b`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer sk_live_secret" },
      body: JSON.stringify({
        amount: 2500,
        charge: "ch_1",
        api_key: "sk_live_secret",
        nested: { client_secret: "x" },
      }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { refund: "re_1" });
    assert.equal(received.length, 1);
    assert.equal(fake.decisions.length, 1);
    const asked = fake.decisions[0]?.body as { tool: unknown; params: Record<string, unknown> };
    const host = new URL(apiUrl).host;
    assert.deepEqual(asked.tool, { name: "POST /v1/refunds", kind: "http", server: host });
    assert.deepEqual(asked.params, {
      method: "POST",
      url: `${apiUrl}/v1/refunds`,
      query: { expand: "charge", sig: "REDACTED", tag: ["a", "b"] },
      body: {
        amount: 2500,
        charge: "ch_1",
        api_key: "REDACTED",
        nested: { client_secret: "REDACTED" },
      },
    });
    assert.ok(!JSON.stringify(fake.decisions[0]?.body).includes("sk_live_secret"));
  });

  it("sends the trace and the baggage of the tool with each call, and keeps the headers of the client", async () => {
    fake.answer = (request) => decision(request, "allow", { agent_id: AGENT_ID });
    capture();
    await (await fetch(`${apiUrl}/v1/fetched`)).arrayBuffer();
    await got(`${apiUrl}/v1/requested`);
    await (
      await fetch(`${apiUrl}/v1/kept`, {
        headers: { Traceparent: CLIENT_TRACEPARENT, baggage: "tenant=acme" },
      })
    ).arrayBuffer();
    await (
      await fetch(new Request(`${apiUrl}/v1/partly`, { headers: { Baggage: "tenant=acme" } }))
    ).arrayBuffer();
    await got(`${apiUrl}/v1/kept`, { TRACEPARENT: CLIENT_TRACEPARENT });
    const decided = fake.decisions.map((recorded) => recorded.headers.traceparent);
    const own = `paidwen.agent.id=${AGENT_ID}`;
    assert.deepEqual(sent(), [
      ["/v1/fetched", decided[0], own],
      ["/v1/requested", decided[1], own],
      ["/v1/kept", CLIENT_TRACEPARENT, "tenant=acme"],
      ["/v1/partly", decided[3], "tenant=acme"],
      ["/v1/kept", CLIENT_TRACEPARENT, own],
    ]);
    assert.equal(new Set(decided).size, 5);
  });

  it("gives the trace and the baggage of a tool to the calls made inside it, without a decision", async () => {
    fake.answer = (request) => decision(request, "allow", { agent_id: AGENT_ID });
    const ask = capture().tool("billing.ask", async () => {
      await (await fetch(`${apiUrl}/v1/fetched`)).arrayBuffer();
      await got(`${apiUrl}/v1/requested`);
      await (
        await fetch(`${apiUrl}/v1/kept`, { headers: { traceparent: CLIENT_TRACEPARENT } })
      ).arrayBuffer();
    });
    await ask({});
    assert.equal(fake.decisions.length, 1);
    const tool = fake.decisions[0]?.headers.traceparent;
    const own = `paidwen.agent.id=${AGENT_ID}`;
    assert.deepEqual(sent(), [
      ["/v1/fetched", tool, own],
      ["/v1/requested", tool, own],
      ["/v1/kept", CLIENT_TRACEPARENT, own],
    ]);
  });

  it("gives nothing to a call made inside a tool toward an ignored host", async () => {
    fake.answer = (request) => decision(request, "allow", { agent_id: AGENT_ID });
    await capture({ ignore: ["127.0.0.*"] }).tool("search", async () => {
      await (await fetch(`${apiUrl}/v1/fetched`)).arrayBuffer();
      await got(`${apiUrl}/v1/requested`);
    })({});
    assert.equal(fake.decisions.length, 1);
    assert.deepEqual(sent(), [
      ["/v1/fetched", undefined, undefined],
      ["/v1/requested", undefined, undefined],
    ]);
  });

  it("lets an agent called from a tool of another agent send its caller", async () => {
    const agents: Record<string, string> = {
      "Bearer key-a": CALLER_ID,
      "Bearer key-b": AGENT_ID,
    };
    fake.answer = (request) =>
      decision(request, "allow", {
        agent_id: agents[String(fake.decisions.at(-1)?.headers.authorization)],
      });
    const billing = new Paidwen({ apiKey: "key-b", baseUrl: fake.url, journal: false });
    const refund = billing.tool("refunds.create", async () => "re_1");
    const service = createServer((request, response) =>
      billing.context({ headers: request.headers }, async () => {
        response.end(await refund({}));
      }),
    );
    service.listen(0, "127.0.0.1");
    await once(service, "listening");
    try {
      const triage = new Paidwen({ apiKey: "key-a", baseUrl: fake.url, journal: false });
      release = triage.http();
      const port = (service.address() as AddressInfo).port;
      const ask = triage.tool("billing.ask", async () =>
        (await fetch(`http://127.0.0.1:${port}/ask`)).text(),
      );
      assert.equal(await ask({}), "re_1");
    } finally {
      service.closeAllConnections();
      service.close();
    }
    const [asked, refunded] = fake.decisions.map((recorded) => ({
      key: recorded.headers.authorization,
      traceparent: String(recorded.headers.traceparent),
      context: (recorded.body as { context?: { caller_agent_id?: string } }).context,
    }));
    assert.equal(fake.decisions.length, 2);
    assert.equal(asked?.key, "Bearer key-a");
    assert.equal(asked?.context?.caller_agent_id, undefined);
    assert.equal(refunded?.key, "Bearer key-b");
    assert.equal(refunded?.context?.caller_agent_id, CALLER_ID);
    assert.equal(refunded?.traceparent.split("-")[1], asked?.traceparent.split("-")[1]);
  });

  it("never sends a refused fetch", async () => {
    fake.answer = (request) => decision(request, "block", { rule_id: "no-refunds" });
    capture();
    await assert.rejects(fetch(`${apiUrl}/v1/refunds`, { method: "POST" }), DeniedError);
    assert.equal(received.length, 0);
  });

  it("never sends a call when Paidwen refuses the agent, even with onUnavailable allow", async () => {
    const paidwen = new Paidwen({
      apiKey: "pw_test_key",
      baseUrl: fake.url,
      journal: false,
      onUnavailable: "allow",
      fetch: async () =>
        new Response(JSON.stringify(DISABLED), {
          status: 403,
          headers: { "content-type": "application/problem+json" },
        }),
    });
    release = paidwen.http();
    await assert.rejects(
      fetch(`${apiUrl}/v1/refunds`, { method: "POST" }),
      (error: unknown) => error instanceof RequestError && error.status === 403,
    );
    assert.equal(received.length, 0);
  });

  it("reads the body that an http.request writes, and captures http.get", async () => {
    capture();
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        `${apiUrl}/v1/refunds?expand=charge`,
        { method: "POST", headers: { "content-type": "application/json" } },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      outgoing.on("error", reject);
      outgoing.write('{"amount":2500,');
      outgoing.end('"api_key":"sk_live_secret"}');
    });
    assert.equal(status, 200);
    const fetched = await new Promise<number>((resolve, reject) => {
      httpGet(`${apiUrl}/v1/customers/42`, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      }).on("error", reject);
    });
    assert.equal(fetched, 200);
    const [posted, got] = fake.decisions.map(
      (recorded) => recorded.body as { tool: { name: string }; params: Record<string, unknown> },
    );
    assert.equal(posted?.tool.name, "POST /v1/refunds");
    assert.deepEqual(posted?.params.query, { expand: "charge" });
    assert.deepEqual(posted?.params.body, { amount: 2500, api_key: "REDACTED" });
    assert.equal(got?.tool.name, "GET /v1/customers/42");
    assert.deepEqual(
      received.map((call) => call.body),
      ['{"amount":2500,"api_key":"sk_live_secret"}', ""],
    );
  });

  it("asks for a call that reuses a connection opened before the capture", async () => {
    await (await fetch(`${apiUrl}/v1/before`)).arrayBuffer();
    capture();
    await (await fetch(`${apiUrl}/v1/after`)).arrayBuffer();
    assert.deepEqual(
      fake.decisions.map((recorded) => (recorded.body as { tool: { name: string } }).tool.name),
      ["GET /v1/after"],
    );
  });

  it("asks before an http.request and fails it with the error of the SDK", async () => {
    fake.answer = (request) =>
      decision(
        request,
        (request.tool.name === "DELETE /v1/customers/42" ? "block" : "allow") as "allow" | "block",
      );
    capture();
    const allowed = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(`${apiUrl}/v1/customers/42`, { method: "GET" }, (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.on("error", reject);
      outgoing.end();
    });
    assert.equal(allowed, 200);
    const refused = await new Promise<unknown>((resolve) => {
      const outgoing = httpRequest(`${apiUrl}/v1/customers/42`, { method: "DELETE" }, () =>
        resolve("sent"),
      );
      outgoing.on("error", resolve);
      outgoing.end();
    });
    assert.ok(refused instanceof DeniedError, `the request ended with ${refused}`);
    assert.deepEqual(
      received.map((call) => call.method),
      ["GET"],
    );
  });

  it("reads a form body and leaves an unknown body unread", async () => {
    capture();
    await fetch(`${apiUrl}/v1/refunds`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "amount=2500&charge=ch_1&password=hunter2",
    });
    await fetch(`${apiUrl}/v1/files`, {
      method: "POST",
      headers: { "content-type": "image/png" },
      body: "binary",
    });
    await fetch(`${apiUrl}/v1/large`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ blob: "a".repeat(70_000) }),
    });
    const [form, binary, large] = fake.decisions.map(
      (recorded) => (recorded.body as { params: Record<string, unknown> }).params,
    );
    assert.deepEqual(form?.body, { amount: "2500", charge: "ch_1", password: "REDACTED" });
    assert.equal(binary?.body, undefined);
    assert.equal(large?.body, undefined);
  });

  it("asks nothing for the calls of Paidwen, for ignored hosts, for calls inside an action and after the release", async () => {
    const paidwen = capture({ ignore: ["*.example.test", "localhost"] });
    const search = paidwen.tool("search", async () => {
      const response = await fetch(`${apiUrl}/v1/inside`);
      return response.status;
    });
    assert.equal(await search({}), 200);
    assert.equal(fake.decisions.length, 1, "the nested call inside the action asks nothing");
    release?.();
    release = undefined;
    await fetch(`${apiUrl}/v1/after`);
    assert.equal(fake.decisions.length, 1, "the released capture asks nothing");
    assert.deepEqual(
      received.map((call) => call.url),
      ["/v1/inside", "/v1/after"],
    );
  });

  it("sends each captured call to the journal with its status", async () => {
    const paidwen = capture({}, true);
    await fetch(`${apiUrl}/missing/thing`);
    await paidwen.flush();
    const spans = fake.spans();
    assert.equal(spans.length, 1, "the export of the journal is not captured");
    assert.equal(spans[0]?.name, "execute_tool GET /missing/thing");
    assert.equal(spans[0]?.attributes["paidwen.tool.kind"], "http");
    assert.equal(spans[0]?.attributes["http.response.status_code"], 404);
    assert.equal(spans[0]?.status, 2);
    assert.equal(fake.decisions.length, 1);
    await paidwen.shutdown();
  });

  it("sends no result for a captured call, even with the content capture on", async () => {
    process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT = "true";
    const paidwen = capture({}, true);
    delete process.env.OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT;
    await fetch(`${apiUrl}/v1/refunds`);
    await paidwen.flush();
    const spans = fake.spans();
    assert.equal(spans.length, 1);
    assert.equal(spans[0]?.attributes["gen_ai.tool.call.result"], undefined);
    await paidwen.shutdown();
  });

  it("asks nothing for an ignored host", async () => {
    capture({ ignore: ["127.0.0.*"] });
    await fetch(`${apiUrl}/v1/ignored`);
    assert.equal(fake.decisions.length, 0);
    assert.deepEqual(
      received.map((call) => call.url),
      ["/v1/ignored"],
    );
  });

  it("refuses a second capture in the same process", () => {
    const paidwen = capture();
    assert.throws(() => paidwen.http(), /already captured/);
    const other = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url, journal: false });
    assert.throws(() => other.http(), /already captured/);
  });
});
