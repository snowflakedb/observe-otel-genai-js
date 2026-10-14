/**
 * `Client` — the public entry point of the library.
 *
 * Constructs once per service/process. Resolves config, looks up the OTel
 * tracer + meter, creates histograms, instantiates the span-link map. After
 * that, each `startX` call:
 *   1. resolves identity (per-call > context > config),
 *   2. opens a span via `tracer.startSpan(...)` with optional links,
 *   3. registers the span in the in-memory map (for downstream parent linkage),
 *   4. applies the initial attribute set,
 *   5. hands back a recorder.
 *
 * `invokeAgent` has a callback variant that uses `tracer.startActiveSpan` so
 * nested spans (other `startX` calls inside) parent under the agent
 * automatically via OTel context.
 *
 * Under the `allow_list` content mode every span is wrapped in an
 * `AllowListSpan` before anything is written to it (see `startSpan`).
 *
 * `flush()` / `shutdown()` best-effort call `forceFlush` on whatever
 * TracerProvider / MeterProvider is currently registered — duck-typed via
 * `hasattr` so we never import from `@opentelemetry/sdk-*`.
 */

import {
  type Link,
  type Meter,
  type Span,
  type SpanContext,
  SpanKind,
  type SpanOptions,
  type Tracer,
  context,
  metrics as metricsApi,
  trace,
} from '@opentelemetry/api';
import {
  type ClientConfig,
  type Logger,
  type ResolvedClientConfig,
  defaultConfig,
  resolveConfig,
} from './config.js';
import { AllowListSpan, allowListSpanOptions } from './content/allow-list.js';
import { type ContentCaptureMode, resolveContentCaptureMode } from './content/capture.js';
import {
  agentNameFromContext,
  agentVersionFromContext,
  contentCaptureModeFromContext,
  conversationIdFromContext,
  conversationTitleFromContext,
  userIdFromContext,
} from './context.js';
import { ClientShutdownError, FlushTimeoutError } from './errors.js';
import { GenAIMetrics } from './metrics/histograms.js';
import type { AgentCreationStart, AgentInvocationStart } from './models/agent.js';
import type { EmbeddingStart } from './models/embedding.js';
import type { GenerationStart } from './models/generation.js';
import type { RetrievalStart } from './models/retrieval.js';
import type { ToolExecutionStart } from './models/tool.js';
import { AgentCreationRecorder, AgentInvocationRecorder } from './recorders/agent.js';
import type { RecorderHostContext } from './recorders/base.js';
import { EmbeddingRecorder } from './recorders/embedding.js';
import { GenerationRecorder } from './recorders/generation.js';
import { RetrievalRecorder } from './recorders/retrieval.js';
import { ToolExecutionRecorder } from './recorders/tool.js';
import { INSTRUMENTATION_NAME, OP_CHAT, OP_EMBEDDINGS } from './semconv.js';
import {
  applyAgentAttributes,
  applyAgentCreationAttributes,
  applyEmbeddingStartAttributes,
  applyGenerationAttributes,
  applyRetrievalAttributes,
  applyToolAttributes,
} from './spans/attributes.js';
import { SpanLinkMap } from './spans/links.js';
import {
  agentCreateSpanName,
  agentSpanName,
  embeddingSpanName,
  generationSpanName,
  retrievalSpanName,
  toolSpanName,
} from './spans/names.js';
import { generateId } from './util/id.js';
import { VERSION } from './version.js';

/**
 * Client lifecycle:
 *   const client = new Client({ ... }) // sync constructor
 *   ...
 *   await client.shutdown();
 *
 * Or:
 *   await using client = new Client({ ... });
 */
export class Client implements RecorderHostContext {
  readonly config: ResolvedClientConfig;
  readonly metrics: GenAIMetrics;
  readonly spanLinks: SpanLinkMap;
  readonly now: () => number;
  readonly errorClassifier?: import('./errors/classify.js').ErrorClassifier;

  private readonly tracer: Tracer;
  private readonly meter: Meter;
  private readonly logger: Logger;
  private closed = false;

