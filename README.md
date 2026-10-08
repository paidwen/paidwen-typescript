# Paidwen SDK for TypeScript

Paidwen controls what AI agents do. Before each action, the agent asks Paidwen whether it may act, then applies the answer. The agent keeps its own tool keys and performs the action itself.

## The agent installs Paidwen in two lines

```sh
npm install paidwen
```

```ts
import { Paidwen } from "paidwen";

const paidwen = new Paidwen();
paidwen.http();
```

`new Paidwen()` reads the agent key from the `PAIDWEN_API_KEY` environment variable. The `apiKey` option passes the key in the code instead. The SDK runs on Node 22 or later.

`paidwen.http()` asks Paidwen before each outgoing HTTP call of the process that goes through `fetch`, `http.request`, `http.get`, `https.request` or `https.get`, as Axios, got and the SDKs of the providers do. Call it when the process starts, as you would register an OpenTelemetry instrumentation. A library that keeps its own copy of `http.request` from before the capture is not captured, and neither is undici called directly.

The tool name of an HTTP call is its method and its path, for example `POST /v1/refunds`, and its server is the host. The parameters carry `method`, `url`, `query`, and `body` when the body is JSON or a form of at most 64 KiB. The SDK never sends the headers, and replaces the value of each sensitive key, such as `password`, `token` or `api_key`, by `REDACTED`.

A refused `fetch` rejects with `DeniedError`, and a refused `http.request` emits `DeniedError` as its `error` event. The call never leaves the process. The SDK asks nothing for its own calls, for the calls made inside an action already decided, and for the hosts that match the `ignore` option, such as `paidwen.http({ ignore: ["*.internal.example.com"] })`. A process has one HTTP capture, and `http()` returns a function that removes it.

## An agent on Kubernetes, AWS or GitHub Actions needs no key

```ts
const paidwen = new Paidwen({ identityTokenFile: "/var/run/secrets/paidwen/token" });
```

When the platform of the agent signs a token for it, the SDK exchanges this token for an agent token valid for 15 minutes, under a trust rule of your organization, and renews it before it expires. `identityTokenFile` reads the token from a file at each exchange, such as the projected token of a Kubernetes service account. `identityToken` takes a function that returns the token, such as a call to `GetWebIdentityToken` on AWS. Without option, the SDK reads `PAIDWEN_IDENTITY_TOKEN_FILE`. The guide is at https://paidwen.com/docs/workload-identity.

## A wrapped function asks Paidwen before it runs

```ts
const refund = paidwen.tool("payments.refund", async (params: { order: string; amount: number }) => {
  await payments.refund(params.order, params.amount);
});

const search = paidwen.tool("search.web", searchWeb, { cost: { estimated_usd: 0.001 } });

await refund({ order: "ord_42", amount: 2500 });
```

A call to `refund` asks Paidwen first, with the tool name and the parameters. It runs when Paidwen allows it, waits when the action needs a human approval, and throws `DeniedError` when Paidwen refuses it.

The `cost` option gives the cost that the agent estimates for the tool, as a fixed value or as a function of the parameters. The budget of the agent counts it, and the rules read it in `cost.estimated_usd`.

## The MCP capture asks Paidwen before each tool call

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

paidwen.mcp(Client);
```

`paidwen.mcp(Client)` asks Paidwen before each `tools/call` request of every client of the official MCP SDK in the process, including the clients that an agent framework creates. The question carries the tool name, its arguments and the name that the MCP server announces. A refused call throws `DeniedError` and never reaches the server.

`paidwen.mcp(client)` captures one client only, for a process that runs several agents with their own keys. `mcp()` returns a function that removes the capture. The MCP package ships an ESM copy and a CommonJS copy, and the SDK captures the class it receives: a framework that loads the other copy needs that class too.

## An action can wait for a human approval

```ts
const paidwen = new Paidwen({
  onWait: (wait) => notifyUser(wait.approvalId, wait.expiresAt),
});
```

When a rule asks for a human approval, the call waits for the answer of the approver. The SDK calls `onWait` once when the wait starts, so the agent can tell its user. The call runs once the approver approves it, and throws `DeniedError` when the approver denies it. When the wait expires, the SDK applies the `on_expiry` choice of the rule: `deny` throws `DeniedError`, and `allow` runs the call.

With `onPending: "throw"`, the call throws `PendingError` as soon as the wait is open, and the action does not run. The agent calls again later with the same action identifier, found in `error.decision.action_id`. The action runs if the approver has approved it:

```ts
await paidwen.context({ actionId }, () => refund({ order: "ord_42", amount: 2500 }));
```

`paidwen.context({ actionId, sessionId }, fn)` gives its action identifier to the first decision of `fn`, and its session to every decision and journal line of `fn`.

## The SDK applies your choice when Paidwen does not answer

The SDK waits 3 seconds at most for the answer of Paidwen, and the `timeoutMs` option changes this delay. Without an answer in time, on a network error or on a server error, the SDK applies `onUnavailable`: `"block"` by default, or `"allow"`. It writes a warning with the cause through `console.warn`. With `"block"`, the call throws `DeniedError`.

When the organization has used all the events its plan allows this month, Paidwen answers 503 with the problem type `quota-exceeded` until the first day of the next month in UTC. The SDK applies `onUnavailable` in the same way, and its warning names the cause with the detail of the problem.

## The journal receives each tool call and each model call

Each tool call goes to the journal of Paidwen as an OpenTelemetry span, with its decision, its start and its result. The span is a child of the active OpenTelemetry span when the process registers a context manager, as the OpenTelemetry Node SDK does.

To journal the model calls that your OpenTelemetry instrumentations describe, add the span processor of Paidwen to your tracer provider:

```ts
const provider = new NodeTracerProvider({ spanProcessors: [paidwen.spanProcessor()] });
```

A model call leaves as soon as it ends, and the next question of the agent waits for it, one second at most, so that the budget sees its cost. The `journal: false` option turns off every journal export. `await paidwen.flush()` sends the waiting spans, and `await paidwen.shutdown()` sends what remains and removes the HTTP capture.

## Three errors stop an action

- `DeniedError` says that the action does not run: a rule, the permissions or the budget of the agent refused it, the approver denied it, the wait expired with `on_expiry` at `deny`, the agent is in quarantine, or Paidwen did not answer and `onUnavailable` is `"block"`. Its message says why. `error.decision` carries the decision, `error.approval` the state of the wait, and `error.incident` the incident that put the agent in quarantine, with its `id` and its `kind`.
- `PendingError` says that the action waits for a human approval and that the agent chose `onPending: "throw"`. `error.decision` carries the decision and its `approval`.
- `RequestError` says that Paidwen refused the request itself, with an HTTP status from 400 to 499. A disabled agent receives 403, and the message then reads `Paidwen refused the agent: The agent is disabled.` with the detail of the problem. An unknown key receives 401. `error.status` carries the status, and `error.problem` the problem in the format of RFC 9457. The action never runs, even with `onUnavailable: "allow"`, and the SDK does not ask again.

The three errors extend `PaidwenError`, which the constructor also throws for a missing key or a wrong option.

The SDK is open source under the Apache 2.0 license. The documentation lives at https://paidwen.com/docs.
