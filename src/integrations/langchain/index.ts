/**
 * LangChain.js adapter.
 *
 * `GenAIOtelCallbackHandler` implements LangChain's `BaseCallbackHandler`
 * interface and emits `@genai-otel/core` recorders for every LLM, tool, and
 * chain run.
 *
 * Mapping:
 *  - `handleLLMStart`  → `client.startGeneration({...})`. Captures `runId` so
 *                        subsequent `handleLLMNewToken` / `handleLLMEnd` /
 *                        `handleLLMError` find the matching recorder.
 *  - `handleLLMNewToken` → first call invokes `recorder.setFirstTokenAt(...)`
 *                        for TTFT.
 *  - `handleLLMEnd`    → `recorder.setResult(...)` + `recorder.end()`.
 *  - `handleLLMError`  → `recorder.setCallError(err)` + `recorder.end()`.
 *  - `handleToolStart` → `client.startToolExecution({...})`.
 *  - `handleToolEnd`   → `recorder.setResult({ result })` + `recorder.end()`.
 *  - `handleToolError` → `recorder.setExecError(err)` + `recorder.end()`.
 *  - `handleChainStart`/`End`/`Error` → optional `invokeAgent` lifecycle.
 *  - `handleRetrieverStart` → `client.startRetrieval({...})`. The retrieval span
 *                        becomes the active parent, so an in-retriever query
 *                        rewrite (`chat`) and any descendants nest under it.
 *  - `handleRetrieverEnd`  → `recorder.setDocuments(...)` + `recorder.end()`.
 *  - `handleRetrieverError`→ `recorder.setCallError(err)` + `recorder.end()`.
 *
 * Use:
 *   const handler = new GenAIOtelCallbackHandler({ client });
 *   await chain.invoke(input, { callbacks: [handler] });
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import type { Serialized } from '@langchain/core/load/serializable';
import type { BaseMessage } from '@langchain/core/messages';
import type { LLMResult } from '@langchain/core/outputs';
import type { ChainValues } from '@langchain/core/utils/types';

import type { Client } from '../../client.js';
import type { ContentCaptureMode } from '../../content/capture.js';
import type { ToolDefinition } from '../../models/generation.js';
import {
  type Message,
  type Part,
  assistantTextMessage,
  textPart,
  toolCallPart,
  toolResultPart,
  userTextMessage,
} from '../../models/message.js';
import type { RetrievalDocument } from '../../models/retrieval.js';
import type { AgentInvocationRecorder } from '../../recorders/agent.js';
import type { GenerationRecorder } from '../../recorders/generation.js';
import type { RetrievalRecorder } from '../../recorders/retrieval.js';
import type { ToolExecutionRecorder } from '../../recorders/tool.js';

export interface GenAIOtelCallbackHandlerOptions {
  client: Client;
  /** Default agent name for all spans created by this handler. */
  agentName?: string;
  agentVersion?: string;
  conversationId?: string;
  conversationTitle?: string;
  userId?: string;
  turnIndex?: number;
  turnRole?: string;
  contentCapture?: ContentCaptureMode;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  /**
   * When `true` (default), every top-level chain start becomes an
   * `invoke_agent` span. Set to `false` to skip chain instrumentation and
   * only capture LLM + tool spans.
   */
  captureChains?: boolean;
  /**
   * When `true`, nested chain runs (e.g. each LangGraph node) also become
   * `invoke_agent` spans. Defaults to `false` so the trace stays focused on
   * the outermost graph invocation. Set to `true` to get a per-node tree.
   */
  captureNestedChains?: boolean;
}

interface ModelHint {
  provider: string;
  name: string;
}

export class GenAIOtelCallbackHandler extends BaseCallbackHandler {
  override name = 'genai-otel';
  /** LangChain uses this to dedupe duplicate handler instances. */
  override ignoreLLM = false;
  override ignoreChain = false;
  override ignoreAgent = false;
  override ignoreRetriever = false;
  override ignoreCustomEvent = true;

  private readonly client: Client;
  private readonly defaults: Omit<GenAIOtelCallbackHandlerOptions, 'client'>;
  private readonly captureChains: boolean;
  private readonly captureNestedChains: boolean;

  /** runId → recorder maps so handle*End/handle*Error can find their start. */
  private readonly llmRunMap = new Map<
    string,
    { rec: GenerationRecorder; firstTokenSeen: boolean }
  >();
  private readonly toolRunMap = new Map<string, ToolExecutionRecorder>();
  private readonly chainRunMap = new Map<string, AgentInvocationRecorder>();
  private readonly retrieverRunMap = new Map<string, RetrievalRecorder>();

  /** runId → parentRunId for the whole run tree, including suppressed chains, so
   *  nearestRecorder can walk up to the closest run that owns a span. */
  private readonly runParent = new Map<string, string | undefined>();

