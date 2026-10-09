import { AsyncLocalStorage } from "node:async_hooks";
import {
  type Context,
  context,
  createContextKey,
  defaultTextMapSetter,
  propagation,
  ROOT_CONTEXT,
  type Span,
  type TextMapGetter,
  trace,
} from "@opentelemetry/api";
import {
  CompositePropagator,
  suppressTracing,
  TRACE_PARENT_HEADER,
  TRACE_STATE_HEADER,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from "@opentelemetry/core";

export const AGENT_BAGGAGE = "paidwen.agent.id";
const CALLER_MAX_LENGTH = 64;
const PROBE = createContextKey("paidwen.probe");
const W3C = new CompositePropagator({
  propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()],
});

export type Carrier = Record<string, string>;

interface PendingAction {
  id: string;
  used: boolean;
}

export interface Scope {
  pending?: PendingAction;
  sessionId?: string;
  inAction?: boolean;
  silenced?: boolean;
  otel?: Context;
  carrier?: Carrier;
}

export interface ContextOptions {
  actionId?: string;
  sessionId?: string;
  headers?: Headers | Record<string, unknown>;
}

type Received = NonNullable<ContextOptions["headers"]>;

const received: TextMapGetter<Received> = {
  keys: (carrier) => (carrier instanceof Headers ? [...carrier.keys()] : Object.keys(carrier)),
  get: (carrier, key) => {
    if (carrier instanceof Headers) return carrier.get(key) ?? undefined;
    const name = Object.keys(carrier).find((candidate) => candidate.toLowerCase() === key);
    const value = name === undefined ? undefined : carrier[name];
    if (typeof value === "string") return value;
    return Array.isArray(value) ? value.filter((item) => typeof item === "string") : undefined;
  },
};

const storage = new AsyncLocalStorage<Scope>();

export function scope(): Scope {
  return storage.getStore() ?? {};
}

export function within<T>(changes: Scope, fn: () => T): T {
  return storage.run({ ...scope(), ...changes }, fn);
}

function managed(): boolean {
  const probe = ROOT_CONTEXT.setValue(PROBE, true);
  return context.with(probe, () => context.active() === probe);
}

export function current(): Context {
  const own = scope().otel;
  return own === undefined || managed() ? context.active() : own;
}

function entered<T>(changes: Scope, otel: Context, fn: () => T): T {
  return within({ ...changes, otel }, () => context.with(otel, fn));
}

export function withContext<T>(options: ContextOptions, fn: () => T): T {
  const changes: Scope = {};
  if (options.actionId !== undefined) changes.pending = { id: options.actionId, used: false };
  if (options.sessionId !== undefined) changes.sessionId = options.sessionId;
  if (options.headers === undefined) return within(changes, fn);
  return entered(changes, W3C.extract(current(), options.headers, received), fn);
}

export function takeActionId(): string | undefined {
  const pending = scope().pending;
  if (!pending || pending.used) return undefined;
  pending.used = true;
  return pending.id;
}

export function silently<T>(fn: () => T): T {
  return within({ silenced: true }, fn);
}

export function insideAction<T>(tool: Context, carrier: Carrier, fn: () => T): T {
  return entered({ inAction: true, carrier }, tool, fn);
}

export function quiet<T>(fn: () => T): T {
  return silently(() => context.with(suppressTracing(context.active()), fn));
}

export function withAgent(base: Context, agentId: string | undefined): Context {
  if (agentId === undefined) return base;
  const baggage = propagation.getBaggage(base) ?? propagation.createBaggage();
  return propagation.setBaggage(base, baggage.setEntry(AGENT_BAGGAGE, { value: agentId }));
}

export function callerOf(agentId: string | undefined): string | undefined {
  const caller = propagation.getBaggage(current())?.getEntry(AGENT_BAGGAGE)?.value;
  return caller && caller !== agentId && caller.length <= CALLER_MAX_LENGTH ? caller : undefined;
}

export function propagated(tool: Context, span: Span): Carrier {
  const carrier: Carrier = {};
  W3C.inject(trace.setSpan(tool, span), carrier, defaultTextMapSetter);
  return carrier;
}

export function missing(carrier: Carrier, has: (name: string) => boolean): [string, string][] {
  const traced = has(TRACE_PARENT_HEADER);
  return Object.entries(carrier).filter(
    ([name]) => !has(name) && !(traced && name === TRACE_STATE_HEADER),
  );
}
