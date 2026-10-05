# Paidwen SDK for TypeScript

Paidwen controls what AI agents do. Before each action, the agent asks Paidwen whether it may act, then applies the answer. The agent keeps its own tool keys and performs the action itself.

```ts
import { Paidwen } from "paidwen";

const paidwen = new Paidwen();

const refund = paidwen.tool("payments.refund", async (params: { order: string; amount: number }) => {
  await payments.refund(params.order, params.amount);
});
```

`new Paidwen()` reads the agent key from `PAIDWEN_API_KEY`. A call to `refund` asks Paidwen first. It runs when Paidwen allows it, throws `DeniedError` when Paidwen blocks it or puts the agent in quarantine, and throws `PendingError` when the action waits for a human answer.

When Paidwen does not answer within 3 seconds, or answers with a server error, the SDK applies `onUnavailable`: `"block"` by default, or `"allow"`.

The SDK is open source under the Apache 2.0 license.
