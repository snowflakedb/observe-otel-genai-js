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
import {
  type Message,
  type Part,
  assistantTextMessage,
  textPart,
  toolCallPart,
  toolResultPart,
  userTextMessage,
} from '../../models/message.js';
import type { AgentInvocationRecorder } from '../../recorders/agent.js';
import type { GenerationRecorder } from '../../recorders/generation.js';
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

  constructor(options: GenAIOtelCallbackHandlerOptions) {
    super();
    this.client = options.client;
    const { client: _c, captureChains, captureNestedChains, ...rest } = options;
    this.defaults = rest;
    this.captureChains = captureChains !== false;
    this.captureNestedChains = captureNestedChains === true;
  }

  // ---------------------------------------------------------------------------
  // LLM lifecycle
  // ---------------------------------------------------------------------------

  override async handleLLMStart(
    llm: Serialized,
    prompts: string[],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): Promise<void> {
    // Raw string-completion path (also the fallback LangChain uses for chat
    // models when a handler has no `handleChatModelStart`). Each prompt becomes
    // a user message.
    const input = prompts
      .filter((p): p is string => typeof p === 'string' && p.length > 0)
      .map((p) => userTextMessage(p));
    this.openGeneration(modelFromSerialized(llm, extraParams), input, runId);
  }

  override async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
    _parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): Promise<void> {
    // Chat-model path: structured messages with real roles. System messages are
    // part of the provided chat history, so they map to input.messages (role
    // `system`) rather than to gen_ai.system_instructions.
    const input = mapBaseMessages(messages[0] ?? []);
    this.openGeneration(modelFromSerialized(llm, extraParams), input, runId);
  }

  private openGeneration(model: ModelHint, input: Message[], runId: string): void {
    const rec = this.client.startGeneration({
      model,
      agentName: this.defaults.agentName,
      agentVersion: this.defaults.agentVersion,
      conversationId: this.defaults.conversationId,
      conversationTitle: this.defaults.conversationTitle,
      userId: this.defaults.userId,
      turnIndex: this.defaults.turnIndex,
      turnRole: this.defaults.turnRole,
      contentCapture: this.defaults.contentCapture,
      tags: this.defaults.tags,
      metadata: this.defaults.metadata,
    });
    if (input.length > 0) rec.setResult({ input });
    this.llmRunMap.set(runId, { rec, firstTokenSeen: false });
  }

  override async handleLLMNewToken(token: string, _idx: unknown, runId: string): Promise<void> {
    const entry = this.llmRunMap.get(runId);
    if (!entry || entry.firstTokenSeen) return;
    if (token.length === 0) return;
    entry.firstTokenSeen = true;
    entry.rec.setFirstTokenAt(Date.now());
  }

  override async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const entry = this.llmRunMap.get(runId);
    if (!entry) return;
    this.llmRunMap.delete(runId);
    entry.rec.setResult({
      usage: mapLangChainUsage(output.llmOutput),
      stopReason: extractStopReason(output),
      responseId: extractResponseId(output),
      output: mapLangChainOutput(output),
    });
    await safeEnd(entry.rec);
  }

  override async handleLLMError(err: unknown, runId: string): Promise<void> {
    const entry = this.llmRunMap.get(runId);
    if (!entry) return;
    this.llmRunMap.delete(runId);
    entry.rec.setCallError(err);
    await safeEnd(entry.rec);
  }

  // ---------------------------------------------------------------------------
  // Tool lifecycle
  // ---------------------------------------------------------------------------

  override async handleToolStart(tool: Serialized, input: string, runId: string): Promise<void> {
    const rec = this.client.startToolExecution({
      toolName: toolNameFromSerialized(tool),
      agentName: this.defaults.agentName,
      agentVersion: this.defaults.agentVersion,
      conversationId: this.defaults.conversationId,
      contentCapture: this.defaults.contentCapture,
    });
    rec.setResult({ arguments: input });
    this.toolRunMap.set(runId, rec);
  }

  override async handleToolEnd(output: unknown, runId: string): Promise<void> {
    const rec = this.toolRunMap.get(runId);
    if (!rec) return;
    this.toolRunMap.delete(runId);
    rec.setResult({ result: output });
    await safeEnd(rec);
  }

  override async handleToolError(err: unknown, runId: string): Promise<void> {
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
    _inputs: ChainValues,
    runId: string,
    parentRunId?: string,
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runType?: string,
    runName?: string,
  ): Promise<void> {
    // Top-level chains always become invoke_agent spans. Nested chains only
    // become spans when `captureNestedChains` is true (off by default to keep
    // traces focused on the outermost agent boundary).
    if (!this.captureChains) return;
    if (parentRunId && !this.captureNestedChains) return;

    const rec = this.client.invokeAgent({
      agentName:
        this.defaults.agentName ?? runName ?? toolNameFromSerialized(chain) ?? 'langchain-chain',
      agentVersion: this.defaults.agentVersion,
      conversationId: this.defaults.conversationId,
      userId: this.defaults.userId,
      tags: this.defaults.tags,
      metadata: this.defaults.metadata,
    });
    this.chainRunMap.set(runId, rec);
  }

  override async handleChainEnd(output: ChainValues, runId: string): Promise<void> {
    const rec = this.chainRunMap.get(runId);
    if (!rec) return;
    this.chainRunMap.delete(runId);
    rec.setOutput(chainOutputToMessages(output));
    await safeEnd(rec);
  }

  override async handleChainError(err: unknown, runId: string): Promise<void> {
    const rec = this.chainRunMap.get(runId);
    if (!rec) return;
    this.chainRunMap.delete(runId);
    rec.setError(err);
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

function mapLangChainUsage(llmOutput: unknown) {
  if (!llmOutput || typeof llmOutput !== 'object') return undefined;
  const out = llmOutput as Record<string, unknown>;
  // LangChain models commonly stash usage at `tokenUsage` or `usage` or `usage_metadata`.
  const u =
    (out.tokenUsage as Record<string, number> | undefined) ??
    (out.usage as Record<string, number> | undefined) ??
    (out.usageMetadata as Record<string, number> | undefined) ??
    (out.usage_metadata as Record<string, number> | undefined);
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens ?? u.inputTokens ?? u.promptTokens ?? u.prompt_tokens,
    outputTokens: u.output_tokens ?? u.outputTokens ?? u.completionTokens ?? u.completion_tokens,
    totalTokens: u.total_tokens ?? u.totalTokens,
  };
}

function extractStopReason(output: LLMResult): string | undefined {
  const gens = output.generations?.[0];
  if (!gens || gens.length === 0) return undefined;
  const first = gens[0] as { generationInfo?: { finishReason?: string; finish_reason?: string } };
  return first.generationInfo?.finishReason ?? first.generationInfo?.finish_reason;
}

function extractResponseId(output: LLMResult): string | undefined {
  const llmOut = output.llmOutput as Record<string, unknown> | undefined;
  if (!llmOut) return undefined;
  if (typeof llmOut.id === 'string') return llmOut.id;
  if (typeof (llmOut as { responseId?: string }).responseId === 'string')
    return (llmOut as { responseId?: string }).responseId;
  return undefined;
}
