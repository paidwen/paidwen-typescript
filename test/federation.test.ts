import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { Paidwen, PaidwenError, RequestError } from "../src/index.ts";

const ACTION_ID = "6f1c2a7e-3b5d-4c8e-9a10-2f4b6d8e0a12";
const BASE = "https://api.example.test";

interface Exchange {
  form: URLSearchParams;
}

class Platform {
  exchanges: Exchange[] = [];
  authorizations: string[] = [];
  issued = 0;
  expiresIn = 900;
  exchangeStatus = 200;
  exchangeBody: unknown;
  decisionStatus: number[] = [];

  fetch: typeof fetch = async (url, init) => {
    const address = String(url);
    const headers = new Headers(init?.headers);
    if (address === `${BASE}/v1/oauth/token`) {
      this.exchanges.push({ form: new URLSearchParams(String(init?.body)) });
      if (this.exchangeStatus !== 200) {
        return Response.json(this.exchangeBody ?? { error: "invalid_request" }, {
          status: this.exchangeStatus,
        });
      }
      this.issued += 1;
      return Response.json({
        access_token: `agent-token-${this.issued}`,
        issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
        token_type: "Bearer",
        expires_in: this.expiresIn,
      });
    }
    this.authorizations.push(headers.get("authorization") ?? "");
    const status = this.decisionStatus.shift() ?? 200;
    if (status !== 200) {
      return Response.json({ type: "x", title: "The agent token is invalid.", status }, { status });
    }
    return Response.json({
      action_id: ACTION_ID,
      verdict: "allow",
      rule_id: null,
      observed: [],
      decided_at: new Date().toISOString(),
    });
  };
}

const ask = { tool: { name: "payments.refund", kind: "function" as const }, action_id: ACTION_ID };

