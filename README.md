# Paidwen SDK for TypeScript

Paidwen controls what AI agents do. Before each action, the agent asks Paidwen whether it may act, then applies the answer. The agent keeps its own tool keys and performs the action itself.

```ts
import { Paidwen } from "paidwen";

const paidwen = new Paidwen();

const refund = paidwen.tool("payments.refund", async (params: { order: string; amount: number }) => {
  await payments.refund(params.order, params.amount);
});
```

`new Paidwen()` reads the agent key from `PAIDWEN_API_KEY`. A call to `refund` asks Paidwen first. It runs when Paidwen allows it, throws `DeniedError` when Paidwen blocks it or puts the agent in quarantine, and throws `PendingError` when the action waits for a human answer. When the permissions of the agent refuse the action, the message of `DeniedError` says so.

## MCP tool calls

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

paidwen.mcp(Client);
```

`paidwen.mcp(Client)` asks Paidwen before each `tools/call` request of every client of the official MCP SDK in the process, including the clients that an agent framework creates. The question carries the tool name, its arguments and the name that the MCP server announces. A refused call throws `DeniedError` or `PendingError` and never reaches the server.

`paidwen.mcp(client)` captures one client only, for a process that runs several agents with their own keys. `mcp()` returns a function that removes the capture.

## When Paidwen does not answer

When Paidwen does not answer within 3 seconds, or answers with a server error, the SDK applies `onUnavailable`: `"block"` by default, or `"allow"`.

The SDK is open source under the Apache 2.0 license.
