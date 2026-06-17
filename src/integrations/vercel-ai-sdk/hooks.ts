/**
 * Hook-based Vercel AI SDK adapter for genai-otel.
 *
 * Returns bags of AI SDK callback options that drive genai-otel recorders.
 * Designed to be spread directly into `streamText` / `generateText` call params.
 *
 * **Full path** (direct `streamText`/`generateText` calls):
 *   - `experimental_onStepStart`: open recorder with accurate start time + input messages
 *   - `onChunk`: TTFT on first text-delta
 *   - `experimental_onToolCallStart/Finish`: discrete `execute_tool` spans with timing
 *   - `onStepFinish`: set output/usage/stopReason, close recorder
 *   - `onError`: close all open recorders with error status
 *
 * **Fallback path** (`ToolLoopAgent`, which only exposes `onStepFinish`):
 *   - `onStepFinish`: open+close generation recorder with synthetic step-boundary
 *     timing, then emit `execute_tool` spans from `step.toolCalls` + `step.content`
 *   - TTFT is not available; per-tool duration is not available
 */

import type { Client } from '../../client.js';
import {
  type Message,
  type Part,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultPart,
} from '../../models/message.js';
import { OP_CHAT } from '../../semconv.js';
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

interface AiStepStartEvent {
  stepNumber: number;
  model: AiCallbackModel;
  messages: AiModelMessage[];
  system?: unknown;
}

interface AiToolCall {
  toolName: string;
  toolCallId: string;
  input: unknown;
}

interface AiToolCallStartEvent {
  toolCall: AiToolCall;
  stepNumber?: number;
  model?: AiCallbackModel;
}

interface AiToolCallFinishEvent {
  toolCall: AiToolCall;
  durationMs: number;
  success: boolean;
  output?: unknown;
  error?: unknown;
  stepNumber?: number;
  model?: AiCallbackModel;
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
  experimental_onStepStart?: (event: AiStepStartEvent) => Promise<void> | void;
  onChunk?: (event: AiChunkEvent) => Promise<void> | void;
  experimental_onToolCallStart?: (event: AiToolCallStartEvent) => Promise<void> | void;
  experimental_onToolCallFinish?: (event: AiToolCallFinishEvent) => Promise<void> | void;
  onStepFinish: (event: AiStepFinishEvent) => Promise<void> | void;
  onError?: (event: AiErrorEvent) => Promise<void> | void;
}

/** Callback bag returned by {@link generateTextHooks} — spread into `generateText` params. */
export type GenerateTextHooks = Omit<StreamTextHooks, 'onChunk' | 'onError'>;

// ---------------------------------------------------------------------------
// Internal per-call state
// ---------------------------------------------------------------------------

type GenerationRec = ReturnType<Client['startStreamingGeneration']>;
type ToolRec = ReturnType<Client['startToolExecution']>;

interface StepState {
  rec: GenerationRec;
  startedAtMs: number;
  firstTokenSeen: boolean;
  /** Tool call IDs already handled by `experimental_onToolCallFinish`. */
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
   * already handled by `experimental_onToolCallFinish`. Uses synthetic timing
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
      // Reuse a recorder opened by `experimental_onToolCallStart` whose matching
      // `onToolCallFinish` never fired (otherwise it would leak, and a second
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

  return {
    experimental_onStepStart(event: AiStepStartEvent): void {
      const startedAtMs = client.now();
      const inputMessages = mapModelMessages(event.messages);
      const systemPrompt = typeof event.system === 'string' ? event.system : undefined;
      openStepRec(event.stepNumber, event.model, startedAtMs, inputMessages, systemPrompt);
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

    experimental_onToolCallStart(event: AiToolCallStartEvent): void {
      const toolRec = client.startToolExecution({
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        requestModel: event.model?.modelId,
        requestProvider: event.model?.provider,
        agentName: options.agentName,
        agentVersion: options.agentVersion,
        conversationId: options.conversationId,
      });
      toolRec.setResult({ arguments: event.toolCall.input });
      toolRecorders.set(event.toolCall.toolCallId, toolRec);
    },

    async experimental_onToolCallFinish(event: AiToolCallFinishEvent): Promise<void> {
      const toolRec = toolRecorders.get(event.toolCall.toolCallId);
      if (!toolRec) return;
      toolRecorders.delete(event.toolCall.toolCallId);

      // Mark as handled so the onStepFinish fallback doesn't double-record
      const targetStep = event.stepNumber;
      if (targetStep !== undefined) {
        stepStates.get(targetStep)?.closedToolCallIds.add(event.toolCall.toolCallId);
      } else {
        for (const [, state] of stepStates) {
          state.closedToolCallIds.add(event.toolCall.toolCallId);
        }
      }

      if (event.success) {
        toolRec.setResult({ result: event.output });
      } else {
        toolRec.setExecError(event.error);
      }
      try {
        await toolRec.end();
      } catch {
        /* ignore */
      }
    },

    async onStepFinish(event: AiStepFinishEvent): Promise<void> {
      let state = stepStates.get(event.stepNumber);
      if (!state) {
        // experimental_onStepStart did not fire — open recorder with synthetic
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
}

/**
 * Returns a fresh stateful hooks object for one `generateText` invocation.
 *
 * Equivalent to {@link streamTextHooks} minus `onChunk` and `onError`, which
 * are stream-only in AI SDK v6.
 */
export function generateTextHooks(
  client: Client,
  options: VercelAdapterOptions = {},
): GenerateTextHooks {
  const { onChunk: _onChunk, onError: _onError, ...rest } = streamTextHooks(client, options);
  return rest;
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
