import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { context, type Span } from "@opentelemetry/api";
import { isTracingSuppressed, suppressTracing } from "@opentelemetry/core";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { install } from "./capture.ts";
import {
  type ContextOptions,
  insideAction,
  scope,
  silently,
  takeActionId,
  withContext,
} from "./context.ts";
import { DeniedError, PaidwenError, PendingError, RequestError, reasonOf } from "./errors.ts";
import { matches } from "./http.ts";
import { finish, Journal, started, traceparent } from "./journal.ts";
import type {
  ActionContext,
  ApprovalStatus,
  Cost,
  Decision,
  DecisionRequest,
  OnExpiry,
  Problem,
} from "./types.ts";

export type Fallback = "allow" | "block";

export type OnPending = "wait" | "throw";

export type DecisionInput = Omit<DecisionRequest, "action_id"> & { action_id?: string };

export interface Wait {
  decision: Decision;
  approvalId: string;
  expiresAt: Date;
  interval: number;
  onExpiry: OnExpiry;
}

export interface PaidwenOptions {
  apiKey?: string;
  baseUrl?: string;
  timeoutMs?: number;
  onUnavailable?: Fallback;
  onPending?: OnPending;
  onWait?: (wait: Wait) => void | Promise<void>;
  journal?: boolean;
  fetch?: typeof fetch;
}

export interface HttpOptions {
  ignore?: string[];
}

export interface ToolOptions<P> {
  cost?: Cost | ((params: P) => Cost | undefined);
}

export interface McpClient {
  request(request: { method: string; params?: unknown }, ...rest: never[]): unknown;
  getServerVersion?(): { name?: unknown } | undefined;
}

export type McpTarget = McpClient | (abstract new (...args: never[]) => McpClient);

const VERSION = "0.8.1";
const DEFAULT_BASE_URL = "https://api.paidwen.com";
const QUOTA_EXCEEDED = "https://paidwen.com/problems/quota-exceeded";
const DEFAULT_TIMEOUT_MS = 3000;
const SLOW_DOWN_SECONDS = 5;
const WAIT_GRACE_SECONDS = 60;
const CAPTURED = Symbol.for("paidwen.mcp");
const HTTP_CAPTURED = Symbol.for("paidwen.http");
const processState = globalThis as unknown as Record<symbol, true | undefined>;

type Polled =
  | { kind: "status"; status: ApprovalStatus }
  | { kind: "slow_down" }
  | { kind: "unavailable" };

function decidedAt(decision: Decision): number {
  const at = Date.parse(decision.decided_at);
  return Number.isNaN(at) ? Date.now() : at;
}

function quiet<T>(fn: () => T): T {
  return silently(() => context.with(suppressTracing(context.active()), fn));
}

export class Paidwen {
  readonly #apiKey: string;
  readonly #base: string;
  readonly #timeoutMs: number;
  readonly #onUnavailable: Fallback;
  readonly #onPending: OnPending;
  readonly #onWait: ((wait: Wait) => void | Promise<void>) | undefined;
  readonly #fetch: typeof fetch;
  readonly #journal: Journal;
  #releaseHttp: (() => void) | undefined;