  constructor(options: GenAIOtelCallbackHandlerOptions) {
    // Run callbacks inline in the caller's async context instead of on
    // LangChain's shared background queue, so concurrent runs don't leak each
    // other's AsyncLocalStorage / OpenTelemetry context (parent trace,
    // ambient conversationId).
    super({ _awaitHandler: true });
    this.client = options.client;
    const { client: _c, captureChains, captureNestedChains, ...rest } = options;
    this.defaults = rest;
    this.captureChains = captureChains !== false;
    this.captureNestedChains = captureNestedChains === true;
  }

  // ---------------------------------------------------------------------------
  // Span nesting: attach each child recorder's span under the nearest ancestor
  // ---------------------------------------------------------------------------

  /** The recorder owning this run's span, if any (LLM / tool / chain). */
  private recorderForRun(runId: string): { withActiveContext<T>(fn: () => T): T } | undefined {
    const llm = this.llmRunMap.get(runId);
    if (llm) return llm.rec;
    return (
      this.toolRunMap.get(runId) ?? this.retrieverRunMap.get(runId) ?? this.chainRunMap.get(runId)
    );
  }

  /** Walk parentRunId up the run tree to the nearest run that owns a span. */
  private nearestRecorder(
    runId: string | undefined,
  ): { withActiveContext<T>(fn: () => T): T } | undefined {
    let cur = runId;
    const seen = new Set<string>();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const rec = this.recorderForRun(cur);
      if (rec) return rec;
      cur = this.runParent.get(cur);
    }
    return undefined;
  }

  /** Run `start` with the nearest ancestor span active, so the span it creates
   *  parents under it. No ancestor: ambient context (a new root). */
  private nested<T>(parentRunId: string | undefined, start: () => T): T {
    const anc = this.nearestRecorder(parentRunId);
    return anc ? anc.withActiveContext(start) : start();
  }

  /** `gen_ai.conversation.id`: handler `conversationId`, else the run's
   *  `thread_id` (from `configurable.thread_id` via a checkpointer). */
  private conversationId(metadata?: Record<string, unknown>): string | undefined {
    if (this.defaults.conversationId) return this.defaults.conversationId;
    const t = metadata?.thread_id;
    return typeof t === 'string' && t.length > 0 ? t : undefined;
  }

  // ---------------------------------------------------------------------------
  // LLM lifecycle
  // ---------------------------------------------------------------------------

  override async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Raw string-completion path (also the fallback LangChain uses for chat
    // models when a handler has no `handleChatModelStart`). Each prompt becomes
    // a user message.
    const input = prompts
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => userTextMessage(p));
    this.openGeneration(
      modelFromSerialized(llm, extraParams),
      input,
      runId,
      parentRunId,
      metadata,
      isStreaming(extraParams),
      toolDefinitionsFromExtraParams(extraParams),
    );
  }

  override async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
    _tags?: string[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    // Chat-model path: structured messages with real roles. System messages are
    // part of the provided chat history, so they map to input.messages (role
    // `system`) rather than to gen_ai.system_instructions.
    const input = mapBaseMessages(messages[0] ?? []);
    this.openGeneration(
      modelFromSerialized(llm, extraParams),
      input,
      runId,
      parentRunId,
      metadata,
      isStreaming(extraParams),
      toolDefinitionsFromExtraParams(extraParams),
    );
  }

  private openGeneration(
    model: ModelHint,
    input: Message[],
    runId: string,
    parentRunId?: string,
    metadata?: Record<string, unknown>,
    streaming = false,
    tools?: ToolDefinition[],
  ): void {
    this.runParent.set(runId, parentRunId);
    const seed = {
      model,
      agentName: this.defaults.agentName,
      agentVersion: this.defaults.agentVersion,
      conversationId: this.conversationId(metadata),
      conversationTitle: this.defaults.conversationTitle,
      userId: this.defaults.userId,
      turnIndex: this.defaults.turnIndex,
      turnRole: this.defaults.turnRole,
      contentCapture: this.defaults.contentCapture,
      tools,
      tags: this.defaults.tags,
      metadata: this.defaults.metadata,
    };
    const rec = this.nested(parentRunId, () =>
      streaming ? this.client.startStreamingGeneration(seed) : this.client.startGeneration(seed),
    );
    if (input.length > 0) rec.setResult({ input });
    this.llmRunMap.set(runId, { rec, firstTokenSeen: false });
  }

  override async handleLLMNewToken(token: string, _idx: unknown, runId: string): Promise<void> {
    const entry = this.llmRunMap.get(runId);
    if (!entry || entry.firstTokenSeen) return;
    if (token.length === 0) return;
    entry.firstTokenSeen = true;
    entry.rec.setFirstTokenAt(Date.now());
    // Receiving streamed tokens is itself proof the call is streaming. Upgrade
    // the mode so gen_ai.request.stream and time_to_first_token land even when
    // the provider didn't expose invocation_params.stream at start.
    entry.rec.setResult({ mode: 'STREAM' });
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const entry = this.llmRunMap.get(runId);
    if (!entry) return;
    this.llmRunMap.delete(runId);
    entry.rec.setResult({
      usage: mapLangChainUsage(output),
      stopReason: extractStopReason(output),
      responseId: extractResponseId(output),
      output: mapLangChainOutput(output),
    });
    await safeEnd(entry.rec);
  }

  override async handleLLMError(err: unknown, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const entry = this.llmRunMap.get(runId);
    if (!entry) return;
    this.llmRunMap.delete(runId);
    entry.rec.setCallError(err);
    await safeEnd(entry.rec);
  }

  // ---------------------------------------------------------------------------
  // Tool lifecycle
  // ---------------------------------------------------------------------------

  override async handleToolStart(
    tool: Serialized,
    input: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    runName?: string,
  ): Promise<void> {
    this.runParent.set(runId, parentRunId);
    const rec = this.nested(parentRunId, () =>
      this.client.startToolExecution({
        // runName also covers failures (no ToolMessage); handleToolEnd overrides on success.
        toolName: nonEmpty(runName) ?? toolNameFromSerialized(tool),
        agentName: this.defaults.agentName,
        agentVersion: this.defaults.agentVersion,
        conversationId: this.conversationId(metadata),
        contentCapture: this.defaults.contentCapture,
      }),
    );
    rec.setResult({ arguments: input });
    this.toolRunMap.set(runId, rec);
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const rec = this.toolRunMap.get(runId);
    if (!rec) return;
    this.toolRunMap.delete(runId);
    rec.setToolCallId(toolCallIdFromOutput(output));
    rec.setToolName(toolNameFromOutput(output));
    rec.setResult({ result: toolResultFromOutput(output) });
    await safeEnd(rec);
  }

  override async handleToolError(err: unknown, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const rec = this.toolRunMap.get(runId);
    if (!rec) return;
    this.toolRunMap.delete(runId);
    rec.setExecError(err);
    await safeEnd(rec);
  }

  // ---------------------------------------------------------------------------
  // Chain lifecycle (mapped to invoke_agent)
  // ---------------------------------------------------------------------------

  override async handleChainStart(
    chain: Serialized,
    inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): Promise<void> {
    // Record every chain run, including suppressed ones, so descendant spans
    // can walk up to a real ancestor (see nearestRecorder).
    this.runParent.set(runId, parentRunId);

    // Top-level chains become invoke_agent spans. Nested chains only do so when
    // captureNestedChains is on (off by default, to keep the trace at the
    // outer agent boundary).
    if (!this.captureChains) return;
    if (parentRunId && !this.captureNestedChains) return;

    const rec = this.nested(parentRunId, () =>
      this.client.invokeAgent({
        agentName:
          this.defaults.agentName ?? runName ?? toolNameFromSerialized(chain) ?? 'langchain-chain',
        agentVersion: this.defaults.agentVersion,
        input: chainInputToMessages(inputs),
        conversationId: this.conversationId(metadata),
        userId: this.defaults.userId,
        contentCapture: this.defaults.contentCapture,
        tags: this.defaults.tags,
        metadata: this.defaults.metadata,
      }),
    );
    this.chainRunMap.set(runId, rec);
  }

  override async handleChainEnd(output: ChainValues, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const rec = this.chainRunMap.get(runId);
    if (!rec) return;
    this.chainRunMap.delete(runId);
    rec.setOutput(chainOutputToMessages(output));
    await safeEnd(rec);
  }

  override async handleChainError(err: unknown, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const rec = this.chainRunMap.get(runId);
    if (!rec) return;
    this.chainRunMap.delete(runId);
    rec.setError(err);
    await safeEnd(rec);
  }

  // ---------------------------------------------------------------------------
  // Retriever lifecycle (mapped to a retrieval span, kind CLIENT)
  // ---------------------------------------------------------------------------

  override async handleRetrieverStart(
    retriever: Serialized,
    query: string,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    metadata?: Record<string, unknown>,
    _name?: string,
  ): Promise<void> {
    this.runParent.set(runId, parentRunId);
    const rec = this.nested(parentRunId, () =>
      this.client.startRetrieval({
        dataSourceId: dataSourceIdFromRetriever(retriever),
        topK: topKFromRetriever(retriever),
        queryText: typeof query === 'string' && query.length > 0 ? query : undefined,
        agentName: this.defaults.agentName,
        agentVersion: this.defaults.agentVersion,
        conversationId: this.conversationId(metadata),
        contentCapture: this.defaults.contentCapture,
        tags: this.defaults.tags,
        metadata: this.defaults.metadata,
      }),
    );
    this.retrieverRunMap.set(runId, rec);
  }

  override async handleRetrieverEnd(documents: unknown[], runId: string): Promise<void> {
    this.runParent.delete(runId);
    const rec = this.retrieverRunMap.get(runId);
    if (!rec) return;
    this.retrieverRunMap.delete(runId);
    rec.setDocuments(mapRetrieverDocuments(documents));
    await safeEnd(rec);
  }

  override async handleRetrieverError(err: unknown, runId: string): Promise<void> {
    this.runParent.delete(runId);
    const rec = this.retrieverRunMap.get(runId);
    if (!rec) return;
    this.retrieverRunMap.delete(runId);
    rec.setCallError(err);
    await safeEnd(rec);
  }

  /**
   * Ends any recorders still open (LLM / tool / chain runs whose end/error
   * callback never fired — e.g. an abandoned `.stream()` or a runner exception
   * between start and end). Call on shutdown when a single handler instance is
   * reused across many requests, to avoid leaked spans and unbounded map growth.
   */
  async dispose(): Promise<void> {
    const err = new Error('genai-otel: LangChain handler disposed with an open run');
    for (const { rec } of this.llmRunMap.values()) {
      rec.setCallError(err);
      await safeEnd(rec);
    }
    this.llmRunMap.clear();
    for (const rec of this.toolRunMap.values()) {
      rec.setExecError(err);
      await safeEnd(rec);
    }
    this.toolRunMap.clear();
    for (const rec of this.chainRunMap.values()) {
      rec.setError(err);
      await safeEnd(rec);
    }
    this.chainRunMap.clear();
    for (const rec of this.retrieverRunMap.values()) {
      rec.setCallError(err);
      await safeEnd(rec);
    }
    this.retrieverRunMap.clear();
    this.runParent.clear();
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Ends a recorder without ever letting a telemetry/export error escape into
 * LangChain's callback runner (which, depending on version, may reject the
 * user's `invoke`/`stream` call on a rejected async callback).
 */
async function safeEnd(rec: { end(): Promise<void> }): Promise<void> {
  try {
    await rec.end();
  } catch {
    /* ignore — instrumentation must not break the user's chain */
  }
}

/**
 * Converts a LangChain chain input into `gen_ai.input.messages`.
 *
 * A `messages` array (LangGraph et al.) uses the `BaseMessage` mapping; a
 * string, or a string `input`/`question`/`text` field, becomes one user
 * message; any other shape is JSON-encoded. Empty input returns `[]`.
 */
function chainInputToMessages(inputs: ChainValues | undefined): Message[] {
  if (inputs == null) return [];
  if (typeof inputs === 'string') return inputs === '' ? [] : [userTextMessage(inputs)];
  if (typeof inputs !== 'object') return [];

  const rec = inputs as Record<string, unknown>;
  if (Array.isArray(rec.messages)) {
    const mapped = mapBaseMessages(rec.messages);
    if (mapped.length > 0) return mapped;
  }

  const candidate = rec.input ?? rec.question ?? rec.text;
  if (typeof candidate === 'string') return candidate === '' ? [] : [userTextMessage(candidate)];

  // Nothing recognizable: fall back to the whole payload, but don't emit a
  // message for an empty one (`{}` / `[]` is noise, not input).
  if (Object.keys(rec).length === 0) return [];
  let text: string;
  try {
    text = JSON.stringify(inputs);
  } catch {
    return [];
  }
  return text === '' ? [] : [userTextMessage(text)];
}

/**
 * Converts a LangChain chain output into `gen_ai.output.messages`.
 *
 * A `messages` array (LangGraph et al.) returns the whole conversation, so we
 * map only its last entry — the agent's answer; the rest is history already
 * captured as input. Once `messages` is present we never JSON-encode the rest
 * of the graph state (empty / unrenderable → `[]`). Otherwise a string, or a
 * string `output`/`text` field, becomes one assistant message; any other shape
 * is JSON-encoded. Empty output returns `[]`.
 */
function chainOutputToMessages(output: ChainValues | undefined): Message[] {
  if (output == null) return [];
  if (typeof output === 'string') return output === '' ? [] : [assistantTextMessage(output)];
  if (typeof output !== 'object') return [];

  const rec = output as Record<string, unknown>;
  if (Array.isArray(rec.messages)) {
    if (rec.messages.length === 0) return [];
    return mapBaseMessages([rec.messages[rec.messages.length - 1]]);
  }

  const candidate = rec.output ?? rec.text;
  if (typeof candidate === 'string') {
    return candidate === '' ? [] : [assistantTextMessage(candidate)];
  }

  if (Object.keys(rec).length === 0) return [];
  let text: string;
  try {
    text = JSON.stringify(output);
  } catch {
    return [];
  }
  return text === '' ? [] : [assistantTextMessage(text)];
}

// -----------------------------------------------------------------------------
// Message mapping (LangChain BaseMessage -> genai-otel Message[])
// -----------------------------------------------------------------------------

interface LCBaseMessage {
  _getType?: () => string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; name?: string; args?: unknown }>;
  tool_call_id?: string;
}

