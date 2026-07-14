/**
 * `agentTurn` — a streaming-aware `invoke_agent` lifecycle handle for the
 * Vercel AI SDK adapter.
 *
 * For a **streaming** agent the turn's work completes asynchronously *after*
 * `stream()` returns, so the callback form of `client.invokeAgent(seed, fn)`
 * would end the span too early. The documented manual pattern is: open the
 * fluent recorder, `withActiveContext(fn)` to parent the stream's spans, wire
 * the step hooks, then call `recorder.end()` from the stream's onFinish/onError.
 *
 * `agentTurn` bundles those pre-existing primitives into one handle:
 *   - `recorder`  — the underlying `AgentInvocationRecorder` (escape hatch).
 *   - `hooks`     — a spread-safe `streamTextHooks` bag (caller callbacks folded
 *                   in via the third arg).
 *   - `run(fn)`   — installs the span as the active parent for `fn` (does NOT
 *                   end it).
 *   - `end(opts)` — idempotent closer: records output/error, then ends the span.
 *   - `[Symbol.asyncDispose]` — ends the turn on scope exit for `await using`.
 *
 * It adds no new emission logic — everything composes `Client.invokeAgent`,
 * `RecorderBase.withActiveContext` / `.end()`, and the 0.2.1 hook + mapper
 * helpers. Lives in the adapter (not `Client`) because `input` accepts the AI
 * SDK `ModelMessage[]` shape, which `Client` must stay agnostic of.
 */

import type { ModelMessage } from 'ai';
import type { Client } from '../../client.js';
import type { AgentInvocationStart } from '../../models/agent.js';
import { type Message, assistantTextMessage } from '../../models/message.js';
import type { AgentInvocationRecorder } from '../../recorders/agent.js';
import type { VercelAdapterOptions } from './_model.js';
import { type StreamTextHooks, streamTextHooks, toAgentInputMessages } from './hooks.js';

/** Handle returned by {@link agentTurn}. See the module docstring for the model. */
export interface AgentTurn {
  /** The underlying recorder, for advanced callers who need setTags/setOutput mid-turn. */
  readonly recorder: AgentInvocationRecorder;
  /** Spread-safe hook bag for `streamText` / `generateText` / `ToolLoopAgent.stream`. */
  readonly hooks: StreamTextHooks;
  /**
   * Runs `fn` with the `invoke_agent` span installed as the active OTel span so
   * the synchronous stream call inside parents its per-step spans under it.
   * Does NOT end the span — call {@link AgentTurn.end} for that.
   */
  run<T>(fn: () => T): T;
  /**
   * Idempotent closer (first call wins). Records the final output and/or error,
   * then ends the span. Safe to call from any exit path and to double-call
   * across e.g. onFinish + a finally. `error` takes precedence over `output`;
   * a string `output` is wrapped via `assistantTextMessage`.
   */
  end(opts?: { output?: Message[] | string; error?: unknown }): void;
  /** Ends the turn on scope exit — enables `await using turn = agentTurn(...)`. */
  [Symbol.asyncDispose](): Promise<void>;
}

/** True when `input` is already genai-otel `Message[]` (has a `parts` array). */
function isMessageArray(input: ModelMessage[] | Message[]): input is Message[] {
  return Array.isArray((input[0] as Message | undefined)?.parts);
}

/**
 * Normalizes the turn input: `Message[]` passes through; AI SDK `ModelMessage[]`
 * is mapped via {@link toAgentInputMessages}. Mixed arrays are not supported.
 */
function toMessages(input?: ModelMessage[] | Message[]): Message[] {
  if (!input || input.length === 0) return [];
  return isMessageArray(input) ? input : toAgentInputMessages(input);
}

/**
 * Opens an `invoke_agent` turn and returns a handle bundling the recorder, a
 * spread-safe hook bag, an active-context runner, and an idempotent closer.
 *
 * `start` seeds the agent span (identity + input); `options` configures the
 * per-step generation spans the hooks emit; `callerHooks` are the caller's own
 * AI SDK step callbacks, folded into `hooks` so they compose with telemetry.
 *
 * Each call produces an independent handle — do not reuse across turns.
 */
export function agentTurn(
  client: Client,
  start: Omit<AgentInvocationStart, 'input'> & { input?: ModelMessage[] | Message[] },
  options: VercelAdapterOptions = {},
  callerHooks?: Partial<StreamTextHooks>,
): AgentTurn {
  const { input, ...rest } = start;
  const seed: AgentInvocationStart = { ...rest, input: toMessages(input) };
  const recorder = client.invokeAgent(seed);
  const hooks = streamTextHooks(client, options, callerHooks);
  let closed = false;

  return {
    recorder,
    hooks,
    run<T>(fn: () => T): T {
      return recorder.withActiveContext(fn);
    },
    end(opts?: { output?: Message[] | string; error?: unknown }): void {
      if (closed) return;
      closed = true;
      if (opts?.error !== undefined) {
        recorder.setError(opts.error);
      } else if (opts?.output !== undefined) {
        recorder.setOutput(
          typeof opts.output === 'string' ? [assistantTextMessage(opts.output)] : opts.output,
        );
      }
      void recorder.end();
    },
    async [Symbol.asyncDispose](): Promise<void> {
      closed = true;
      await recorder.end();
    },
  };
}
