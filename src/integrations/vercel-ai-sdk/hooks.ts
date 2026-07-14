/**
 * Hook-based Vercel AI SDK adapter for genai-otel.
 *
 * Returns bags of AI SDK callback options that drive genai-otel recorders.
 * Designed to be spread directly into `streamText` / `generateText` call params.
 *
 * **Full path** (direct `streamText`/`generateText` calls):
 *   - `onStepStart`: open recorder with accurate start time + input messages
 *   - `onChunk`: TTFT on first text-delta
 *   - `onToolExecutionStart/End`: discrete `execute_tool` spans with timing
 *   - `onStepEnd`: set output/usage/stopReason, close recorder
 *   - `onError`: close all open recorders with error status
 *
 * **Fallback path** (`onStepEnd` fires without a preceding `onStepStart`):
 *   - `onStepEnd`: open+close generation recorder with synthetic step-boundary
 *     timing, then emit `execute_tool` spans from `step.toolCalls` + `step.content`
 *   - TTFT is not available; per-tool duration is not available
 *
 * Targets AI SDK v7 (`ai ^7.0.0`). In v7 these callbacks are first-class on
 * `streamText`, `generateText`, AND `ToolLoopAgent` — so `onStepStart` now fires
 * for agents too (in v6 agents ignored `experimental_onStepStart`, which dropped
 * `gen_ai.input.messages` on agent spans). The fallback path is retained as a
 * defensive measure but is rarely exercised on v7.
 */

import type { ModelMessage } from 'ai';
import type { Client } from '../../client.js';
import {
  type Message,
  type Part,
  assistantTextMessage,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import { OP_CHAT, OP_GENERATE_CONTENT } from '../../semconv.js';
import { type VercelAdapterOptions, identityFields, mapAiUsage, modelRefFromAi } from './_model.js';

// ---------------------------------------------------------------------------
// Duck-typed AI SDK event shapes — we only read what we need
// ---------------------------------------------------------------------------

interface AiCallbackModel {
  provider: string;
  modelId: string;
}

interface AiContentPart {
  type: string;
  text?: string;
  toolCallId?: string;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  error?: unknown;
}

interface AiModelMessage {
  role: string;
  content: string | AiContentPart[];
}

/**
 * `onStepStart` event (AI SDK v7). Model info is flat (`provider`/`modelId`),
 * and the system prompt arrives as `instructions` (may be a string or
 * structured `SystemModelMessage`).
 */
interface AiStepStartEvent {
  stepNumber: number;
  provider: string;
  modelId: string;
  messages: AiModelMessage[];
  instructions?: unknown;
}

interface AiToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

/**
 * `onToolExecutionStart` event (AI SDK v7). Carries the tool call and the
 * messages that led to it; unlike v6 it does not expose `model` or `stepNumber`.
 */
interface AiToolExecutionStartEvent {
  toolCall: AiToolCall;
}

/**
 * `onToolExecutionEnd` event (AI SDK v7). Success/error is discriminated via
 * `toolOutput.type` (`'tool-result'` vs `'tool-error'`); duration is
 * `toolExecutionMs`.
 */
interface AiToolExecutionEndEvent {
  toolCall: AiToolCall;
  toolExecutionMs?: number;
  toolOutput?: { type: 'tool-result'; output?: unknown } | { type: 'tool-error'; error?: unknown };
}

interface AiToolResult {
  toolCallId: string;
  toolName: string;
  output?: unknown;
}

interface AiStepFinishEvent {
  stepNumber: number;
  model: AiCallbackModel;
  content: AiContentPart[];
  text: string;
  toolCalls: AiToolCall[];
  toolResults: AiToolResult[];
  finishReason: string;
  usage: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
    reasoningTokens?: number;
    promptTokens?: number; // v5 compat
    completionTokens?: number; // v5 compat
  };
  response: {
    id?: string;
    modelId?: string;
  };
}