function lcRole(t: string | undefined): Message['role'] {
  switch (t) {
    case 'human':
      return 'user';
    case 'ai':
      return 'assistant';
    case 'system':
    case 'developer':
      return 'system';
    case 'tool':
    case 'function':
      return 'tool';
    default:
      return 'user';
  }
}

function lcContentText(content: unknown): string | undefined {
  if (typeof content === 'string') return content || undefined;
  if (Array.isArray(content)) {
    let s = '';
    for (const p of content) {
      if (p && typeof p === 'object' && (p as { type?: string }).type === 'text') {
        const t = (p as { text?: string }).text;
        if (typeof t === 'string') s += t;
      }
    }
    return s || undefined;
  }
  return undefined;
}

function baseMessageParts(msg: LCBaseMessage): Part[] {
  const parts: Part[] = [];
  const text = lcContentText(msg.content);
  if (text) parts.push(textPart(text));
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      parts.push(toolCallPart({ name: tc.name ?? '', id: tc.id, inputJson: lcJson(tc.args) }));
    }
  }
  return parts;
}

function mapBaseMessages(messages: readonly unknown[]): Message[] {
  const out: Message[] = [];
  for (const raw of messages) {
    if (!raw || typeof raw !== 'object') continue;
    const msg = raw as LCBaseMessage;
    const role = lcRole(typeof msg._getType === 'function' ? msg._getType() : undefined);
    if (role === 'tool') {
      out.push({
        role: 'tool',
        parts: [
          toolResultPart({ toolCallId: msg.tool_call_id, content: lcContentText(msg.content) }),
        ],
      });
      continue;
    }
    const parts = baseMessageParts(msg);
    if (parts.length > 0) out.push({ role, parts });
  }
  return out;
}