describe("the identity federation of the SDK", () => {
  let work: string;
  let platform: Platform;
  let tokenFile: string;

  beforeEach(() => {
    work = mkdtempSync(path.join(tmpdir(), "paidwen-federation-"));
    tokenFile = path.join(work, "token");
    writeFileSync(tokenFile, "platform-token-1\n");
    platform = new Platform();
    mock.method(console, "warn", () => undefined);
  });

  afterEach(() => {
    rmSync(work, { recursive: true, force: true });
    mock.restoreAll();
    delete process.env.PAIDWEN_API_KEY;
    delete process.env.PAIDWEN_IDENTITY_TOKEN_FILE;
  });

  function client(options: ConstructorParameters<typeof Paidwen>[0] = {}): Paidwen {
    return new Paidwen({
      baseUrl: BASE,
      fetch: platform.fetch,
      journal: false,
      identityTokenFile: tokenFile,
      ...options,
    });
  }

  it("exchanges the token of the file once and sends the agent token", async () => {
    const paidwen = client();
    await paidwen.decide(ask);
    await paidwen.decide(ask);
    assert.equal(platform.exchanges.length, 1);
    const form = platform.exchanges[0]?.form;
    assert.equal(form?.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
    assert.equal(form?.get("subject_token"), "platform-token-1");
    assert.equal(form?.get("subject_token_type"), "urn:ietf:params:oauth:token-type:jwt");
    assert.deepEqual(platform.authorizations, ["Bearer agent-token-1", "Bearer agent-token-1"]);
  });

  it("exchanges again when less than five minutes remain, and reads the file again", async () => {
    platform.expiresIn = 240;
    const paidwen = client();
    await paidwen.decide(ask);
    writeFileSync(tokenFile, "platform-token-2");
    await paidwen.decide(ask);
    assert.equal(platform.exchanges.length, 2);
    assert.equal(platform.exchanges[1]?.form.get("subject_token"), "platform-token-2");
    assert.deepEqual(platform.authorizations, ["Bearer agent-token-1", "Bearer agent-token-2"]);
  });

  it("shares one exchange between simultaneous decisions", async () => {
    const paidwen = client();
    await Promise.all([paidwen.decide(ask), paidwen.decide(ask), paidwen.decide(ask)]);
    assert.equal(platform.exchanges.length, 1);
  });

  it("keeps a valid token when its renewal finds Paidwen unavailable", async () => {
    platform.expiresIn = 240;
    const paidwen = client();
    await paidwen.decide(ask);
    platform.exchangeStatus = 503;
    const decision = await paidwen.decide(ask);
    assert.equal(decision.verdict, "allow");
    assert.deepEqual(platform.authorizations, ["Bearer agent-token-1", "Bearer agent-token-1"]);
  });

  it("raises the refusal of the exchange, and the action never runs", async () => {
    platform.exchangeStatus = 400;
    platform.exchangeBody = {
      error: "invalid_request",
      error_description: "No enabled trust rule of the organization accepts the subject token.",
    };
    const paidwen = client();
    let ran = false;
    const refund = paidwen.tool("payments.refund", async () => {
      ran = true;
    });
    await assert.rejects(refund({ amount: 10 }), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.status, 400);
      assert.match(error.message, /No enabled trust rule/);
      return true;
    });
    assert.equal(ran, false);
    assert.equal(platform.authorizations.length, 0);
  });

  it("applies onUnavailable when the exchange finds Paidwen down", async () => {
    platform.exchangeStatus = 503;
    assert.equal((await client().decide(ask)).verdict, "block");
    assert.equal((await client({ onUnavailable: "allow" }).decide(ask)).verdict, "allow");
    const down = client({
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    assert.equal((await down.decide(ask)).verdict, "block");
  });

  it("exchanges again once after a refused agent token", async () => {
    platform.decisionStatus = [401];
    const decision = await client().decide(ask);
    assert.equal(decision.verdict, "allow");
    assert.equal(platform.exchanges.length, 2);
    assert.deepEqual(platform.authorizations, ["Bearer agent-token-1", "Bearer agent-token-2"]);
  });

  it("raises a second refusal of the agent token", async () => {
    platform.decisionStatus = [401, 401];
    await assert.rejects(client().decide(ask), (error: unknown) => {
      assert.ok(error instanceof RequestError);
      assert.equal(error.status, 401);
      return true;
    });
    assert.equal(platform.exchanges.length, 2);
  });

  it("reads the identity token from a function", async () => {
    let calls = 0;
    const paidwen = client({
      identityTokenFile: undefined,
      identityToken: async () => {
        calls += 1;
        return `from-function-${calls}`;
      },
    });
    await paidwen.decide(ask);
    assert.equal(platform.exchanges[0]?.form.get("subject_token"), "from-function-1");
  });

  it("refuses two ways to prove the identity", () => {
    assert.throws(() => client({ apiKey: "pw_test_key" }), PaidwenError);
    process.env.PAIDWEN_API_KEY = "pw_test_key";
    process.env.PAIDWEN_IDENTITY_TOKEN_FILE = tokenFile;
    assert.throws(
      () => new Paidwen({ baseUrl: BASE, fetch: platform.fetch, journal: false }),
      /Keep only one/,
    );
    delete process.env.PAIDWEN_API_KEY;
    const fromEnvironment = new Paidwen({ baseUrl: BASE, fetch: platform.fetch, journal: false });
    return fromEnvironment.decide(ask).then(() => {
      assert.equal(platform.exchanges.length, 1);
    });
  });

  it("raises when the identity token cannot be read", async () => {
    const paidwen = client({ identityTokenFile: path.join(work, "missing") });
    await assert.rejects(paidwen.decide(ask), (error: unknown) => {
      assert.ok(error instanceof PaidwenError);
      assert.match((error as Error).message, /could not read the identity token/);
      return true;
    });
    writeFileSync(tokenFile, "   ");
    await assert.rejects(client().decide(ask), /identity token is empty/);
  });
});
