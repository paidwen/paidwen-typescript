import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { DeniedError, Paidwen } from "../src/index.ts";
import { decision, FakePaidwen } from "./fake.ts";

describe("the HTTP capture", () => {
  const fake = new FakePaidwen();
  const received: { method: string; url: string; body: string }[] = [];
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

  it("never sends a refused fetch", async () => {
    fake.answer = (request) => decision(request, "block", { rule_id: "no-refunds" });
    capture();
    await assert.rejects(fetch(`${apiUrl}/v1/refunds`, { method: "POST" }), (error: unknown) => {
      assert.ok(error instanceof TypeError);
      assert.ok(error.cause instanceof DeniedError);
      return true;
    });
    assert.equal(received.length, 0);
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

  it("asks nothing for an ignored host", async () => {
    capture({ ignore: ["127.0.0.*"] });
    await fetch(`${apiUrl}/v1/ignored`);
    assert.equal(fake.decisions.length, 0);
    assert.deepEqual(
      received.map((call) => call.url),
      ["/v1/ignored"],
    );
  });

  it("refuses a second capture", () => {
    const paidwen = capture();
    assert.throws(() => paidwen.http(), /already captured/);
  });
});
