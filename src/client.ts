import { DeniedError, PaidwenError, PendingError, RequestError } from "./errors.ts";
import type { Decision, DecisionRequest, Problem } from "./types.ts";

export type Fallback = "allow" | "block";

export type DecisionInput = Omit<DecisionRequest, "action_id"> & { action_id?: string };

export interface PaidwenOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  onUnavailable?: Fallback;
  fetch?: typeof fetch;
}

export interface McpClient {
  request(request: { method: string; params?: unknown }, ...rest: never[]): unknown;
  getServerVersion?(): { name?: unknown } | undefined;
}

export type McpTarget = McpClient | (abstract new (...args: never[]) => McpClient);

const DEFAULT_BASE_URL = "https://api.paidwen.com";
const DEFAULT_TIMEOUT_MS = 3000;
const CAPTURED = Symbol.for("paidwen.mcp");

export class Paidwen {
  readonly #apiKey: string;
  readonly #endpoint: string;
  readonly #timeoutMs: number;
  readonly #onUnavailable: Fallback;
  readonly #fetch: typeof fetch;

  constructor(options: PaidwenOptions = {}) {
    const apiKey = options.apiKey ?? environment("PAIDWEN_API_KEY");
    if (!apiKey) {
      throw new PaidwenError("Paidwen needs an agent key: pass apiKey or set PAIDWEN_API_KEY.");
    }
    const onUnavailable = options.onUnavailable ?? "block";
    if (onUnavailable !== "allow" && onUnavailable !== "block") {
      throw new PaidwenError('onUnavailable must be "allow" or "block".');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(timeoutMs > 0)) {
      throw new PaidwenError("timeoutMs must be a positive number of milliseconds.");
    }
    const baseUrl = options.baseUrl ?? environment("PAIDWEN_BASE_URL") ?? DEFAULT_BASE_URL;
    this.#apiKey = apiKey;
    this.#endpoint = `${baseUrl.replace(/\/+$/, "")}/v1/decisions`;
    this.#timeoutMs = timeoutMs;
    this.#onUnavailable = onUnavailable;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async decide(input: DecisionInput): Promise<Decision> {
    const request: DecisionRequest = {
      ...input,
      action_id: input.action_id ?? crypto.randomUUID(),
    };
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(this.#timeoutMs),
      });
    } catch (cause) {
      return this.#fallback(request, cause);
    }
    if (response.status >= 500) {
      response.body?.cancel().catch(() => undefined);
      return this.#fallback(request, new PaidwenError(`Paidwen answered HTTP ${response.status}.`));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      if (response.ok) {
        return this.#fallback(request, cause);
      }
    }
    if (!response.ok) {
      throw new RequestError(response.status, isObject(body) ? (body as Problem) : undefined);
    }
    return body as Decision;
  }

  tool<P extends Record<string, unknown>, R>(
    name: string,
    fn: (params: P) => R | Promise<R>,
  ): (params: P) => Promise<R> {
    return async (params: P): Promise<R> => {
      enforce(await this.decide({ tool: { name, kind: "function" }, params }));
      return await fn(params);
    };
  }

  mcp(target: McpTarget): () => void {
    const holder = typeof target === "function" ? target.prototype : target;
    if (!isObject(holder) || typeof holder.request !== "function") {
      throw new PaidwenError("mcp() takes the Client class of the MCP SDK, or one of its clients.");
    }
    if (CAPTURED in holder) {
      throw new PaidwenError("This MCP client is already captured by Paidwen.");
    }
    const own = Object.getOwnPropertyDescriptor(holder, "request");
    const send = holder.request as (this: McpClient, ...args: unknown[]) => unknown;
    const ask = (input: DecisionInput) => this.decide(input);
    async function request(this: McpClient, message: unknown, ...rest: unknown[]) {
      if (isObject(message) && message.method === "tools/call") {
        enforce(await ask(toolCall(this, message.params)));
      }
      return await send.call(this, message, ...rest);
    }
    Object.defineProperty(holder, "request", {
      value: request,
      writable: true,
      configurable: true,
    });
    Object.defineProperty(holder, CAPTURED, { value: true, configurable: true });
    return () => {
      if (own) {
        Object.defineProperty(holder, "request", own);
      } else {
        delete holder.request;
      }
      delete holder[CAPTURED];
    };
  }

  #fallback(request: DecisionRequest, cause: unknown): Decision {
    const reason = cause instanceof Error ? cause.message : String(cause);
    console.warn(
      `Paidwen did not answer, so the SDK applies onUnavailable "${this.#onUnavailable}": ${reason}`,
    );
    return {
      action_id: request.action_id,
      verdict: this.#onUnavailable,
      rule_id: null,
      observed: [],
      decided_at: new Date().toISOString(),
    };
  }
}

function toolCall(client: McpClient, params: unknown): DecisionInput {
  const call = isObject(params) ? params : {};
  const name = typeof call.name === "string" ? call.name : "";
  const server = client.getServerVersion?.()?.name;
  return {
    tool: {
      name,
      kind: "mcp",
      ...(typeof server === "string" && server.length >= 1 && server.length <= 256
        ? { server }
        : {}),
    },
    params: isObject(call.arguments) ? call.arguments : {},
  };
}

function enforce(decision: Decision): void {
  switch (decision.verdict) {
    case "allow":
      return;
    case "block":
    case "quarantine":
      throw new DeniedError(decision);
    case "require_approval":
    case "escalate":
      throw new PendingError(decision);
  }
}

function environment(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name] || undefined;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
