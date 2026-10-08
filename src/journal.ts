import {
  type Attributes,
  context,
  type Span,
  SpanKind,
  SpanStatusCode,
  type Tracer,
} from "@opentelemetry/api";
import { type ExportResult, ExportResultCode, suppressTracing } from "@opentelemetry/core";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { silently } from "./context.ts";

export const ACTION_STARTED = "paidwen.action.started";
const SCOPE = "paidwen";
const SETTLE_LIMIT_MS = 1000;
const MODEL_OPERATIONS = new Set(["chat", "text_completion", "generate_content", "embeddings"]);

class SilentExporter implements SpanExporter {
  readonly #inner: SpanExporter;

  constructor(inner: SpanExporter) {
    this.#inner = inner;
  }

  export(spans: ReadableSpan[], done: (result: ExportResult) => void): void {
    silently(() =>
      context.with(suppressTracing(context.active()), () => this.#inner.export(spans, done)),
    );
  }

  shutdown(): Promise<void> {
    return this.#inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#inner.forceFlush?.() ?? Promise.resolve();
  }
}

export function isModelCall(span: ReadableSpan): boolean {
  const operation = span.attributes["gen_ai.operation.name"];
  return typeof operation === "string" && MODEL_OPERATIONS.has(operation);
}

export interface JournalOptions {
  endpoint: string;
  authorization: () => Promise<string>;
  enabled: boolean;
  version: string;
}

export class Journal {
  readonly #provider: BasicTracerProvider;
  readonly #tracer: Tracer;
  readonly #exporter: SpanExporter | undefined;
  readonly #pending = new Set<Promise<void>>();

  constructor(options: JournalOptions) {
    const spanProcessors: SpanProcessor[] = [];
    if (options.enabled) {
      this.#exporter = new SilentExporter(
        new OTLPTraceExporter({
          url: options.endpoint,
          headers: async (): Promise<Record<string, string>> => {
            try {
              return { authorization: await options.authorization() };
            } catch {
              return {};
            }
          },
          timeoutMillis: 10_000,
        }),
      );
      spanProcessors.push(new BatchSpanProcessor(this.#exporter, { scheduledDelayMillis: 1000 }));
    }
    this.#provider = new BasicTracerProvider({
      resource: resourceFromAttributes({
        "service.name": "paidwen-sdk",
        "telemetry.sdk.language": "nodejs",
      }),
      spanProcessors,
    });
    this.#tracer = this.#provider.getTracer(SCOPE, options.version);
  }

  startTool(name: string, attributes: Attributes): Span {
    return this.#tracer.startSpan(
      `execute_tool ${name}`,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": name,
          ...attributes,
        },
      },
      context.active(),
    );
  }

  report(span: ReadableSpan): void {
    const exporter = this.#exporter;
    if (!exporter || !isModelCall(span)) return;
    const sent = new Promise<void>((resolve) => {
      exporter.export([span], (result) => {
        if (result.code !== ExportResultCode.SUCCESS) {
          console.warn(`Paidwen could not send a model call to the journal: ${result.error}`);
        }
        resolve();
      });
    });
    this.#pending.add(sent);
    void sent.finally(() => this.#pending.delete(sent));
  }

  async settle(): Promise<void> {
    if (this.#pending.size === 0) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, SETTLE_LIMIT_MS);
      timer.unref();
    });
    await Promise.race([Promise.allSettled([...this.#pending]), limit]);
    clearTimeout(timer);
  }

  processor(): SpanProcessor {
    return {
      onStart: () => undefined,
      onEnd: (span) => this.report(span),
      forceFlush: () => this.settle(),
      shutdown: () => this.settle(),
    };
  }

  async flush(): Promise<void> {
    await this.settle();
    await this.#provider.forceFlush();
  }

  async shutdown(): Promise<void> {
    await this.settle();
    await this.#provider.shutdown();
  }
}

export function started(span: Span): void {
  span.addEvent(ACTION_STARTED);
}

export function finish(span: Span, error?: unknown): void {
  if (error === undefined) {
    span.setStatus({ code: SpanStatusCode.OK });
  } else {
    const type = error instanceof Error ? error.name : typeof error;
    span.setAttribute("error.type", type);
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  span.end();
}

export function traceparent(span: Span): string {
  const { traceId, spanId } = span.spanContext();
  return `00-${traceId}-${spanId}-01`;
}