/** Maps an `LLMResult`'s first generation to an assistant output message. */
function mapLangChainOutput(output: LLMResult): Message[] {
  const gens = output.generations?.[0];
  if (!gens || gens.length === 0) return [];
  const first = gens[0] as { text?: string; message?: LCBaseMessage };
  if (first.message) {
    const parts = baseMessageParts(first.message);
    if (parts.length > 0) return [{ role: 'assistant', parts }];
  }
  if (typeof first.text === 'string' && first.text) return [assistantTextMessage(first.text)];
  return [];
}

function lcJson(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function modelFromSerialized(llm: Serialized, extraParams?: Record<string, unknown>): ModelHint {
  // LangChain's `Serialized` shape varies; we look for common patterns.
  // Examples:
  //   { lc: 1, type: 'constructor', id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'], kwargs: { model: 'gpt-4o' } }
  const id = (llm as { id?: string[] }).id ?? [];
  const provider = inferProvider(id);
  const kwargs = (llm as { kwargs?: Record<string, unknown> }).kwargs ?? {};
  const modelName =
    (kwargs.model as string | undefined) ??
    (kwargs.modelName as string | undefined) ??
    (extraParams?.model as string | undefined) ??
    ((extraParams?.invocation_params as Record<string, unknown> | undefined)?.model as
      | string
      | undefined) ??
    'unknown';
  return { provider, name: modelName };
}

function inferProvider(idPath: readonly string[]): string {
  const lc = idPath.map((s) => s.toLowerCase());
  if (lc.includes('openai')) return 'openai';
  if (lc.includes('anthropic')) return 'anthropic';
  if (lc.includes('googlegenai') || lc.includes('gemini') || lc.includes('vertexai'))
    return 'google';
  if (lc.includes('mistralai')) return 'mistralai';
  if (lc.includes('cohere')) return 'cohere';
  if (lc.includes('bedrock')) return 'aws-bedrock';
  if (lc.includes('azure')) return 'azure-openai';
  if (lc.includes('ollama')) return 'ollama';
  return idPath[idPath.length - 1] ?? 'langchain';
}

function toolNameFromSerialized(s: Serialized): string {
  const id = (s as { id?: string[] }).id ?? [];
  return id[id.length - 1] ?? 'tool';
}

/** The tool's real `name` from a tool-end `ToolMessage` (`_getType() === 'tool'`); `undefined` otherwise. */
function toolNameFromOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const msg = output as { name?: unknown; _getType?: () => string };
  if (typeof msg._getType !== 'function' || msg._getType() !== 'tool') return undefined;
  return typeof msg.name === 'string' && msg.name.length > 0 ? msg.name : undefined;
}

