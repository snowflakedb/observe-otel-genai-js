/**
 * OpenTelemetry instrumentation for the OpenAI Agents SDK (`@openai/agents`).
 *
 *   registerInstrumentations({
 *     instrumentations: [new OpenAIAgentsInstrumentation(), new OpenAIInstrumentation()],
 *   });
 *
 * Pair it with `OpenAIInstrumentation`: on the default OpenAI model paths the chat
 * spans come from there.
 *
 * What it adds on top of the trace processor:
 *  - Registers the processor, and keeps it registered when the SDK's processor
 *    list is replaced.
 *  - Runs model calls and tool calls inside the OTel context of their agent or
 *    tool span. The SDK keeps no OTel context active between its span callbacks,
 *    so without this, spans from other instrumentations would not nest.
 *  - Closes traces left open when a run or a `withTrace` block rejects, because the
 *    SDK skips `trace.end()` then.
 *
 * CommonJS apps are patched automatically. ESM apps without the OTel loader hook
 * call {@link OpenAIAgentsInstrumentation.manuallyInstrument}.
 */

import { context as otelContext } from '@opentelemetry/api';
import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
  InstrumentationNodeModuleFile,
  isWrapped,
} from '@opentelemetry/instrumentation';

import { Client } from '../../client.js';
import type { ContentCaptureMode } from '../../content/capture.js';
import { withContext } from '../../context.js';
import { VERSION } from '../../version.js';
import type { SdkModel, SdkSpan, SdkTrace } from './_sdk-types.js';
import { GenAIOtelTracingProcessor, RUN_TOKEN_KEY } from './processor.js';

/** The hierarchy logic relies on `task` / `turn` spans, which 0.14 introduced. */
const SUPPORTED_VERSIONS = ['>=0.14.0 <1'];

/** `invokeFunctionTool` is not on the package entry point the runner calls through. */
const TOOL_FILES = ['@openai/agents-core/dist/tool.js', '@openai/agents-core/dist/tool.mjs'];
/** `AiSdkModel` lives behind the `./ai-sdk` subpath, not the package entry point. */
const AI_SDK_FILES = [
  '@openai/agents-extensions/dist/ai-sdk/index.js',
  '@openai/agents-extensions/dist/ai-sdk/index.mjs',
];
const MODEL_CLASSES = ['OpenAIResponsesModel', 'OpenAIChatCompletionsModel', 'AiSdkModel'] as const;
const MODEL_METHODS = ['getResponse', 'getStreamedResponse'] as const;

type Fn = (...args: unknown[]) => unknown;
type ModelMethod = (typeof MODEL_METHODS)[number];
type CurrentSpan = () => SdkSpan | null;

interface TraceProvider {
  registerProcessor(processor: unknown): void;
  setProcessors(processors: unknown[]): void;
}

interface AgentsCoreExports {
  Runner?: { prototype: { run: Fn } };
  withTrace: Fn;
  getCurrentSpan?: CurrentSpan;
  getCurrentTrace?: () => SdkTrace | null;
  getGlobalTraceProvider?: () => TraceProvider;
}

interface ToolModuleExports {
  invokeFunctionTool: Fn;
}

type ModelModuleExports = Partial<
  Record<(typeof MODEL_CLASSES)[number], { prototype: Record<ModelMethod, Fn> }>
>;

export interface OpenAIAgentsInstrumentationConfig extends InstrumentationConfig {
  /** Reuse an existing `Client`. Otherwise one is created from this instrumentation's tracer and meter. */
  client?: Client;
  /** Content-capture override for every span this integration emits. */
  contentCapture?: ContentCaptureMode;
  /** Cap on open traces; see `GenAIOtelTracingProcessorOptions.maxTracesInFlight`. */
  maxTracesInFlight?: number;
}

export class OpenAIAgentsInstrumentation extends InstrumentationBase<OpenAIAgentsInstrumentationConfig> {
  private processorInstance?: GenAIOtelTracingProcessor;
  private ownedClient?: Client;
  private getCurrentSdkSpan?: CurrentSpan;
  private getCurrentSdkTrace?: () => SdkTrace | null;
  private readonly manualModules = new Set<object>();

  constructor(config: OpenAIAgentsInstrumentationConfig = {}) {
    super('@genai-otel/instrumentation-openai-agents', VERSION, config);
  }