  constructor(input?: ClientConfig) {
    this.config = input ? resolveConfig(input) : defaultConfig();
    this.now = this.config.now;
    this.logger = this.config.logger;
    this.errorClassifier = this.config.errorClassifier;

    this.tracer = this.config.tracer ?? trace.getTracer(INSTRUMENTATION_NAME, VERSION);
    this.meter = this.config.meter ?? metricsApi.getMeter(INSTRUMENTATION_NAME, VERSION);

    this.metrics = new GenAIMetrics(this.meter, this.config.metricAttributes);
    this.spanLinks = new SpanLinkMap(this.config.spanLinkMap, this.now, this.logger);
  }

  // ---------------------------------------------------------------------------
  // Generation
  // ---------------------------------------------------------------------------

  startGeneration(start: GenerationStart): GenerationRecorder {
    return this.startGenerationInternal(start, 'SYNC');
  }

  startStreamingGeneration(start: GenerationStart): GenerationRecorder {
    return this.startGenerationInternal(start, 'STREAM');
  }

  private startGenerationInternal(
    input: GenerationStart,
    defaultMode: 'SYNC' | 'STREAM',
  ): GenerationRecorder {
    this.assertOpen();
    const seed = this.normalizeGenerationSeed(input, defaultMode);
    const startedAtMs = toMs(seed.startedAt) ?? this.now();
    seed.startedAt = startedAtMs;

    const { links } = this.spanLinks.resolveLinks(seed.parentGenerationIds);
    const span = this.startSpan(
      generationSpanName(seed.operationName ?? OP_CHAT, seed.model.name),
      {
        kind: SpanKind.CLIENT,
        startTime: new Date(startedAtMs),
        links,
      },
      seed.contentCapture,
    );

    if (seed.id) this.spanLinks.set(seed.id, span.spanContext());

    applyGenerationAttributes(span, {
      ...seed,
      model: { provider: seed.model.provider, name: seed.model.name },
    });

    return new GenerationRecorder(this, span, seed, startedAtMs, seed.contentCapture ?? 'default');
  }

  // ---------------------------------------------------------------------------
  // Embedding
  // ---------------------------------------------------------------------------

  startEmbedding(start: EmbeddingStart): EmbeddingRecorder {
    this.assertOpen();
    const seed = this.normalizeEmbeddingSeed(start);
    const startedAtMs = toMs(seed.startedAt) ?? this.now();
    seed.startedAt = startedAtMs;

    const span = this.startSpan(
      embeddingSpanName(seed.model.name),
      { kind: SpanKind.CLIENT, startTime: new Date(startedAtMs) },
      seed.contentCapture,
    );
    applyEmbeddingStartAttributes(span, seed);

    return new EmbeddingRecorder(this, span, seed, startedAtMs, seed.contentCapture ?? 'default');
  }

  // ---------------------------------------------------------------------------
  // Tool execution
  // ---------------------------------------------------------------------------

  startToolExecution(start: ToolExecutionStart): ToolExecutionRecorder {
    this.assertOpen();
    const seed = this.normalizeToolSeed(start);
    const startedAtMs = toMs(seed.startedAt) ?? this.now();
    seed.startedAt = startedAtMs;

    const span = this.startSpan(
      toolSpanName(seed.toolName),
      { kind: SpanKind.INTERNAL, startTime: new Date(startedAtMs) },
      seed.contentCapture,
    );
    applyToolAttributes(span, seed);

    return new ToolExecutionRecorder(
      this,
      span,
      seed,
      startedAtMs,
      seed.contentCapture ?? 'default',
    );
  }

  // ---------------------------------------------------------------------------
  // Retrieval
  // ---------------------------------------------------------------------------

  startRetrieval(start: RetrievalStart): RetrievalRecorder {
    this.assertOpen();
    const seed = this.normalizeRetrievalSeed(start);
    const startedAtMs = toMs(seed.startedAt) ?? this.now();
    seed.startedAt = startedAtMs;

    const span = this.startSpan(
      retrievalSpanName(seed.dataSourceId ?? ''),
      { kind: SpanKind.CLIENT, startTime: new Date(startedAtMs) },
      seed.contentCapture,
    );
    applyRetrievalAttributes(span, seed);

    return new RetrievalRecorder(this, span, seed, startedAtMs, seed.contentCapture ?? 'default');
  }