interface AiChunkEvent {
  chunk: { type: string; text?: string };
}

interface AiErrorEvent {
  error: unknown;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Callback bag returned by {@link streamTextHooks} — spread into `streamText` params. */
export interface StreamTextHooks {
  onStepStart?: (event: AiStepStartEvent) => Promise<void> | void;
  onChunk?: (event: AiChunkEvent) => Promise<void> | void;
  onToolExecutionStart?: (event: AiToolExecutionStartEvent) => Promise<void> | void;
  onToolExecutionEnd?: (event: AiToolExecutionEndEvent) => Promise<void> | void;
  onStepEnd: (event: AiStepFinishEvent) => Promise<void> | void;
  onError?: (event: AiErrorEvent) => Promise<void> | void;
}

/** Callback bag returned by {@link generateTextHooks} — spread into `generateText` params. */
export type GenerateTextHooks = Omit<StreamTextHooks, 'onChunk' | 'onError'>;

/**
 * Composes a telemetry handler with a caller's handler for the same callback.
 * The telemetry handler runs first and defensively — a throw from it is
 * swallowed so instrumentation can never break the caller's own handler — then
 * the caller's handler runs and its errors propagate (it's their app logic).
 * If only one side is present it passes through unchanged.
 */
function composeHandlers<E>(
  telemetry: ((event: E) => Promise<void> | void) | undefined,
  caller: ((event: E) => Promise<void> | void) | undefined,
): ((event: E) => Promise<void> | void) | undefined {
  if (!telemetry) return caller;
  if (!caller) return telemetry;
  return async (event: E) => {
    try {
      await telemetry(event);
    } catch {
      /* telemetry must not break the caller's handler */
    }
    await caller(event);
  };
}

/**
 * Composes two hook bags into one that is safe to spread into `streamText` /
 * `generateText` params. For every callback, the telemetry (`sdk`) handler runs
 * first (defensively — see {@link composeHandlers}), then the `caller`'s
 * handler. Handlers present in only one bag pass through unchanged.
 */
export function mergeHooks(
  sdk: StreamTextHooks,
  caller: Partial<StreamTextHooks>,
): StreamTextHooks {
  return {
    onStepStart: composeHandlers(sdk.onStepStart, caller.onStepStart),
    onChunk: composeHandlers(sdk.onChunk, caller.onChunk),
    onToolExecutionStart: composeHandlers(sdk.onToolExecutionStart, caller.onToolExecutionStart),
    onToolExecutionEnd: composeHandlers(sdk.onToolExecutionEnd, caller.onToolExecutionEnd),
    // `onStepEnd` is required on the bag; `sdk.onStepEnd` is always present, so
    // the composition is never undefined (the cast just re-states that).
    onStepEnd: composeHandlers(sdk.onStepEnd, caller.onStepEnd) as StreamTextHooks['onStepEnd'],
    onError: composeHandlers(sdk.onError, caller.onError),
  };
}

// ---------------------------------------------------------------------------
// Internal per-call state
// ---------------------------------------------------------------------------

type GenerationRec = ReturnType<Client['startStreamingGeneration']>;
type ToolRec = ReturnType<Client['startToolExecution']>;

interface StepState {
  rec: GenerationRec;
  startedAtMs: number;
  firstTokenSeen: boolean;
  /** Tool call IDs already handled by `onToolExecutionEnd`. */
  closedToolCallIds: Set<string>;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Returns a fresh stateful hooks object for one `streamText` invocation.
 *
 * Each call to `streamTextHooks` produces an independent instance — do not
 * reuse the returned object across multiple `streamText` calls.
 */
export function streamTextHooks(
  client: Client,
  options: VercelAdapterOptions = {},
  callerHooks?: Partial<StreamTextHooks>,
): StreamTextHooks {
  const callStartedAt = client.now();
  const stepStates = new Map<number, StepState>();
  const toolRecorders = new Map<string, ToolRec>();
  /** Tracks when the previous step finished, for synthetic step timing in fallback path. */
  let prevStepEndedAt = callStartedAt;

  // --- internal helpers ---

  function openStepRec(
    stepNumber: number,
    model: AiCallbackModel,
    startedAtMs: number,
    inputMessages: Message[] = [],
    systemPrompt?: string,
  ): StepState {
    const rec = client.startStreamingGeneration({
      model: modelRefFromAi(model),
      operationName: OP_CHAT,
      ...identityFields(options),
      startedAt: startedAtMs,
      systemPrompt,
      tags: options.tags,
      metadata: options.metadata,
      parentGenerationIds: options.parentGenerationIds,
    });
    if (inputMessages.length > 0) {
      rec.setResult({ input: inputMessages });
    }
    const state: StepState = {
      rec,
      startedAtMs,
      firstTokenSeen: false,
      closedToolCallIds: new Set(),
    };
    stepStates.set(stepNumber, state);
    return state;
  }

  async function closeStepRec(state: StepState, event: AiStepFinishEvent): Promise<void> {
    state.rec.setResult({
      output: mapStepContent(event.content),
      usage: mapAiUsage(event.usage),
      stopReason: event.finishReason,
      responseId: event.response?.id,
      responseModel: event.response?.modelId,
    });
    try {
      await state.rec.end();
    } catch {
      /* ignore recorder flush errors */
    }
  }

  /**
   * Emits execute_tool spans for any tool calls in the step that were not
   * already handled by `onToolExecutionEnd`. Uses synthetic timing
   * (step start as tool start — no per-tool duration available in this path).
   */
  async function recordToolsFromStep(state: StepState, event: AiStepFinishEvent): Promise<void> {
    // Collect tool errors from the content array (tool-error entries)
    const toolErrors = new Map<string, unknown>();
    for (const part of event.content) {
      if (part.type === 'tool-error' && part.toolCallId) {
        toolErrors.set(part.toolCallId, part.error);
      }
    }
    // Collect successful results from toolResults
    const toolResultMap = new Map<string, unknown>();
    for (const tr of event.toolResults) {
      toolResultMap.set(tr.toolCallId, tr.output);
    }
    // Emit one tool span per unhandled tool call
    for (const tc of event.toolCalls) {
      if (state.closedToolCallIds.has(tc.toolCallId)) continue;
      const isError = toolErrors.has(tc.toolCallId);
      // Reuse a recorder opened by `onToolExecutionStart` whose matching
      // `onToolExecutionEnd` never fired (otherwise it would leak, and a second
      // synthetic recorder would double-record the same tool call). Fall back to
      // a synthetic recorder anchored at the step boundary when none is open.
      let toolRec = toolRecorders.get(tc.toolCallId);
      if (toolRec) {
        toolRecorders.delete(tc.toolCallId);
      } else {
        toolRec = client.startToolExecution({
          toolName: tc.toolName,
          toolCallId: tc.toolCallId,
          requestModel: event.model?.modelId,
          requestProvider: event.model?.provider,
          agentName: options.agentName,
          agentVersion: options.agentVersion,
          conversationId: options.conversationId,
          startedAt: state.startedAtMs,
        });
        toolRec.setResult({ arguments: tc.input });
      }
      if (isError) {
        toolRec.setExecError(toolErrors.get(tc.toolCallId));
      } else if (toolResultMap.has(tc.toolCallId)) {
        toolRec.setResult({ result: toolResultMap.get(tc.toolCallId) });
      }
      state.closedToolCallIds.add(tc.toolCallId);
      try {
        await toolRec.end();
      } catch {
        /* ignore */
      }
    }
  }

  async function closeAllWithError(error: unknown): Promise<void> {
    for (const [, state] of stepStates) {
      state.rec.setCallError(error);
      try {
        await state.rec.end();
      } catch {
        /* ignore */
      }
    }
    stepStates.clear();
    for (const [, toolRec] of toolRecorders) {
      toolRec.setExecError(error);
      try {
        await toolRec.end();
      } catch {
        /* ignore */
      }
    }
    toolRecorders.clear();
  }

  // --- returned callbacks ---

  const bag: StreamTextHooks = {
    onStepStart(event: AiStepStartEvent): void {
      const startedAtMs = client.now();
      const inputMessages = mapModelMessages(event.messages);
      const systemPrompt = typeof event.instructions === 'string' ? event.instructions : undefined;
      const model: AiCallbackModel = { provider: event.provider, modelId: event.modelId };
      openStepRec(event.stepNumber, model, startedAtMs, inputMessages, systemPrompt);
    },

    onChunk(event: AiChunkEvent): void {
      if (event.chunk.type !== 'text-delta') return;
      // Apply TTFT to the latest open step recorder
      let latestState: StepState | undefined;
      for (const [, state] of stepStates) {
        if (!latestState || state.startedAtMs >= latestState.startedAtMs) {
          latestState = state;
        }
      }
      if (latestState && !latestState.firstTokenSeen) {
        latestState.firstTokenSeen = true;
        latestState.rec.setFirstTokenAt(client.now());
      }
    },

    onToolExecutionStart(event: AiToolExecutionStartEvent): void {
      // v7 `onToolExecutionStart` does not carry model info; requestModel /
      // requestProvider are backfilled from the step-finish event if needed.
      const toolRec = client.startToolExecution({
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        agentName: options.agentName,
        agentVersion: options.agentVersion,
        conversationId: options.conversationId,
      });
      toolRec.setResult({ arguments: event.toolCall.input });
      toolRecorders.set(event.toolCall.toolCallId, toolRec);
    },

    async onToolExecutionEnd(event: AiToolExecutionEndEvent): Promise<void> {
      const toolRec = toolRecorders.get(event.toolCall.toolCallId);
      if (!toolRec) return;
      toolRecorders.delete(event.toolCall.toolCallId);

      // v7 tool events carry no stepNumber — mark handled across all open steps
      // so the onStepEnd fallback doesn't double-record.
      for (const [, state] of stepStates) {
        state.closedToolCallIds.add(event.toolCall.toolCallId);
      }

      // Success/error is discriminated via toolOutput.type.
      const out = event.toolOutput;
      if (out && out.type === 'tool-error') {
        toolRec.setExecError(out.error);
      } else if (out && out.type === 'tool-result') {
        toolRec.setResult({ result: out.output });
      }
      try {
        await toolRec.end();
      } catch {
        /* ignore */
      }
    },

    async onStepEnd(event: AiStepFinishEvent): Promise<void> {
      let state = stepStates.get(event.stepNumber);
      if (!state) {
        // onStepStart did not fire — open recorder with synthetic
        // step-boundary timing (timestamp of when the previous step ended).
        state = openStepRec(event.stepNumber, event.model, prevStepEndedAt);
      }
      stepStates.delete(event.stepNumber);

      await closeStepRec(state, event);
      await recordToolsFromStep(state, event);

      prevStepEndedAt = client.now();
    },

    async onError(event: AiErrorEvent): Promise<void> {
      await closeAllWithError(event.error);
    },
  };

  return callerHooks ? mergeHooks(bag, callerHooks) : bag;
}

/**
 * Returns a fresh stateful hooks object for one `generateText` invocation.
 *
 * Equivalent to {@link streamTextHooks} minus `onChunk` and `onError`, which
 * are stream-only in AI SDK v7.
 */
export function generateTextHooks(
  client: Client,
  options: VercelAdapterOptions = {},
  callerHooks?: Partial<GenerateTextHooks>,
): GenerateTextHooks {
  const {
    onChunk: _onChunk,
    onError: _onError,
    ...rest
  } = streamTextHooks(client, options, callerHooks);
  return rest;
}

// ---------------------------------------------------------------------------
// generateObject hooks
// ---------------------------------------------------------------------------

/** Provider-format message (AI SDK `LanguageModelV4Message`). */
interface AiProviderMessage {
  role: string;
  content: string | AiProviderPart[];
}

interface AiProviderPart {
  type: string;
  text?: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
}

/**
 * `onStepStart` event for `generateObject` (AI SDK v7). Model info is flat;
 * input arrives as `promptMessages` in provider format (`LanguageModelV4Prompt`),
 * distinct from the `messages` shape used by streamText/generateText.
 */
interface AiObjectStepStartEvent {
  stepNumber?: number;
  provider: string;
  modelId: string;
  promptMessages?: AiProviderMessage[];
}

/** `onStepEnd` event for `generateObject` (AI SDK v7). */
interface AiObjectStepEndEvent {
  provider?: string;
  modelId?: string;
  objectText?: string;
  finishReason?: string;
  usage?: unknown;
  response?: { id?: string; modelId?: string };
}

/** Callback bag returned by {@link generateObjectHooks} — spread into `generateObject` params. */
export interface GenerateObjectHooks {
  onStepStart?: (event: AiObjectStepStartEvent) => Promise<void> | void;
  onStepEnd?: (event: AiObjectStepEndEvent) => Promise<void> | void;
}

/**
 * Returns a fresh stateful hooks object for one `generateObject` invocation.
 *
 * `generateObject` is single-step (`stepNumber` always 0) with no tool calls or
 * streaming, so this is simpler than {@link streamTextHooks}: one recorder,
 * opened in `onStepStart` (capturing input from `promptMessages`) and closed in
 * `onStepEnd` (output text, usage, stop reason).
 *
 * Each call produces an independent instance; do not reuse across calls.
 */
export function generateObjectHooks(
  client: Client,
  options: VercelAdapterOptions = {},
): GenerateObjectHooks {
  let rec: GenerationRec | undefined;

  return {
    onStepStart(event: AiObjectStepStartEvent): void {
      const { messages, systemPrompt } = mapProviderPrompt(event.promptMessages ?? []);
      rec = client.startStreamingGeneration({
        model: modelRefFromAi({ provider: event.provider, modelId: event.modelId }),
        operationName: OP_GENERATE_CONTENT,
        ...identityFields(options),
        startedAt: client.now(),
        systemPrompt,
        tags: options.tags,
        metadata: options.metadata,
        parentGenerationIds: options.parentGenerationIds,
      });
      if (messages.length > 0) rec.setResult({ input: messages });
    },

    async onStepEnd(event: AiObjectStepEndEvent): Promise<void> {
      if (!rec) return;
      const output =
        typeof event.objectText === 'string' && event.objectText.length > 0
          ? [assistantTextMessage(event.objectText)]
          : undefined;
      rec.setResult({
        output,
        usage: mapAiUsage(event.usage),
        stopReason: event.finishReason,
        responseId: event.response?.id,
        responseModel: event.response?.modelId,
      });
      try {
        await rec.end();
      } catch {
        /* ignore recorder flush errors */
      }
      rec = undefined;
    },
  };
}

/**
 * Converts an AI SDK provider-format prompt (`LanguageModelV4Prompt`, used by
 * generateObject step events) to genai-otel `Message[]` + `systemPrompt`.
 * The `system` role carries a plain string (returned separately so it rides on
 * the seed's `systemPrompt`); other roles carry provider part arrays.
 */
function mapProviderPrompt(prompt: AiProviderMessage[]): {
  messages: Message[];
  systemPrompt?: string;
} {
  const messages: Message[] = [];
  const systemChunks: string[] = [];
  for (const msg of prompt) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') systemChunks.push(msg.content);
      continue;
    }
    const role = normalizeRole(msg.role);
    if (typeof msg.content === 'string') {
      messages.push({ role, parts: [textPart(msg.content)] });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const parts = mapProviderParts(msg.content);
    if (parts.length > 0) messages.push({ role, parts });
  }
  return {
    messages,
    systemPrompt: systemChunks.length > 0 ? systemChunks.join('\n\n') : undefined,
  };
}

/** Converts provider-format content parts to genai-otel `Part[]`. */
function mapProviderParts(content: AiProviderPart[]): Part[] {
  const parts: Part[] = [];
  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') parts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') parts.push(thinkingPart(c.text));
        break;
      case 'tool-call':
        parts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        parts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.output),
          }),
        );
        break;
    }
  }
  return parts;
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