function nonEmpty(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

const USAGE_OBJECT_KEYS: readonly string[] = [
  'tokenUsage',
  'usage',
  'usageMetadata',
  'usage_metadata',
];
const INPUT_TOKEN_KEYS: readonly string[] = [
  'input_tokens',
  'inputTokens',
  'promptTokens',
  'prompt_tokens',
];
const OUTPUT_TOKEN_KEYS: readonly string[] = [
  'output_tokens',
  'outputTokens',
  'completionTokens',
  'completion_tokens',
];
const CACHE_READ_KEYS: readonly string[] = ['cache_read_input_tokens', 'cacheReadInputTokens'];
const CACHE_CREATION_KEYS: readonly string[] = [
  'cache_creation_input_tokens',
  'cacheCreationInputTokens',
  // Bedrock's spelling.
  'cacheWriteInputTokens',
];

const DATA_SOURCE_ID_KEYS: readonly string[] = [
  'indexName',
  'index_name',
  'index',
  'namespace',
  'collectionName',
  'collection_name',
  'collection',
];

/**
 * `gen_ai.data_source.id` from the wrapped vector store's serialized config
 * (index/collection/namespace). The store may be a live Serializable
 * (`lc_kwargs`/instance fields, camelCase) or pre-serialized (`kwargs`,
 * snake_case), so both are checked. Undefined when no store identity is present.
 */
function dataSourceIdFromRetriever(s: Serialized): string | undefined {
  const kwargs = (s as { kwargs?: Record<string, unknown> }).kwargs ?? {};
  const vs = kwargs.vectorStore ?? kwargs.vector_store ?? kwargs.vectorstore;
  if (!vs || typeof vs !== 'object') return undefined;

  const store = vs as Record<string, unknown>;
  // Live instance first (current field values), then the serialized config /
  // constructor snapshot, so a mutated `indexName` wins over its stale seed.
  for (const src of [store, readObject(store, 'kwargs'), readObject(store, 'lc_kwargs')]) {
    const id = firstStr(src, DATA_SOURCE_ID_KEYS);
    if (id) return id;
  }
  return undefined;
}

/** Reads `obj[key]` as a plain object, guarding against a throwing getter/Proxy. */
function readObject(
  obj: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  let v: unknown;
  try {
    v = obj[key];
  } catch {
    return undefined;
  }
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** Returns `obj[key]` when it is a non-empty string, else `undefined`. Reading
 *  is guarded so a throwing getter/Proxy trap yields `undefined` rather than throwing. */
function strField(obj: Record<string, unknown> | undefined, key: string): string | undefined {
  let v: unknown;
  try {
    v = obj?.[key];
  } catch {
    return undefined;
  }
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** First finite number among `keys` on `obj`, else `undefined`. */
function firstNum(
  obj: Record<string, unknown> | undefined,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const v = numField(obj, key);
    if (v != null) return v;
  }
  return undefined;
}

/** First non-empty string value among `keys` on `obj`, else `undefined`. */
function firstStr(
  obj: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const v = strField(obj, key);
    if (v) return v;
  }
  return undefined;
}

/** `gen_ai.retrieval.top_k` from the retriever's serialized `k` / `searchKwargs.k`. */
function topKFromRetriever(s: Serialized): number | undefined {
  const kwargs = (s as { kwargs?: Record<string, unknown> }).kwargs ?? {};
  const fromKwargs = numField(kwargs, 'k') ?? numField(kwargs, 'topK') ?? numField(kwargs, 'top_k');
  if (fromKwargs != null) return fromKwargs;

  const searchKwargs = kwargs.searchKwargs ?? kwargs.search_kwargs;
  if (searchKwargs && typeof searchKwargs === 'object') {
    return numField(searchKwargs as Record<string, unknown>, 'k');
  }
  return undefined;
}

/** Returns `obj[key]` when it is a finite number, else `undefined`. Reading is
 *  guarded so a throwing getter/Proxy trap yields `undefined` rather than throwing. */
function numField(obj: Record<string, unknown> | undefined, key: string): number | undefined {
  let v: unknown;
  try {
    v = obj?.[key];
  } catch {
    return undefined;
  }
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * Maps LangChain `Document` objects (`{ pageContent, metadata, id? }`) into the
 * genai-otel `RetrievalDocument` shape. Non-object entries are skipped.
 */
function mapRetrieverDocuments(documents: unknown[]): RetrievalDocument[] {
  if (!Array.isArray(documents)) return [];
  const out: RetrievalDocument[] = [];
  for (const raw of documents) {
    if (!raw || typeof raw !== 'object') continue;
    const doc = raw as {
      id?: unknown;
      pageContent?: unknown;
      page_content?: unknown;
      metadata?: unknown;
    };
    const mapped: RetrievalDocument = {};
    if (typeof doc.id === 'string' && doc.id.length > 0) mapped.id = doc.id;
    const content = doc.pageContent ?? doc.page_content;
    if (typeof content === 'string') mapped.content = content;
    if (doc.metadata && typeof doc.metadata === 'object') {
      const meta = doc.metadata as Record<string, unknown>;
      mapped.metadata = meta;
      // Only an explicit relevance score; a raw distance would invert ranking.
      const score = numField(meta, 'score');
      if (score != null) mapped.score = score;
    }
    out.push(mapped);
  }
  return out;
}

function toolCallIdFromOutput(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const id = (output as { tool_call_id?: unknown }).tool_call_id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * Extracts the value a tool returned for `gen_ai.tool.call.result`. A
 * `ToolMessage` (identified only by `_getType() === 'tool'`) is unwrapped to its
 * `content`, flattening an all-text array but preserving any array with non-text
 * blocks; anything else is passed through unchanged.
 */
function toolResultFromOutput(output: unknown): unknown {
  if (!output || typeof output !== 'object') return output;
  const msg = output as { content?: unknown; _getType?: () => string };
  if (typeof msg._getType !== 'function' || msg._getType() !== 'tool') return output;

  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const allText = content.every(
      (b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text',
    );
    return allText ? (lcContentText(content) ?? content) : content;
  }
  return content !== undefined ? content : output;
}

interface MappedUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

/**
 * Extracts token usage from an aggregated `LLMResult`. Non-streaming carries
 * usage on `llmOutput`; streaming leaves `llmOutput.tokenUsage.promptTokens` at
 * 0 and puts the real input count on the generation message's `usage_metadata`.
 * We pick the source that actually reports input tokens (a present-but-zero
 * `llmOutput` count must not shadow the message's real value).
 */
function mapLangChainUsage(output: LLMResult): MappedUsage | undefined {
  const fromLlmOutput = readUsage(usageBag(output.llmOutput));
  const fromMessage = readUsage(usageBag(firstGenerationMessage(output)));
  if (!fromLlmOutput) return fromMessage;
  if (!fromMessage) return fromLlmOutput;
  // Both present: prefer whichever reports more input tokens so a streamed
  // llmOutput's 0 yields to the message's real count. Keep input and output
  // from a single source so they stay consistent.
  return (fromMessage.inputTokens ?? 0) > (fromLlmOutput.inputTokens ?? 0)
    ? mergeCacheCounts(fromMessage, fromLlmOutput)
    : mergeCacheCounts(fromLlmOutput, fromMessage);
}

/** `primary` wins except on cache counts, where its zero would hide a real count
 *  on `secondary`. */
function mergeCacheCounts(primary: MappedUsage, secondary: MappedUsage): MappedUsage {
  return {
    ...primary,
    cacheReadInputTokens: preferPositive(
      primary.cacheReadInputTokens,
      secondary.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: preferPositive(
      primary.cacheCreationInputTokens,
      secondary.cacheCreationInputTokens,
    ),
  };
}

function preferPositive(a: number | undefined, b: number | undefined): number | undefined {
  if (a != null && a > 0) return a;
  if (b != null && b > 0) return b;
  return a ?? b;
}

/** The usage object on a container. `tokenUsage`, `usageMetadata` and
 *  `usage_metadata` are LangChain's own shapes; `usage` is the provider's raw
 *  object, which some integrations copy onto `llmOutput`. */
function usageBag(container: unknown): Record<string, unknown> | undefined {
  if (!container || typeof container !== 'object') return undefined;
  const out = container as Record<string, unknown>;
  for (const key of USAGE_OBJECT_KEYS) {
    const bag = readObject(out, key);
    if (bag) return bag;
  }
  return undefined;
}

/** Normalizes a usage object's varied key casings to token counts. */
function readUsage(u: Record<string, unknown> | undefined): MappedUsage | undefined {
  if (!u) return undefined;
  const inputTokens = firstNum(u, INPUT_TOKEN_KEYS);
  const outputTokens = firstNum(u, OUTPUT_TOKEN_KEYS);

  // Some integrations skip `input_token_details` and copy the provider's flat
  // keys instead, so read the nested shape first and fall back to those.
  const details = readObject(u, 'input_token_details') ?? readObject(u, 'inputTokenDetails');
  const cacheReadInputTokens = numField(details, 'cache_read') ?? firstNum(u, CACHE_READ_KEYS);
  const cacheCreationInputTokens =
    numField(details, 'cache_creation') ?? firstNum(u, CACHE_CREATION_KEYS);

  if (
    inputTokens == null &&
    outputTokens == null &&
    cacheReadInputTokens == null &&
    cacheCreationInputTokens == null
  ) {
    return undefined;
  }
  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
  };
}

/** The message object on an `LLMResult`'s first generation, if present. */
function firstGenerationMessage(output: LLMResult): unknown {
  const gen = output.generations?.[0]?.[0] as { message?: unknown } | undefined;
  return gen?.message;
}

/**
 * Whether the invocation requested streaming. `invocation_params.stream` is
 * populated by LangChain at chat-model start; some integrations expose a bare
 * `stream` flag on `extraParams` instead.
 */
function isStreaming(extraParams?: Record<string, unknown>): boolean {
  const invocation = extraParams?.invocation_params as Record<string, unknown> | undefined;
  return invocation?.stream === true || extraParams?.stream === true;
}

/**
 * Extracts the bound tool list from `extraParams.invocation_params.tools` (where
 * LangChain records the tools passed to `.bindTools(...)` at chat-model start)
 * and normalizes each provider shape into a genai-otel `ToolDefinition`.
 * Returns `undefined` when no tools were bound.
 */
function toolDefinitionsFromExtraParams(
  extraParams?: Record<string, unknown>,
): ToolDefinition[] | undefined {
  const invocation = extraParams?.invocation_params as Record<string, unknown> | undefined;
  const rawTools = invocation?.tools;
  if (!Array.isArray(rawTools) || rawTools.length === 0) return undefined;

  const defs: ToolDefinition[] = [];
  for (const raw of rawTools) {
    const def = normalizeToolDefinition(raw);
    if (def) defs.push(def);
  }
  return defs.length > 0 ? defs : undefined;
}

/**
 * Normalizes one provider-specific tool entry into `{ name, description?,
 * inputSchemaJson? }`. Handles the three shapes LangChain forwards:
 *   - OpenAI:    `{ type: 'function', function: { name, description, parameters } }`
 *   - Anthropic: `{ name, description, input_schema }`
 *   - already-normalized: `{ name, description, parameters }`
 * The JSON schema is stored as a JSON string (`inputSchemaJson`); the content
 * sink parses it back into `parameters` for the semconv shape.
 */
function normalizeToolDefinition(raw: unknown): ToolDefinition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;

  // OpenAI wraps the definition under `function`; other providers are flat.
  const fn =
    r.function && typeof r.function === 'object'
      ? (r.function as Record<string, unknown>)
      : undefined;
  const src = fn ?? r;

  const name = src.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;

  const def: ToolDefinition = { name };

  const description = src.description;
  if (typeof description === 'string' && description.length > 0) def.description = description;

  // `parameters` (OpenAI / normalized) or `input_schema` (Anthropic).
  const schema = src.parameters ?? src.input_schema ?? src.inputSchema ?? src.schema;
  if (schema != null) {
    const encoded = lcJson(schema);
    if (encoded != null) def.inputSchemaJson = encoded;
  }

  // The OTel schema requires `type`. OpenAI carries it at the top level
  // (`type: 'function'`); Anthropic and bare/normalized tools don't, so default
  // to the cross-provider function-tool type.
  def.type = typeof r.type === 'string' && r.type.length > 0 ? r.type : 'function';

  return def;
}

/** Extracts the raw provider stop reason from an `LLMResult`, or `undefined`. */
function extractStopReason(output: LLMResult): string | undefined {
  const first = output.generations?.[0]?.[0] as
    | {
        generationInfo?: { finishReason?: string; finish_reason?: string } | null;
        message?: { response_metadata?: { stop_reason?: unknown; finish_reason?: unknown } | null };
      }
    | undefined;

  const genInfo = first?.generationInfo;
  if (genInfo) {
    const fromGenInfo = genInfo.finishReason ?? genInfo.finish_reason;
    if (typeof fromGenInfo === 'string' && fromGenInfo.length > 0) return fromGenInfo;
  }

  const meta = first?.message?.response_metadata;
  if (meta) {
    const fromMeta = meta.stop_reason ?? meta.finish_reason;
    if (typeof fromMeta === 'string' && fromMeta.length > 0) return fromMeta;
  }

  const llmOut = output.llmOutput as { stop_reason?: unknown; finish_reason?: unknown } | undefined;
  if (llmOut) {
    const fromLlmOut = llmOut.stop_reason ?? llmOut.finish_reason;
    if (typeof fromLlmOut === 'string' && fromLlmOut.length > 0) return fromLlmOut;
  }

  return undefined;
}

function extractResponseId(output: LLMResult): string | undefined {
  const llmOut = output.llmOutput as Record<string, unknown> | undefined;
  if (!llmOut) return undefined;
  if (typeof llmOut.id === 'string') return llmOut.id;
  if (typeof (llmOut as { responseId?: string }).responseId === 'string')
    return (llmOut as { responseId?: string }).responseId;
  return undefined;
}
