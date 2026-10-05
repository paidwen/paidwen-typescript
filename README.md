# Paidwen SDK for TypeScript

Paidwen controls what AI agents do. Before each action, the agent asks Paidwen whether it may act, then applies the answer. The agent keeps its own tool keys and performs the action itself.

```ts
import { Paidwen } from "paidwen";

const paidwen = new Paidwen();

const refund = paidwen.tool("payments.refund", async (params: { order: string; amount: number }) => {
  await payments.refund(params.order, params.amount);
});
```

`new Paidwen()` reads the agent key from `PAIDWEN_API_KEY`. A call to `refund` asks Paidwen first. It runs when Paidwen allows it, waits when the action needs a human approval, and throws `DeniedError` when Paidwen blocks it or puts the agent in quarantine. When the permissions or the budget of the agent refuse the action, the message of `DeniedError` says so.

## Tool cost

```ts
const search = paidwen.tool("search.web", searchWeb, { cost: { estimated_usd: 0.001 } });
const refund = paidwen.tool("payments.refund", refundOrder, {
  cost: (params) => ({ estimated_usd: 0.3 }),
});
```

`cost` gives the cost that the agent estimates for the tool, fixed or computed from the parameters. The budget of the agent counts it, and the rules read it in `cost.estimated_usd`.

## Human approval

```ts
const paidwen = new Paidwen({
  onWait: (wait) => notifyUser(wait.approvalId, wait.expiresAt),
});
```

When a rule asks for a human approval, the call waits for the answer of the approver. The SDK calls `onWait` once when the wait starts, so the agent can tell its user. The call runs once the approver approves it, and throws `DeniedError` when the approver denies it. When the wait expires, the SDK applies the `on_expiry` choice of the rule: `"deny"` throws `DeniedError`, `"allow"` runs the call.

With `onPending: "throw"`, the call throws `PendingError` at once and the action does not run. The agent retries later with the same action identifier, and Paidwen gives back the same wait:

```ts
await paidwen.context({ actionId }, () => refund({ order: "ord_42", amount: 2500 }));
```

## Context

`paidwen.context({ actionId, sessionId }, fn)` gives its action identifier to the first decision of `fn`, and its session to every decision and journal line of `fn`.

## MCP tool calls

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

paidwen.mcp(Client);
```

`paidwen.mcp(Client)` asks Paidwen before each `tools/call` request of every client of the official MCP SDK in the process, including the clients that an agent framework creates. The question carries the tool name, its arguments and the name that the MCP server announces. A refused call throws `DeniedError` and never reaches the server.

`paidwen.mcp(client)` captures one client only, for a process that runs several agents with their own keys. `mcp()` returns a function that removes the capture.

## HTTP calls

```ts
const release = paidwen.http({ ignore: ["*.internal.example.com"] });
```

`paidwen.http()` asks Paidwen before each outgoing HTTP call of the process: `fetch`, the `http` and `https` modules, undici, and the clients built on them, such as Axios or the SDKs of the providers. The tool name is the method and the path, for example `POST /v1/refunds`, and the server is the host. The parameters carry `method`, `url`, `query`, and `body` when the body is JSON or a form of at most 64 KiB. The SDK never sends the headers, and replaces the value of each sensitive key, such as `password`, `token` or `api_key`, by `REDACTED`.

A refused call never leaves the process. A refused `fetch` rejects with a `TypeError` whose `cause` is the `DeniedError`, as `fetch` reports every network error. A refused `http.request` emits the `DeniedError` as its `error` event. The SDK asks nothing for its own calls, for the calls made inside an action already decided, and for the hosts that match `ignore`. A process has one HTTP capture. `http()` returns a function that removes it.

## Journal

Each tool call goes to the journal of Paidwen as an OpenTelemetry span, with its decision, its start and its result. The span is a child of the active OpenTelemetry span when the process registers a context manager, as the OpenTelemetry Node SDK does. To journal the model calls that your OpenTelemetry instrumentations describe, add the span processor of Paidwen to your tracer provider:

```ts
const provider = new NodeTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
```

A model call leaves as soon as it ends, and the next question of the agent waits for it, one second at most, so that the budget sees its cost. `journal: false` turns off every journal export. `await paidwen.shutdown()` sends what remains and removes the HTTP capture.

## When Paidwen does not answer

When Paidwen does not answer within 3 seconds, or answers with a server error, the SDK applies `onUnavailable`: `"block"` by default, or `"allow"`.

The SDK is open source under the Apache 2.0 license.