/**
 * Converts AI SDK `ModelMessage[]` (step input) to genai-otel `Message[]`.
 * System messages are skipped — they ride on the generation seed's `systemPrompt`.
 */
function mapModelMessages(messages: AiModelMessage[]): Message[] {
  const result: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = normalizeRole(msg.role);
    if (typeof msg.content === 'string') {
      result.push({ role, parts: [textPart(msg.content)] });
      continue;
    }
    if (!Array.isArray(msg.content)) continue;
    const parts = mapContentParts(msg.content);
    if (parts.length > 0) result.push({ role, parts });
  }
  return result;
}

/**
 * Maps AI SDK `ModelMessage[]` (the `streamText` / `generateText` input shape)
 * to genai-otel `Message[]`, suitable for `AgentInvocationStart.input` /
 * `gen_ai.input.messages` on an `invoke_agent` span. System messages are
 * skipped — they belong on the agent/generation `systemPrompt`, not
 * `input.messages`, per the GenAI semantic conventions.
 */
export function toAgentInputMessages(messages: ModelMessage[]): Message[] {
  return mapModelMessages(messages as unknown as AiModelMessage[]);
}

/**
 * Converts `AiContentPart[]` (from a message's content array) to genai-otel `Part[]`.
 */
function mapContentParts(content: AiContentPart[]): Part[] {
  const parts: Part[] = [];
  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') parts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') parts.push(thinkingPart(c.text));
        break;
      case 'tool-call':
        parts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        parts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.output),
          }),
        );
        break;
    }
  }
  return parts;
}

