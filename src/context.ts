import { AsyncLocalStorage } from "node:async_hooks";

interface PendingAction {
  id: string;
  used: boolean;
}

export interface Scope {
  pending?: PendingAction;
  sessionId?: string;
  inAction?: boolean;
  silenced?: boolean;
}

export interface ContextOptions {
  actionId?: string;
  sessionId?: string;
}

const storage = new AsyncLocalStorage<Scope>();

export function scope(): Scope {
  return storage.getStore() ?? {};
}

export function within<T>(changes: Scope, fn: () => T): T {
  return storage.run({ ...scope(), ...changes }, fn);
}

export function withContext<T>(options: ContextOptions, fn: () => T): T {
  const changes: Scope = {};
  if (options.actionId !== undefined) changes.pending = { id: options.actionId, used: false };
  if (options.sessionId !== undefined) changes.sessionId = options.sessionId;
  return within(changes, fn);
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

export function insideAction<T>(fn: () => T): T {
  return within({ inAction: true }, fn);
}
