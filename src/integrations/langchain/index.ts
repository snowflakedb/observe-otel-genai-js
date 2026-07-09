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
import type { LLMResult } from '@langchain/core/outputs';
import type { ChainValues } from '@langchain/core/utils/types';

import type { Client } from '../../client.js';
import type { ContentCaptureMode } from '../../content/capture.js';
import { type Message, assistantTextMessage } from '../../models/message.js';
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
    _tags?: string[],
    _metadata?: Record<string, unknown>,
    _runName?: string,
  ): Promise<void> {
    const model = modelFromSerialized(llm, extraParams);
    const rec = this.client.startGeneration({
      model,
      agentName: this.defaults.agentName,
      agentVersion: this.defaults.agentVersion,
      conversationId: this.defaults.conversationId,
      conversationTitle: this.defaults.conversationTitle,
      userId: this.defaults.userId,
      systemPrompt: prompts.length > 1 ? prompts[0] : undefined,
      tags: this.defaults.tags,
      metadata: this.defaults.metadata,
    });
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
 * Converts a LangChain chain output into a single assistant message for the
 * `gen_ai.output.messages` attribute. A string `output`/`text` field is used
 * verbatim when present; otherwise the whole value is JSON-encoded. Returns an
 * empty array when there is nothing renderable.
 */
function chainOutputToMessages(output: ChainValues | undefined): Message[] {
  if (output == null) return [];
  let text: string;
  if (typeof output === 'string') {
    text = output;
  } else {
    const candidate =
      (output as Record<string, unknown>).output ?? (output as Record<string, unknown>).text;
    if (typeof candidate === 'string') {
      text = candidate;
    } else {
      try {
        text = JSON.stringify(output);
      } catch {
        return [];
      }
    }
  }
  if (text === '') return [];
  return [assistantTextMessage(text)];
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