  constructor(options: PaidwenOptions = {}) {
    const apiKey = options.apiKey ?? environment("PAIDWEN_API_KEY");
    if (!apiKey) {
      throw new PaidwenError("Paidwen needs an agent key: pass apiKey or set PAIDWEN_API_KEY.");
    }
    const onUnavailable = options.onUnavailable ?? "block";
    if (onUnavailable !== "allow" && onUnavailable !== "block") {
      throw new PaidwenError('onUnavailable must be "allow" or "block".');
    }
    const onPending = options.onPending ?? "wait";
    if (onPending !== "wait" && onPending !== "throw") {
      throw new PaidwenError('onPending must be "wait" or "throw".');
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!(timeoutMs > 0)) {
      throw new PaidwenError("timeoutMs must be a positive number of milliseconds.");
    }
    const baseUrl = options.baseUrl ?? environment("PAIDWEN_BASE_URL") ?? DEFAULT_BASE_URL;
    this.#apiKey = apiKey;
    this.#base = baseUrl.replace(/\/+$/, "");
    this.#timeoutMs = timeoutMs;
    this.#onUnavailable = onUnavailable;
    this.#onPending = onPending;
    this.#onWait = options.onWait;
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#journal = new Journal({
      endpoint: `${this.#base}/v1/traces`,
      apiKey,
      enabled: options.journal ?? true,
      version: VERSION,
    });
  }

  decide(input: DecisionInput): Promise<Decision> {
    return this.#ask(input);
  }

  async #ask(input: DecisionInput, span?: Span): Promise<Decision> {
    await this.#journal.settle();
    const request: DecisionRequest = {
      ...input,
      action_id: input.action_id ?? takeActionId() ?? randomUUID(),
    };
    const known: ActionContext = {};
    const session = scope().sessionId;
    if (session !== undefined) known.session_id = session;
    if (span) known.trace_id = span.spanContext().traceId;
    if (Object.keys(known).length > 0 || input.context) {
      request.context = { ...known, ...input.context };
    }
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.#apiKey}`,
      "content-type": "application/json",
      accept: "application/json",
    };
    if (span) headers.traceparent = traceparent(span);
    let response: Response;
    try {
      response = await quiet(() =>
        this.#fetch(`${this.#base}/v1/decisions`, {
          method: "POST",
          headers,
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(this.#timeoutMs),
        }),
      );
    } catch (cause) {
      return this.#fallback(request, "Paidwen did not answer", messageOf(cause));
    }
    if (response.status >= 500) {
      const problem = await problemOf(response);
      return this.#fallback(request, unavailable(response.status, problem), reasonOf(problem));
    }
    if (!response.ok) {
      throw new RequestError(response.status, await problemOf(response));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch (cause) {
      return this.#fallback(request, "Paidwen did not answer", messageOf(cause));
    }
    return body as Decision;
  }

  waitForApproval(decision: Decision): Promise<ApprovalStatus> {
    return this.#wait(decision, async () => undefined);
  }

  async #wait(decision: Decision, pending: () => Promise<void>): Promise<ApprovalStatus> {
    const approval = decision.approval;
    if (!approval) {
      throw new PaidwenError("The decision carries no approval to wait for.");
    }
    const deadline = decidedAt(decision) + (approval.expires_in + WAIT_GRACE_SECONDS) * 1000;
    let interval = approval.interval;
    let last: ApprovalStatus | undefined;
    let first = true;
    for (;;) {
      if (!first) await delay(interval * 1000, undefined, { ref: true });
      const polled = await this.#poll(approval.id);
      if (polled.kind === "status") {
        last = polled.status;
        if (polled.status.status !== "pending") return polled.status;
        interval = Math.max(interval, polled.status.interval);
      } else if (polled.kind === "slow_down") {
        interval += SLOW_DOWN_SECONDS;
      }
      if (Date.now() >= deadline) {
        return {
          id: approval.id,
          action_id: decision.action_id,
          status: "expired",
          expires_at: new Date(deadline).toISOString(),
          interval,
          on_expiry: last?.on_expiry ?? approval.on_expiry ?? "deny",
        };
      }
      if (first) {
        first = false;
        await pending();
      }
    }
  }

  async #poll(id: string): Promise<Polled> {
    let response: Response;
    try {
      response = await quiet(() =>
        this.#fetch(`${this.#base}/v1/approvals/${id}`, {
          headers: { authorization: `Bearer ${this.#apiKey}`, accept: "application/json" },
          signal: AbortSignal.timeout(this.#timeoutMs),
        }),
      );
    } catch {
      return { kind: "unavailable" };
    }
    if (response.status === 429) {
      response.body?.cancel().catch(() => undefined);
      return { kind: "slow_down" };
    }
    if (response.status >= 500) {
      response.body?.cancel().catch(() => undefined);
      return { kind: "unavailable" };
    }
    if (!response.ok) {
      throw new RequestError(response.status, await problemOf(response));
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return { kind: "unavailable" };
    }
    return { kind: "status", status: body as ApprovalStatus };
  }

  async #authorize(input: DecisionInput, span: Span): Promise<void> {
    const decision = await this.#ask(input, span);
    span.setAttribute("paidwen.action.id", decision.action_id);
    if (decision.incident) {
      throw new DeniedError(decision);
    }
    switch (decision.verdict) {
      case "allow":
        return;
      case "block":
      case "quarantine":
        throw new DeniedError(decision);
    }
    const approval = decision.approval;
    if (!approval) {
      throw new PendingError(decision);
    }
    const status = await this.#wait(decision, async () => {
      if (this.#onPending === "throw") {
        throw new PendingError(decision);
      }
      await this.#onWait?.({
        decision,
        approvalId: approval.id,
        expiresAt: new Date(decidedAt(decision) + approval.expires_in * 1000),
        interval: approval.interval,
        onExpiry: approval.on_expiry ?? "deny",
      });
    });
    if (
      status.status === "approved" ||
      (status.status === "expired" && status.on_expiry === "allow")
    ) {
      return;
    }
    throw new DeniedError(decision, status);
  }

  async #run<R>(input: DecisionInput, action: () => R | Promise<R>): Promise<R> {
    const span = this.#journal.startTool(input.tool.name, toolAttributes(input));
    try {
      await this.#authorize(input, span);
      started(span);
      const result = await insideAction(() => action());
      finish(span);
      return result;
    } catch (error) {
      finish(span, error);
      throw error;
    }
  }

  tool<P extends object, R>(
    name: string,
    fn: (params: P) => R | Promise<R>,
    options: ToolOptions<P> = {},
  ): (params: P) => Promise<R> {
    return (params: P): Promise<R> => {
      if (!isObject(params)) {
        return Promise.reject(
          new PaidwenError(`The tool ${name} takes one object, whose keys become its parameters.`),
        );
      }
      const cost = typeof options.cost === "function" ? options.cost(params) : options.cost;
      const input: DecisionInput = { tool: { name, kind: "function" }, params };
      if (cost !== undefined) input.cost = cost;
      return this.#run(input, () => fn(params));
    };
  }

  context<T>(options: ContextOptions, fn: () => T): T {
    return withContext(options, fn);
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
    const run = <R>(input: DecisionInput, action: () => Promise<R>) => this.#run(input, action);
    async function request(this: McpClient, message: unknown, ...rest: unknown[]) {
      if (isObject(message) && message.method === "tools/call") {
        return await run(toolCall(this, message.params), async () =>
          send.call(this, message, ...rest),
        );
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

  http(options: HttpOptions = {}): () => void {
    if (processState[HTTP_CAPTURED]) {
      throw new PaidwenError("The HTTP calls of this process are already captured by Paidwen.");
    }
    const ignore = options.ignore ?? [];
    const ended = new WeakSet<Span>();
    const close = (span: Span, error?: unknown) => {
      if (ended.has(span)) return;
      ended.add(span);
      finish(span, error);
    };
    const restore = install({
      skips: (host) => {
        const current = scope();
        if (current.silenced || current.inAction || isTracingSuppressed(context.active())) {
          return true;
        }
        return host !== undefined && ignore.some((pattern) => matches(pattern, host));
      },
      begin: async (call) => {
        const span = this.#journal.startTool(call.tool.name, toolAttributes(call));
        try {
          await this.#authorize(call, span);
        } catch (error) {
          close(span, error);
          throw error;
        }
        started(span);
        return span;
      },
      inside: (fn) => insideAction(fn),
      answered: (span, status) => {
        span.setAttribute("http.response.status_code", status);
        close(span, status >= 400 ? new HttpStatusError(status) : undefined);
      },
      failed: (span, error) => close(span, error),
    });
    processState[HTTP_CAPTURED] = true;
    const release = () => {
      if (this.#releaseHttp !== release) return;
      restore();
      this.#releaseHttp = undefined;
      delete processState[HTTP_CAPTURED];
    };
    this.#releaseHttp = release;
    return release;
  }

  spanProcessor(): SpanProcessor {
    return this.#journal.processor();
  }

  flush(): Promise<void> {
    return this.#journal.flush();
  }

  async shutdown(): Promise<void> {
    this.#releaseHttp?.();
    await this.#journal.shutdown();
  }

  #fallback(request: DecisionRequest, cause: string, reason: string | undefined): Decision {
    const applied = `${cause}, so the SDK applies onUnavailable "${this.#onUnavailable}"`;
    console.warn(reason ? `${applied}: ${reason}` : `${applied}.`);
    return {
      action_id: request.action_id,
      verdict: this.#onUnavailable,
      rule_id: null,
      observed: [],
      decided_at: new Date().toISOString(),
    };
  }
}

class HttpStatusError extends Error {
  override name: string;

  constructor(status: number) {
    super(`The server answered HTTP ${status}.`);
    this.name = String(status);
  }
}

function toolAttributes(input: DecisionInput): Record<string, string> {
  const attributes: Record<string, string> = { "paidwen.tool.kind": input.tool.kind };
  if (input.tool.server !== undefined) attributes["paidwen.tool.server"] = input.tool.server;
  if (input.action_id !== undefined) attributes["paidwen.action.id"] = input.action_id;
  return attributes;
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

async function problemOf(response: Response): Promise<Problem | undefined> {
  try {
    const body: unknown = await response.json();
    return isObject(body) ? (body as Problem) : undefined;
  } catch {
    return undefined;
  }
}

function unavailable(status: number, problem: Problem | undefined): string {
  const answered = `Paidwen answered HTTP ${status}`;
  return problem?.type === QUOTA_EXCEEDED
    ? `${answered} because the organization reached the events its plan allows this month`
    : answered;
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function environment(name: string): string | undefined {
  return typeof process === "undefined" ? undefined : process.env[name] || undefined;
}

function isObject(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