  /**
   * The registered trace processor, for `forceFlush()` or custom setups.
   *
   * It stays registered when the SDK's list is replaced, so an app can stop
   * sending agent traces to OpenAI with `setTraceProcessors([])` and keep these.
   */
  get processor(): GenAIOtelTracingProcessor {
    if (!this.processorInstance) {
      const { client, contentCapture, maxTracesInFlight } = this.getConfig();
      if (!client) this.ownedClient = new Client({ tracer: this.tracer, meter: this.meter });
      this.processorInstance = new GenAIOtelTracingProcessor({
        client: client ?? this.ownedClient,
        contentCapture,
        maxTracesInFlight,
        getCurrentTrace: () => this.getCurrentSdkTrace?.() ?? null,
      });
    }
    return this.processorInstance;
  }

  protected init(): InstrumentationNodeModuleDefinition[] {
    const core = (exports: AgentsCoreExports) => this.patchCore(exports);
    const unpatchCore = (exports?: AgentsCoreExports) => this.unpatchCore(exports);
    const models = (exports: ModelModuleExports) => this.patchModels(exports);
    const unpatchModels = (exports?: ModelModuleExports) => this.unpatchModels(exports);

    return [
      new InstrumentationNodeModuleDefinition(
        '@openai/agents-core',
        SUPPORTED_VERSIONS,
        core,
        unpatchCore,
        TOOL_FILES.map(
          (name) =>
            new InstrumentationNodeModuleFile(
              name,
              SUPPORTED_VERSIONS,
              (exports: ToolModuleExports) => this.patchTools(exports),
              (exports?: ToolModuleExports) => this.unpatchTools(exports),
            ),
        ),
      ),
      new InstrumentationNodeModuleDefinition(
        '@openai/agents',
        SUPPORTED_VERSIONS,
        core,
        unpatchCore,
      ),
      new InstrumentationNodeModuleDefinition(
        '@openai/agents-openai',
        SUPPORTED_VERSIONS,
        models,
        unpatchModels,
      ),
      new InstrumentationNodeModuleDefinition(
        '@openai/agents-extensions',
        SUPPORTED_VERSIONS,
        models,
        unpatchModels,
        AI_SDK_FILES.map(
          (name) =>
            new InstrumentationNodeModuleFile(name, SUPPORTED_VERSIONS, models, unpatchModels),
        ),
      ),
    ];
  }

  /**
   * Patches Agents SDK module namespaces directly, for ESM apps started without the
   * OTel loader hook:
   *
   *   import * as Agents from '@openai/agents';
   *   import * as AiSdk from '@openai/agents-extensions/ai-sdk';
   *   instrumentation.manuallyInstrument(Agents, AiSdk);
   *
   * ESM namespaces are read-only, so two things need the CommonJS hook or the OTel
   * loader hook: closing a `withTrace` block that throws, and nesting spans
   * created inside tool functions.
   */
  manuallyInstrument(...moduleExports: object[]): void {
    for (const exports of moduleExports) {
      this.patchManual(exports);
      this.manualModules.add(exports);
    }
  }

  private patchManual(exports: object): void {
    const core = exports as AgentsCoreExports;
    if (core.getGlobalTraceProvider) this.patchCore(core);
    this.patchModels(exports as ModelModuleExports);
  }

  override enable(): void {
    super.enable();
    this.processorInstance?.resume();
    // `manualModules` is still empty while the base constructor calls this.
    for (const exports of this.manualModules ?? []) this.patchManual(exports);
  }

  /**
   * Unpatches, and ends every span still open. The processor stays in the SDK's
   * list, since the SDK cannot remove one, but ignores work until re-enabled.
   */
  override disable(): void {
    super.disable();
    for (const exports of this.manualModules) {
      this.unpatchCore(exports as AgentsCoreExports);
      this.unpatchModels(exports as ModelModuleExports);
    }
    void this.processorInstance?.stop();
  }

  /** Ends every open span, flushes, and shuts down a client this instrumentation created. */
  async shutdown(timeout?: number): Promise<void> {
    await this.processorInstance?.stop(timeout);
    await this.ownedClient?.shutdown();
  }

  // ---------------------------------------------------------------------------
  // agents-core
  // ---------------------------------------------------------------------------