/**
 * Converts `StepResult.content[]` to genai-otel output `Message[]`.
 * Assembles assistant parts (text + reasoning + tool-calls) and tool-role parts
 * (results + errors).
 */
function mapStepContent(content: AiContentPart[]): Message[] {
  const assistantParts: Part[] = [];
  const toolParts: Part[] = [];

  for (const c of content) {
    switch (c.type) {
      case 'text':
        if (typeof c.text === 'string') assistantParts.push(textPart(c.text));
        break;
      case 'reasoning':
        if (typeof c.text === 'string') assistantParts.push(thinkingPart(c.text));
        break;
      case 'tool-call':
        assistantParts.push(
          toolCallPart({
            name: c.toolName ?? '',
            id: c.toolCallId,
            inputJson: jsonString(c.input),
          }),
        );
        break;
      case 'tool-result':
        toolParts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.output),
          }),
        );
        break;
      case 'tool-error':
        toolParts.push(
          toolResultPart({
            toolCallId: c.toolCallId,
            name: c.toolName,
            contentJson: jsonString(c.error),
            isError: true,
          }),
        );
        break;
    }
  }

  const messages: Message[] = [];
  if (assistantParts.length > 0) messages.push({ role: 'assistant', parts: assistantParts });
  if (toolParts.length > 0) messages.push({ role: 'tool', parts: toolParts });
  return messages;
}

function normalizeRole(role: string): Message['role'] {
  if (role === 'user' || role === 'assistant' || role === 'tool' || role === 'system') return role;
  return 'user';
}

function jsonString(value: unknown): string | undefined {
  if (value == null) return undefined;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}
