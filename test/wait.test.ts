import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import { DeniedError, Paidwen, PendingError, type Wait } from "../src/index.ts";
import { bodyOf, FakePaidwen, status, waiting } from "./fake.ts";

describe("a wrapped function that waits for a human answer", () => {
  const fake = new FakePaidwen();

  before(async () => {
    await fake.start();
  });

  after(async () => {
    await fake.stop();
  });

  beforeEach(() => {
    fake.decisions.length = 0;
    fake.polls.length = 0;
    fake.script = [];
    fake.answer = (request) => waiting(request);
  });

  function client(options: ConstructorParameters<typeof Paidwen>[0] = {}): Paidwen {
    return new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url, journal: false, ...options });
  }

  it("tells the agent once, then runs the function when the approver approves", async () => {
    fake.script = [status("pending"), status("approved")];
    const waits: Wait[] = [];
    let runs = 0;
    const refund = client({ onWait: (wait) => void waits.push(wait) }).tool(
      "payments.refund",
      async () => ++runs,
    );
    const started = Date.now();
    assert.equal(await refund({ amount: 2500 }), 1);
    assert.ok(Date.now() - started >= 2000, "the SDK waits the interval before each poll");
    assert.equal(waits.length, 1);
    assert.equal(waits[0]?.approvalId, "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a");
    assert.equal(waits[0]?.interval, 1);
    assert.equal(waits[0]?.onExpiry, "deny");
    assert.equal(fake.polls.length, 2);
    assert.equal(fake.polls[0]?.path, "/v1/approvals/0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a");
    assert.equal(fake.polls[0]?.headers.authorization, "Bearer pw_test_key");
  });

  it("never runs the function when the approver denies it", async () => {
    fake.script = [status("denied")];
    let runs = 0;
    const refund = client().tool("payments.refund", async () => ++runs);
    await assert.rejects(refund({ amount: 2500 }), (error: unknown) => {
      assert.ok(error instanceof DeniedError);
      assert.equal(error.approval?.status, "denied");
      assert.match(error.message, /the approver denied it/);
      return true;
    });
    assert.equal(runs, 0);
  });

  it("applies what the customer chose when the wait expires", async () => {
    fake.script = [status("expired", "allow")];
    assert.equal(await client().tool("payments.refund", async () => "ran")({}), "ran");
    fake.script = [status("expired", "deny")];
    await assert.rejects(
      client().tool("payments.refund", async () => "ran")({}),
      /expired without an answer/,
    );
  });

  it("adds five seconds to its interval after slow_down", async () => {
    fake.script = [{ status: 429 }, status("approved")];
    const started = Date.now();
    await client().tool("payments.refund", async () => undefined)({});
    const gap = (fake.polls[1]?.at ?? 0) - (fake.polls[0]?.at ?? 0);
    assert.ok(gap >= 6000 && gap < 8000, `the second poll came ${gap} ms after the first`);
    assert.ok(Date.now() - started >= 7000);
  });

  it("keeps polling when Paidwen is briefly unavailable", async () => {
    fake.script = [{ status: 503 }, status("approved")];
    assert.equal(await client().tool("payments.refund", async () => "ran")({}), "ran");
    assert.equal(fake.polls.length, 2);
  });

  it("returns the hand at once with onPending throw", async () => {
    let runs = 0;
    const refund = client({ onPending: "throw" }).tool("payments.refund", async () => ++runs);
    await assert.rejects(refund({}), (error: unknown) => {
      assert.ok(error instanceof PendingError);
      assert.equal(error.decision.approval?.id, "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a");
      return true;
    });
    assert.equal(runs, 0);
    assert.equal(fake.polls.length, 0);
  });

  it("resumes the same action with the same identifier", async () => {
    const paidwen = client({ onPending: "throw" });
    const refund = paidwen.tool("payments.refund", async () => "ran");
    const actionId = "6f1c2a7e-3b5d-4c8e-9a10-2f4b6d8e0a12";
    await assert.rejects(paidwen.context({ actionId }, () => refund({ amount: 2500 })));
    assert.equal(bodyOf<{ action_id: string }>(fake.decisions[0]).action_id, actionId);
    fake.script = [status("approved")];
    const resumed = client();
    const result = await resumed.context({ actionId }, () =>
      resumed.tool("payments.refund", async () => "ran")({ amount: 2500 }),
    );
    assert.equal(result, "ran");
    assert.equal(bodyOf<{ action_id: string }>(fake.decisions[1]).action_id, actionId);
  });
});

describe("the context of Paidwen", () => {
  const fake = new FakePaidwen();

  before(async () => {
    await fake.start();
  });

  after(async () => {
    await fake.stop();
  });

  it("gives its action identifier to the first decision only, and its session to all", async () => {
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url, journal: false });
    await paidwen.context(
      { actionId: "6f1c2a7e-3b5d-4c8e-9a10-2f4b6d8e0a12", sessionId: "session-4821" },
      async () => {
        await paidwen.decide({ tool: { name: "a", kind: "function" } });
        await paidwen.decide({ tool: { name: "b", kind: "function" } });
      },
    );
    const [first, second] = fake.decisions.map(
      (recorded) => recorded.body as { action_id: string; context?: { session_id?: string } },
    );
    assert.equal(first?.action_id, "6f1c2a7e-3b5d-4c8e-9a10-2f4b6d8e0a12");
    assert.notEqual(second?.action_id, first?.action_id);
    assert.equal(first?.context?.session_id, "session-4821");
    assert.equal(second?.context?.session_id, "session-4821");
  });

  it("sends the trace of the tool call with its decision", async () => {
    fake.decisions.length = 0;
    const paidwen = new Paidwen({ apiKey: "pw_test_key", baseUrl: fake.url, journal: false });
    await paidwen.tool("search", async () => undefined)({});
    const recorded = fake.decisions[0];
    const header = String(recorded?.headers.traceparent ?? "");
    assert.match(header, /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    assert.equal(
      bodyOf<{ context: { trace_id: string } }>(recorded).context.trace_id,
      header.split("-")[1],
    );
  });
});