  private patchCore(exports: AgentsCoreExports): AgentsCoreExports {
    this.getCurrentSdkSpan ??= exports.getCurrentSpan;
    this.getCurrentSdkTrace ??= exports.getCurrentTrace;
    this.registerProcessor(exports);
    this.patchRunnerRun(exports);
    this.patchWithTrace(exports);
    return exports;
  }

  private unpatchCore(exports?: AgentsCoreExports): void {
    if (exports?.Runner && isWrapped(exports.Runner.prototype.run)) {
      this._unwrap(exports.Runner.prototype, 'run');
    }
    if (exports && isWrapped(exports.withTrace)) this._unwrap(exports, 'withTrace');
  }

  private registerProcessor(exports: AgentsCoreExports): void {
    const provider = exports.getGlobalTraceProvider?.();
    if (!provider) return;
    const kept = keptProcessors(provider);
    if (kept.has(this.processor)) return;
    kept.add(this.processor);
    provider.registerProcessor(this.processor);
  }

  private patchRunnerRun(exports: AgentsCoreExports): void {
    const prototype = exports.Runner?.prototype;
    if (!prototype || isWrapped(prototype.run)) return;
    const instrumentation = this;
    this._wrap(prototype, 'run', (original: Fn) => {
      return function run(this: unknown, ...args: unknown[]) {
        const processor = instrumentation.processor;
        const [, , options] = args as [unknown, unknown, { stream?: boolean } | undefined];
        const token = processor.beginRun(options?.stream === true);
        const ctx = otelContext.active().setValue(RUN_TOKEN_KEY, token);
        const result = otelContext.with(ctx, () => original.apply(this, args)) as Promise<unknown>;
        return result.catch((err: unknown) => {
          void processor.onRunError(token, err);
          throw err;
        });
      };
    });
  }

  private patchWithTrace(exports: AgentsCoreExports): void {
    const descriptor = Object.getOwnPropertyDescriptor(exports, 'withTrace');
    if (!descriptor?.configurable || isWrapped(exports.withTrace)) return;
    const instrumentation = this;
    this._wrap(exports, 'withTrace', (original: Fn) => {
      return function withTrace(this: unknown, ...args: unknown[]) {
        const [name, callback, ...rest] = args as [unknown, Fn, ...unknown[]];
        const guarded = async (trace: { traceId: string }) => {
          try {
            return await callback(trace);
          } catch (err) {
            void instrumentation.processorInstance?.failTrace(trace.traceId, err);
            throw err;
          }
        };
        return original.call(this, name, guarded, ...rest);
      };
    });
  }

  private patchTools(exports: ToolModuleExports): ToolModuleExports {
    if (!exports.invokeFunctionTool || isWrapped(exports.invokeFunctionTool)) return exports;
    const instrumentation = this;
    this._wrap(exports, 'invokeFunctionTool', (original: Fn) => {
      return function invokeFunctionTool(this: unknown, ...args: unknown[]) {
        const processor = instrumentation.processorInstance;
        if (!processor) return original.apply(this, args);
        const scope = sdkSpanScope(processor, instrumentation.getCurrentSdkSpan?.() ?? null);
        return scope(() => original.apply(this, args));
      };
    });
    return exports;
  }

  private unpatchTools(exports?: ToolModuleExports): void {
    if (exports && isWrapped(exports.invokeFunctionTool))
      this._unwrap(exports, 'invokeFunctionTool');
  }

  // ---------------------------------------------------------------------------
  // Model classes
  // ---------------------------------------------------------------------------

  private patchModels(exports: ModelModuleExports): ModelModuleExports {
    for (const name of MODEL_CLASSES) {
      const prototype = exports[name]?.prototype;
      if (!prototype) continue;
      for (const method of MODEL_METHODS) {
        if (isWrapped(prototype[method])) continue;
        this._wrap(prototype, method, (original: Fn) =>
          wrapModelMethod(
            method,
            original,
            () => this.processorInstance,
            () => this.getCurrentSdkSpan?.() ?? null,
          ),
        );
      }
    }
    return exports;
  }

  private unpatchModels(exports?: ModelModuleExports): void {
    for (const name of MODEL_CLASSES) {
      const prototype = exports?.[name]?.prototype;
      if (!prototype) continue;
      for (const method of MODEL_METHODS) {
        if (isWrapped(prototype[method])) this._unwrap(prototype, method);
      }
    }
  }
}

