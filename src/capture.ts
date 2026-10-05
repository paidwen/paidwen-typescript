import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import type { Span } from "@opentelemetry/api";
import { bodyOf, describe, type HttpCall, MAX_BODY_BYTES } from "./http.ts";

export interface CaptureHooks {
  skips(host?: string): boolean;
  begin(call: HttpCall): Promise<Span>;
  inside<T>(fn: () => T): T;
  answered(span: Span, status: number): void;
  failed(span: Span, error: unknown): void;
}

type Fetch = typeof globalThis.fetch;
type Module = typeof http | typeof https;
type Callback = (response: http.IncomingMessage) => void;

async function readLimited(request: Request): Promise<string | undefined> {
  const reader = request.body?.getReader();
  if (!reader) return undefined;
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function addressOf(input: Parameters<Fetch>[0]): URL | undefined {
  try {
    return new URL(
      input instanceof Request ? input.url : input instanceof URL ? input.href : String(input),
    );
  } catch {
    return undefined;
  }
}

async function readFetch(
  input: Parameters<Fetch>[0],
  init: RequestInit | undefined,
  address: URL,
): Promise<{ method: string; body: unknown }> {
  const base = input instanceof Request ? input : undefined;
  const method = (init?.method ?? base?.method ?? "GET").toUpperCase();
  let body: unknown;
  try {
    if (init?.body !== undefined && init.body !== null) {
      if (!(init.body instanceof ReadableStream) && method !== "GET" && method !== "HEAD") {
        const probe = new Request(address, {
          method,
          headers: init.headers ?? base?.headers,
          body: init.body,
        });
        body = bodyOf(await readLimited(probe), probe.headers.get("content-type"));
      }
    } else if (base?.body) {
      const probe = base.clone();
      body = bodyOf(await readLimited(probe), probe.headers.get("content-type"));
    }
  } catch {
    body = undefined;
  }
  return { method, body };
}

function captureFetch(hooks: CaptureHooks): () => void {
  const original = globalThis.fetch;
  const captured: Fetch = async (input, init) => {
    const address = addressOf(input);
    if (!address || hooks.skips(address.host)) return original(input, init);
    const read = await readFetch(input, init, address);
    const span = await hooks.begin(describe(read.method, address, read.body));
    try {
      const response = await hooks.inside(() => original(input, init));
      hooks.answered(span, response.status);
      return response;
    } catch (error) {
      hooks.failed(span, error);
      throw error;
    }
  };
  globalThis.fetch = captured;
  return () => {
    if (globalThis.fetch === captured) globalThis.fetch = original;
  };
}

interface Parsed {
  url: string | URL | undefined;
  options: http.RequestOptions;
  callback: Callback | undefined;
}

function parse(args: unknown[]): Parsed {
  let index = 0;
  let url: string | URL | undefined;
  if (typeof args[0] === "string" || args[0] instanceof URL) {
    url = args[0];
    index = 1;
  }
  let options: http.RequestOptions = {};
  if (typeof args[index] === "object" && args[index] !== null) {
    options = args[index] as http.RequestOptions;
    index += 1;
  }
  const callback = typeof args[index] === "function" ? (args[index] as Callback) : undefined;
  return { url, options, callback };
}

function realAgent(module: Module, options: http.RequestOptions): http.Agent {
  const defaultAgent =
    (options as { _defaultAgent?: http.Agent })._defaultAgent ?? module.globalAgent;
  if (options.agent instanceof http.Agent) return options.agent;
  if (options.agent === false) {
    return new (defaultAgent.constructor as typeof http.Agent)();
  }
  if (typeof options.createConnection === "function") {
    const agent = new (defaultAgent.constructor as typeof http.Agent)();
    agent.createConnection = options.createConnection as typeof agent.createConnection;
    return agent;
  }
  return defaultAgent;
}

interface AgentContract {
  addRequest(request: http.ClientRequest, options: unknown): void;
}

interface RequestContract {
  onSocket(socket: null, error: unknown): void;
}

function heldAgent(real: http.Agent, released: Promise<void>): http.Agent {
  const held = Object.create(real) as http.Agent & AgentContract;
  held.addRequest = (request, options) => {
    released.then(
      () => (real as unknown as AgentContract).addRequest(request, options),
      (error: unknown) => (request as unknown as RequestContract).onSocket(null, error),
    );
  };
  return held;
}

function wrapRequest(module: Module, original: Module["request"], hooks: CaptureHooks) {
  return function request(this: unknown, ...args: unknown[]): http.ClientRequest {
    if (hooks.skips()) {
      return (original as (...a: unknown[]) => http.ClientRequest).apply(this, args);
    }
    const { url, options, callback } = parse(args);
    let release!: () => void;
    let refuse!: (error: unknown) => void;
    const released = new Promise<void>((resolve, reject) => {
      release = resolve;
      refuse = reject;
    });
    released.catch(() => undefined);
    const held = { ...options, agent: heldAgent(realAgent(module, options), released) };
    const call = url === undefined ? [held, callback] : [url, held, callback];
    const outgoing = (original as (...a: unknown[]) => http.ClientRequest).apply(
      this,
      call.filter((value) => value !== undefined),
    );
    const host = String(outgoing.getHeader("host") ?? outgoing.host);
    if (hooks.skips(host)) {
      release();
      return outgoing;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let overflow = false;
    let decided = false;
    const keep = (chunk: unknown, encoding: unknown) => {
      if (overflow || chunk === undefined || chunk === null || typeof chunk === "function") return;
      const buffer =
        typeof chunk === "string"
          ? Buffer.from(chunk, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8")
          : Buffer.from(chunk as Uint8Array);
      size += buffer.byteLength;
      if (size > MAX_BODY_BYTES) {
        overflow = true;
        chunks.length = 0;
        return;
      }
      chunks.push(buffer);
    };
    const decide = () => {
      if (decided) return;
      decided = true;
      const address = new URL(`${outgoing.protocol}//${host}${outgoing.path}`);
      const text = overflow ? undefined : Buffer.concat(chunks).toString("utf8");
      const contentType = outgoing.getHeader("content-type");
      const body = bodyOf(text, contentType === undefined ? null : String(contentType));
      hooks.begin(describe(outgoing.method, address, body)).then(
        (span) => {
          outgoing.once("response", (response) => hooks.answered(span, response.statusCode ?? 0));
          outgoing.once("error", (error) => hooks.failed(span, error));
          release();
        },
        (error: unknown) => refuse(error),
      );
    };
    const write = outgoing.write;
    outgoing.write = function (this: http.ClientRequest, chunk: unknown, ...rest: unknown[]) {
      keep(chunk, rest[0]);
      const result = (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      if (overflow) decide();
      return result;
    } as typeof outgoing.write;
    const end = outgoing.end;
    outgoing.end = function (this: http.ClientRequest, ...rest: unknown[]) {
      keep(rest[0], rest[1]);
      const result = (end as (...a: unknown[]) => http.ClientRequest).apply(this, rest);
      decide();
      return result;
    } as typeof outgoing.end;
    const flushHeaders = outgoing.flushHeaders;
    outgoing.flushHeaders = function (this: http.ClientRequest) {
      decide();
      return flushHeaders.call(this);
    };
    if (String(outgoing.getHeader("expect") ?? "").toLowerCase() === "100-continue") decide();
    return outgoing;
  };
}

function wrapGet(request: (...args: unknown[]) => http.ClientRequest) {
  return function get(this: unknown, ...args: unknown[]): http.ClientRequest {
    const outgoing = request.apply(this, args);
    outgoing.end();
    return outgoing;
  };
}

function captureModule(module: Module, hooks: CaptureHooks): () => void {
  const original = { request: module.request, get: module.get };
  const request = wrapRequest(module, original.request, hooks);
  module.request = request as typeof module.request;
  module.get = wrapGet(request) as typeof module.get;
  return () => {
    if (module.request === request) {
      module.request = original.request;
      module.get = original.get;
    }
  };
}

export function install(hooks: CaptureHooks): () => void {
  const restores = [captureFetch(hooks), captureModule(http, hooks), captureModule(https, hooks)];
  syncBuiltinESMExports();
  return () => {
    for (const restore of restores.reverse()) restore();
    syncBuiltinESMExports();
  };
}
