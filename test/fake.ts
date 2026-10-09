import { once } from "node:events";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Decision, DecisionRequest, Problem } from "../src/index.ts";

export const AGENT_ID = "4b0f3a52-8c1d-4e7a-9f26-1d5c7b9e3a40";
export const CALLER_ID = "9e2d4c61-7a3b-4f58-8e10-6c2a9b4d7f13";
export const CLIENT_TRACEPARENT = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";

export const DISABLED: Problem = {
  type: "https://paidwen.com/problems/agent-disabled",
  title: "The agent is disabled.",
  status: 403,
  detail: "The agent is disabled until someone enables it.",
};

export interface Recorded {
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
  at: number;
}

export interface Poll {
  status: number;
  body?: unknown;
}

export interface Span {
  name: string;
  traceId: string;
  spanId: string;
  attributes: Record<string, unknown>;
  events: string[];
  status: number;
}

export class FakePaidwen {
  readonly decisions: Recorded[] = [];
  readonly polls: Recorded[] = [];
  readonly traces: Recorded[] = [];
  readonly exchanges: URLSearchParams[] = [];
  answer: (request: DecisionRequest) => Decision = (request) => decision(request, "allow");
  script: Poll[] = [];
  #server: Server | undefined;
  url = "";

  async start(): Promise<this> {
    this.#server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (request.url === "/v1/oauth/token") {
          this.exchanges.push(new URLSearchParams(text));
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              access_token: `agent-token-${this.exchanges.length}`,
              issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
              token_type: "Bearer",
              expires_in: 900,
            }),
          );
          return;
        }
        const body = text ? JSON.parse(text) : undefined;
        const recorded = {
          path: request.url ?? "",
          headers: request.headers,
          body,
          at: Date.now(),
        };
        response.setHeader("content-type", "application/json");
        if (request.url === "/v1/decisions") {
          this.decisions.push(recorded);
          response.end(JSON.stringify(this.answer(body as DecisionRequest)));
          return;
        }
        if (request.url?.startsWith("/v1/approvals/")) {
          this.polls.push(recorded);
          const next = this.script.shift() ?? { status: 503 };
          response.statusCode = next.status;
          response.end(JSON.stringify(next.body ?? { type: "x", title: "x", status: next.status }));
          return;
        }
        if (request.url === "/v1/traces") {
          this.traces.push(recorded);
          response.end("{}");
          return;
        }
        response.statusCode = 404;
        response.end("{}");
      });
    });
    this.#server.listen(0, "127.0.0.1");
    await once(this.#server, "listening");
    this.url = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    return this;
  }

  spans(): Span[] {
    const spans: Span[] = [];
    for (const recorded of this.traces) {
      const body = recorded.body as {
        resourceSpans: {
          scopeSpans: {
            spans: {
              name: string;
              traceId: string;
              spanId: string;
              attributes?: { key: string; value: Record<string, unknown> }[];
              events?: { name: string }[];
              status?: { code?: number };
            }[];
          }[];
        }[];
      };
      for (const resource of body.resourceSpans) {
        for (const scope of resource.scopeSpans) {
          for (const span of scope.spans) {
            const attributes: Record<string, unknown> = {};
            for (const attribute of span.attributes ?? []) {
              attributes[attribute.key] = Object.values(attribute.value)[0];
            }
            spans.push({
              name: span.name,
              traceId: span.traceId,
              spanId: span.spanId,
              attributes,
              events: (span.events ?? []).map((event) => event.name),
              status: span.status?.code ?? 0,
            });
          }
        }
      }
    }
    return spans;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    this.#server?.close();
  }
}

export function decision(
  request: DecisionRequest,
  verdict: Decision["verdict"],
  extra: Partial<Decision> = {},
): Decision {
  return {
    action_id: request.action_id,
    verdict,
    rule_id: null,
    observed: [],
    decided_at: new Date().toISOString(),
    ...extra,
  };
}

export function waiting(request: DecisionRequest, onExpiry: "deny" | "allow" = "deny"): Decision {
  return decision(request, "require_approval", {
    rule_id: "refund-above-500",
    approval: {
      id: "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      expires_in: 300,
      interval: 1,
      on_expiry: onExpiry,
    },
  });
}

export function status(
  state: "pending" | "approved" | "denied" | "expired",
  onExpiry: "deny" | "allow" = "deny",
): Poll {
  return {
    status: 200,
    body: {
      id: "0d9e8f7a-6b5c-4d3e-8f2a-1b0c9d8e7f6a",
      action_id: "6f1c2a7e-3b5d-4c8e-9a10-2f4b6d8e0a12",
      status: state,
      expires_at: new Date(Date.now() + 300_000).toISOString(),
      interval: 1,
      on_expiry: onExpiry,
    },
  };
}

export function bodyOf<T>(recorded: Recorded | undefined): T {
  if (!recorded) throw new Error("no request was recorded");
  return recorded.body as T;
}

export async function until(what: string, done: () => boolean, limitMs = 10_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < limitMs) {
    if (done()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${what} did not happen within ${limitMs} ms`);
}