/**
 * Wraps a hand-written `Model`, which automatic patching cannot reach, so its calls
 * run under the enclosing agent span:
 *
 *   import { getCurrentSpan } from '@openai/agents';
 *   const model = instrumentModel(new MyModel(), instrumentation.processor, getCurrentSpan);
 *
 * The returned object delegates to `model`, which is left unchanged.
 */
export function instrumentModel<T extends SdkModel>(
  model: T,
  processor: GenAIOtelTracingProcessor,
  getCurrentSpan: CurrentSpan,
): T {
  const wrapped = Object.create(model) as T;
  for (const method of MODEL_METHODS) {
    const original = model[method].bind(model) as Fn;
    Object.assign(wrapped, {
      [method]: wrapModelMethod(method, original, () => processor, getCurrentSpan),
    });
  }
  return wrapped;
}

const keptByProvider = new WeakMap<TraceProvider, Set<unknown>>();

/**
 * Processors that stay in the provider's list when it is replaced. `@openai/agents`
 * replaces the list while it loads, and apps may replace it too. The provider is
 * one global object shared by every copy of the SDK, so this is keyed on it.
 */
function keptProcessors(provider: TraceProvider): Set<unknown> {
  const existing = keptByProvider.get(provider);
  if (existing) return existing;
  const kept = new Set<unknown>();
  const setProcessors = provider.setProcessors.bind(provider);
  provider.setProcessors = (next) =>
    setProcessors([...next, ...[...kept].filter((p) => !next.includes(p))]);
  keptByProvider.set(provider, kept);
  return kept;
}

type Scope = <R>(fn: () => R) => R;

/** Runs code in the OTel context and ambient identity of the given SDK span. */
function sdkSpanScope(processor: GenAIOtelTracingProcessor, sdkSpan: SdkSpan | null): Scope {
  const { context, identity } = processor.callScope(sdkSpan);
  return (fn) => otelContext.with(context, () => withContext(identity, fn));
}

function wrapModelMethod(
  method: ModelMethod,
  original: Fn,
  getProcessor: () => GenAIOtelTracingProcessor | undefined,
  getSdkSpan: CurrentSpan,
): Fn {
  return function modelMethod(this: unknown, ...args: unknown[]) {
    const processor = getProcessor();
    if (!processor) return original.apply(this, args);
    const sdkSpan = getSdkSpan();
    const scope = sdkSpanScope(processor, sdkSpan);
    const result = scope(() => original.apply(this, args));
    if (method === 'getResponse') return result;
    return scopeEveryStep(result as AsyncIterable<unknown>, scope, () =>
      processor.markFirstToken(sdkSpan?.spanId, processor.client.now()),
    );
  };
}

/**
 * Re-enters `scope` on every step of a stream. `getStreamedResponse` is an async
 * generator: its body, including the HTTP request, runs on each `next()` and does
 * not inherit the context it was created in. Also reports the first event that
 * carries generated content, for time-to-first-token.
 */
function scopeEveryStep(
  stream: AsyncIterable<unknown>,
  scope: Scope,
  onFirstContent: () => void,
): AsyncIterable<unknown> {
  let seenContent = false;
  return {
    [Symbol.asyncIterator]() {
      const it = scope(() => stream[Symbol.asyncIterator]());
      return {
        next: () =>
          scope(() => it.next()).then((step) => {
            if (!seenContent && !step.done && carriesGeneratedContent(step.value)) {
              seenContent = true;
              onFirstContent();
            }
            return step;
          }),
        return: it.return && ((value?: unknown) => scope(() => it.return!(value))),
        throw: it.throw && ((error?: unknown) => scope(() => it.throw!(error))),
      };
    },
  };
}

/**
 * Whether a stream event carries model output. Streams open with bookkeeping
 * events (`response_started`, `stream-start`, `text-start`) that arrive with the
 * request, so the first event is not the first token. Delta events are:
 * `output_text_delta`, AI SDK parts such as `text-delta`, and Responses events
 * such as `response.output_text.delta`, the last two wrapped in a `model` event.
 */
function carriesGeneratedContent(event: unknown): boolean {
  const { type, event: inner } = (event ?? {}) as { type?: string; event?: { type?: string } };
  return isDelta(type) || (type === 'model' && isDelta(inner?.type));
}

function isDelta(type: string | undefined): boolean {
  return /[-._]delta$/.test(type ?? '');
}