  // ---------------------------------------------------------------------------
  // Agent invocation
  // ---------------------------------------------------------------------------

  /**
   * Fluent variant — returns an `AgentInvocationRecorder` immediately. Does
   * NOT install the agent's span as the active OTel span, so nested
   * `startGeneration` calls will not auto-parent under it (use the callback
   * variant for that).
   */
  invokeAgent(start: AgentInvocationStart): AgentInvocationRecorder;

  /**
   * Callback variant — installs the agent's span as the active span for the
   * duration of `fn`. Nested generations / tool calls inherit it as their
   * parent via OTel context. Returns the awaited result of `fn`.
   */
  invokeAgent<T>(
    start: AgentInvocationStart,
    fn: (recorder: AgentInvocationRecorder) => Promise<T> | T,
  ): Promise<T>;

  invokeAgent<T>(
    start: AgentInvocationStart,
    fn?: (recorder: AgentInvocationRecorder) => Promise<T> | T,
  ): AgentInvocationRecorder | Promise<T> {
    this.assertOpen();
    const seed = this.normalizeAgentSeed(start);
    const startedAtMs = toMs(seed.startedAt) ?? this.now();
    seed.startedAt = startedAtMs;

    const { links } = this.spanLinks.resolveLinks(seed.parentGenerationIds);

    if (!fn) {
      const span = this.startSpan(
        agentSpanName(seed.agentName),
        { kind: SpanKind.INTERNAL, startTime: new Date(startedAtMs), links },
        seed.contentCapture,
      );
      applyAgentAttributes(span, seed);
      return new AgentInvocationRecorder(
        this,
        span,
        seed,
        startedAtMs,
        seed.contentCapture ?? 'default',
      );
    }

    // Callback variant: use startActiveSpan so children parent correctly.
    return new Promise<T>((resolve, reject) => {
      try {
        this.startActiveSpan(
          agentSpanName(seed.agentName),
          { kind: SpanKind.INTERNAL, startTime: new Date(startedAtMs), links },
          seed.contentCapture,
          async (span: Span) => {
            applyAgentAttributes(span, seed);
            const recorder = new AgentInvocationRecorder(
              this,
              span,
              seed,
              startedAtMs,
              seed.contentCapture ?? 'default',
            );
            try {
              const out = await fn(recorder);
              await recorder.end();
              resolve(out);
            } catch (err) {
              recorder.setError(err);
              try {
                await recorder.end();
              } catch {
                /* ignore */
              }
              reject(err as Error);
            }
          },
        );
      } catch (err) {
        // If startActiveSpan itself throws synchronously (e.g. tracer.disabled
        // or an exotic provider), make sure the promise rejects rather than
        // hanging forever.
        reject(err as Error);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Agent creation
  // ---------------------------------------------------------------------------

  /**
   * Fluent variant — returns an `AgentCreationRecorder` immediately for the
   * caller to populate and end manually. Use when the setup work is
   * asynchronous and does not fit cleanly in a callback.
   */
  createAgent(start: AgentCreationStart): AgentCreationRecorder;

  /**
   * Callback variant — installs the create_agent span as the active span for
   * the duration of `fn`. Any spans created inside `fn` (e.g. tool registration
   * spans) inherit it as their parent. Returns the awaited result of `fn`.
   */
  createAgent<T>(
    start: AgentCreationStart,
    fn: (recorder: AgentCreationRecorder) => Promise<T> | T,
  ): Promise<T>;

  createAgent<T>(
    start: AgentCreationStart,
    fn?: (recorder: AgentCreationRecorder) => Promise<T> | T,
  ): AgentCreationRecorder | Promise<T> {
    this.assertOpen();
    const seed = { ...start };
    const startedAtMs = toMs(seed.startedAt) ?? this.now();
    seed.startedAt = startedAtMs;

    if (!fn) {
      const span = this.startSpan(agentCreateSpanName(seed.agentName), {
        kind: SpanKind.INTERNAL,
        startTime: new Date(startedAtMs),
      });
      applyAgentCreationAttributes(span, seed);
      return new AgentCreationRecorder(this, span, seed, startedAtMs, 'default');
    }

    return new Promise<T>((resolve, reject) => {
      try {
        this.startActiveSpan(
          agentCreateSpanName(seed.agentName),
          { kind: SpanKind.INTERNAL, startTime: new Date(startedAtMs) },
          undefined,
          async (span: Span) => {
            applyAgentCreationAttributes(span, seed);
            const recorder = new AgentCreationRecorder(this, span, seed, startedAtMs, 'default');
            try {
              const out = await fn(recorder);
              await recorder.end();
              resolve(out);
            } catch (err) {
              recorder.setError(err);
              try {
                await recorder.end();
              } catch {
                /* ignore */
              }
              reject(err as Error);
            }
          },
        );
      } catch (err) {
        reject(err as Error);
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Best-effort flush. Drains content-capture work happening in user-supplied
   * `BlobStore` adapters (no-op — recorders own that), and asks the registered
   * `TracerProvider` / `MeterProvider` to flush. Safe to call multiple times.
   * `timeout` is in milliseconds; defaults to no timeout.
   */
  async flush(timeout?: number): Promise<void> {
    await this.forceFlushProviders(timeout);
  }

  /** Idempotent. Calls flush + marks the client closed; subsequent `startX` raise.
   *
   * Note: in-flight recorders that were created before `shutdown()` may still
   * call `end()` after this returns. They will still emit through the
   * registered TracerProvider/MeterProvider, but `forceFlushProviders()` runs
   * synchronously inside this method so trailing telemetry can be silently
   * dropped between `shutdown()` returning and provider shutdown elsewhere.
   * Callers should `await` outstanding recorders before invoking shutdown.
   */
  async shutdown(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.forceFlushProviders();
    } catch (err) {
      this.logger.warn('genai-otel: shutdown flush failed', err);
    }
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.shutdown();
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Starts a span, wrapped in an `AllowListSpan` when the mode is `allow_list`. */
  private startSpan(name: string, options: SpanOptions, perCall?: ContentCaptureMode): Span {
    const mode = resolveContentCaptureMode(
      perCall,
      contentCaptureModeFromContext(),
      this.config.contentCaptureMode,
    );
    if (mode !== 'allow_list') return this.tracer.startSpan(name, options);
    return new AllowListSpan(this.tracer.startSpan(name, allowListSpanOptions(options)));
  }

  /** `tracer.startActiveSpan`, with the span from `startSpan`. */
  private startActiveSpan<T>(
    name: string,
    options: SpanOptions,
    perCall: ContentCaptureMode | undefined,
    fn: (span: Span) => T,
  ): T {
    const span = this.startSpan(name, options, perCall);
    return context.with(trace.setSpan(context.active(), span), fn, undefined, span);
  }

  private normalizeGenerationSeed(
    input: GenerationStart,
    defaultMode: 'SYNC' | 'STREAM',
  ): GenerationStart {
    const seed: GenerationStart = { ...input };
    if (!seed.mode) seed.mode = defaultMode;
    if (!seed.operationName) seed.operationName = OP_CHAT;
    seed.id ??= generateId('gen');
    seed.conversationId ??= conversationIdFromContext() ?? '';
    seed.conversationTitle ??= conversationTitleFromContext() ?? '';
    seed.userId ||= userIdFromContext() ?? this.config.userId;
    seed.agentName ||= agentNameFromContext() ?? this.config.agentName;
    seed.agentVersion ||= agentVersionFromContext() ?? this.config.agentVersion;
    seed.tags = { ...(this.config.tags ?? {}), ...(seed.tags ?? {}) };
    return seed;
  }

  private normalizeEmbeddingSeed(input: EmbeddingStart): EmbeddingStart {
    const seed: EmbeddingStart = { ...input };
    seed.agentName ||= agentNameFromContext() ?? this.config.agentName;
    seed.agentVersion ||= agentVersionFromContext() ?? this.config.agentVersion;
    return seed;
  }

  private normalizeToolSeed(input: ToolExecutionStart): ToolExecutionStart {
    const seed: ToolExecutionStart = { ...input };
    seed.conversationId ||= conversationIdFromContext() ?? '';
    seed.conversationTitle ||= conversationTitleFromContext() ?? '';
    seed.agentName ||= agentNameFromContext() ?? this.config.agentName;
    seed.agentVersion ||= agentVersionFromContext() ?? this.config.agentVersion;
    return seed;
  }

  private normalizeRetrievalSeed(input: RetrievalStart): RetrievalStart {
    const seed: RetrievalStart = { ...input };
    seed.conversationId ||= conversationIdFromContext() ?? '';
    seed.agentName ||= agentNameFromContext() ?? this.config.agentName;
    seed.agentVersion ||= agentVersionFromContext() ?? this.config.agentVersion;
    seed.tags = { ...(this.config.tags ?? {}), ...(seed.tags ?? {}) };
    return seed;
  }

  private normalizeAgentSeed(input: AgentInvocationStart): AgentInvocationStart {
    const seed: AgentInvocationStart = { ...input };
    seed.conversationId ||= conversationIdFromContext() ?? '';
    seed.userId ||= userIdFromContext() ?? this.config.userId;
    seed.agentVersion ||= agentVersionFromContext() ?? this.config.agentVersion;
    return seed;
  }

  private assertOpen() {
    if (this.closed) {
      throw new ClientShutdownError('genai-otel: client has been shut down');
    }
  }

  /**
   * Calls `forceFlush(timeoutMs)` on the currently registered TracerProvider
   * and MeterProvider when those methods exist. Never imports from
   * `@opentelemetry/sdk-*` — duck-typed check only.
   *
   * On timeout, throws `FlushTimeoutError` so the caller can log and decide
   * what to do — the underlying flush keeps running in the background but
   * the caller is no longer waiting on it.
   */
  private async forceFlushProviders(timeoutMs?: number): Promise<void> {
    const tp = trace.getTracerProvider() as { forceFlush?: (t?: number) => Promise<void> };
    const mp = metricsApi.getMeterProvider() as { forceFlush?: (t?: number) => Promise<void> };

    const wait = (p: Promise<void> | undefined): Promise<void> => {
      if (!p) return Promise.resolve();
      if (timeoutMs == null || timeoutMs <= 0) return p;
      return new Promise<void>((resolve, reject) => {
        let settled = false;
        const handle = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new FlushTimeoutError(`genai-otel: flush timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        // Don't keep the event loop alive just for the timeout watchdog.
        if (typeof (handle as { unref?: () => void }).unref === 'function') {
          (handle as { unref: () => void }).unref();
        }
        p.then(
          (v) => {
            if (settled) return;
            settled = true;
            clearTimeout(handle);
            resolve(v);
          },
          (err) => {
            if (settled) return;
            settled = true;
            clearTimeout(handle);
            reject(err);
          },
        );
      });
    };

    const tasks: Promise<void>[] = [];
    if (typeof tp.forceFlush === 'function') {
      try {
        tasks.push(wait(tp.forceFlush(timeoutMs)));
      } catch (err) {
        this.logger.warn('genai-otel: tracer provider flush failed', err);
      }
    }
    if (typeof mp.forceFlush === 'function') {
      try {
        tasks.push(wait(mp.forceFlush(timeoutMs)));
      } catch (err) {
        this.logger.warn('genai-otel: meter provider flush failed', err);
      }
    }
    await Promise.all(tasks);
  }
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

function toMs(value: Date | number | undefined): number | undefined {
  if (value == null) return undefined;
  if (value instanceof Date) return value.getTime();
  return value;
}

// Re-exports kept so callers can pull these in alongside `Client`.
export type { Link, SpanContext };
export { OP_CHAT, OP_EMBEDDINGS };
