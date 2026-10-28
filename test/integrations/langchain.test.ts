/*
 * Copyright 2026 Snowflake Inc.
 * SPDX-License-Identifier: Apache-2.0
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Tests for the LangChain adapter.
 *
 * Drives `GenAIOtelCallbackHandler` directly via its `handle*` methods rather
 * than wiring up a real LangChain chain — the latter brings in a lot of
 * scaffolding that adds noise without adding coverage. The adapter contract
 * IS the `handle*` methods; if those are called in the right order with the
 * right arguments, the resulting spans will be correct.
 */

import { Serializable } from '@langchain/core/load/serializable';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import { context, trace } from '@opentelemetry/api';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withAgent, withConversationId, withUserId } from '../../src/context.js';
import { GenAIOtelCallbackHandler } from '../../src/integrations/langchain/index.js';
import {
  ATTR_AGENT_NAME,
  ATTR_AGENT_VERSION,
  ATTR_CONVERSATION_ID,
  ATTR_DATA_SOURCE_ID,
  ATTR_INPUT_MESSAGES,
  ATTR_OPERATION_NAME,
  ATTR_OUTPUT_MESSAGES,
  ATTR_PROVIDER_NAME,
  ATTR_REQUEST_MODEL,
  ATTR_REQUEST_STREAM,
  ATTR_RESPONSE_ID,
  ATTR_RESPONSE_MODEL,
  ATTR_RETRIEVAL_DOCUMENTS,
  ATTR_RETRIEVAL_QUERY_TEXT,
  ATTR_RETRIEVAL_TOP_K,
  ATTR_TOOL_CALL_ARGUMENTS,
  ATTR_TOOL_CALL_ID,
  ATTR_TOOL_CALL_RESULT,
  ATTR_TOOL_DEFINITIONS,
  ATTR_TOOL_NAME,
  ATTR_USAGE_CACHE_READ_INPUT_TOKENS,
  ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS,
  ATTR_USAGE_INPUT_TOKENS,
  ATTR_USAGE_OUTPUT_TOKENS,
  ATTR_USER_ID,
  ATTR_WORKFLOW_NAME,
  OP_CHAT,
  OP_EXECUTE_TOOL,
  OP_INVOKE_AGENT,
  OP_INVOKE_WORKFLOW,
  OP_RETRIEVAL,
} from '../../src/semconv.js';
import { type Harness, createHarness } from '../_harness.js';

const llmSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'chat_models', 'openai', 'ChatOpenAI'],
  kwargs: { model: 'gpt-4o' },
};

const toolSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'tools', 'search'],
  kwargs: {},
};

/** What a compiled LangGraph graph serializes to (`Pregel` keeps the `langgraph` namespace). */
const graphSerialized = {
  lc: 1,
  type: 'not_implemented',
  id: ['langgraph', 'pregel', 'CompiledStateGraph'],
};

/** The run metadata `createAgent` (from `langchain`) puts on its graph. */
const createAgentMetadata = { ls_integration: 'langchain_create_agent' };

/** A step inside a graph, such as a node. */
const sequenceSerialized = {
  lc: 1,
  type: 'not_implemented',
  id: ['langchain_core', 'runnables', 'RunnableSequence'],
};

const chainSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'chains', 'RetrievalQA'],
  kwargs: {},
};

const retrieverSerialized = {
  lc: 1,
  type: 'constructor',
  id: ['langchain', 'retrievers', 'VectorStoreRetriever'],
  kwargs: {},
};

/**
 * Minimal real `Serializable` so tests can build payloads via the same
 * `toJSON()` LangChain uses — which decamelizes kwargs keys to snake_case —
 * instead of hand-crafting shapes LangChain never emits.
 */
class FakeSerializable extends Serializable {
  lc_namespace = ['test', 'fake'];
  override lc_serializable = true;
}

describe('LangChain adapter — LLM lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a chat span with provider/model inferred from the Serialized id', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });

    await handler.handleLLMStart!(llmSerialized as any, ['hello'], 'run-1');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'hi', generationInfo: { finish_reason: 'stop' } }]],
        llmOutput: {
          tokenUsage: { prompt_tokens: 9, completion_tokens: 3, total_tokens: 12 },
        },
      },
      'run-1',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_CHAT);
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(9);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(3);
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['stop']);
  });

  it('captures structured input + output via handleChatModelStart', async () => {
    const handler = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'no_tool_content',
    });
    const system = { _getType: () => 'system', content: 'be nice' };
    const human = { _getType: () => 'human', content: 'hi there' };
    await handler.handleChatModelStart!(llmSerialized as any, [[system, human] as any], 'run-chat');
    await handler.handleLLMEnd!(
      {
        generations: [
          [{ text: 'hello', message: { _getType: () => 'ai', content: 'hello' } } as any],
        ],
        llmOutput: { tokenUsage: { prompt_tokens: 4, completion_tokens: 1 } },
      },
      'run-chat',
    );

    const [span] = h.spans.getFinishedSpans();
    const input = JSON.parse(span!.attributes['gen_ai.input.messages'] as string);
    expect(input).toHaveLength(2);
    expect(input[0].role).toBe('system');
    expect(input[1].role).toBe('user');
    expect(input[1].parts[0].content).toBe('hi there');
    const output = JSON.parse(span!.attributes['gen_ai.output.messages'] as string);
    expect(output[0].role).toBe('assistant');
    expect(output[0].parts[0].content).toBe('hello');
  });

  it('reads the provider stop_reason from message.response_metadata (LangChain 1.x)', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-tooluse');
    // LangChain 1.x leaves generationInfo null; the real reason for a
    // tool-calling turn lives on the message's response_metadata.
    await handler.handleLLMEnd!(
      {
        generations: [
          [
            {
              text: '',
              generationInfo: null,
              message: {
                _getType: () => 'ai',
                content: 'calling a tool',
                response_metadata: { stop_reason: 'tool_use', model: 'claude-opus-4-8' },
              },
            } as any,
          ],
        ],
        llmOutput: { stop_reason: 'tool_use' },
      },
      'run-tooluse',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['tool_use']);
    const output = JSON.parse(span!.attributes[ATTR_OUTPUT_MESSAGES] as string);
    expect(output[0].finish_reason).toBe('tool_use');
  });

  it('falls back to llmOutput.stop_reason when the message carries no reason', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-llmout');
    await handler.handleLLMEnd!(
      {
        generations: [
          [{ text: 'done', message: { _getType: () => 'ai', content: 'done' } } as any],
        ],
        llmOutput: { stop_reason: 'max_tokens' },
      },
      'run-llmout',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.response.finish_reasons']).toEqual(['max_tokens']);
    const output = JSON.parse(span!.attributes[ATTR_OUTPUT_MESSAGES] as string);
    expect(output[0].finish_reason).toBe('max_tokens');
  });

  it('defaults the output-message finish_reason to stop when no provider reason is available', async () => {
    // The response-level `gen_ai.response.finish_reasons` reflects only a real
    // provider reason (omitted here), but the required per-message `finish_reason`
    // defaults to `stop`.
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-noreason');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'hi', message: { _getType: () => 'ai', content: 'hi' } } as any]],
        llmOutput: { tokenUsage: { prompt_tokens: 1, completion_tokens: 1 } },
      },
      'run-noreason',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['gen_ai.response.finish_reasons']).toBeUndefined();
    const output = JSON.parse(span!.attributes[ATTR_OUTPUT_MESSAGES] as string);
    expect(output[0].finish_reason).toBe('stop');
  });

  it('captures TTFT on first non-empty token', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleLLMStart!(llmSerialized as any, ['hi'], 'run-stream');
    await handler.handleLLMNewToken!('hello', {} as never, 'run-stream');
    await handler.handleLLMNewToken!(' world', {} as never, 'run-stream');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'hello world', generationInfo: { finish_reason: 'stop' } }]],
        llmOutput: { tokenUsage: { prompt_tokens: 1, completion_tokens: 2 } },
      },
      'run-stream',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span).toBeDefined();
  });

  it('records LLM errors as provider_call_error', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleLLMStart!(llmSerialized as any, ['hi'], 'run-err');
    await handler.handleLLMError!(
      Object.assign(new Error('upstream 500'), { status: 500 }),
      'run-err',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('provider_call_error');
    expect(span?.attributes['error.category']).toBe('server_error');
  });
});

describe('LangChain adapter — response id', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  async function endWith(runId: string, result: unknown): Promise<void> {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, runId);
    await handler.handleLLMEnd!(result as never, runId);
  }

  const generation = (message: Record<string, unknown>) => ({
    generations: [[{ text: 'hi', message: { _getType: () => 'ai', content: 'hi', ...message } }]],
  });

  it('reads llmOutput.id first', async () => {
    // ChatOpenAI 0.6 on the Responses API: the message carries an output item's id.
    await endWith('run-resp-id-llmoutput', {
      ...generation({ id: 'msg_1' }),
      llmOutput: { id: 'resp_1' },
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp_1');
  });

  it('reads response_metadata.id before the message id (streamed Responses API)', async () => {
    await endWith(
      'run-resp-id-meta',
      generation({ id: 'msg_1', response_metadata: { id: 'resp_1' } }),
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('resp_1');
  });

  it('falls back to the message id (ChatOpenAI chat completions)', async () => {
    await endWith('run-resp-id-message', generation({ id: 'chatcmpl-abc' }));

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBe('chatcmpl-abc');
  });

  it('ignores the run-<runId> id LangChain fills in when the message has none', async () => {
    const runId = 'run-resp-id-fallback';
    await endWith(runId, generation({ id: `run-${runId}` }));

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_ID]).toBeUndefined();
  });
});

describe('LangChain adapter — response model', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  async function endWith(runId: string, result: unknown): Promise<void> {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, runId);
    await handler.handleLLMEnd!(result as never, runId);
  }

  const generation = (message: Record<string, unknown>) => ({
    generations: [[{ text: 'hi', message: { _getType: () => 'ai', content: 'hi', ...message } }]],
  });

  it('reads llmOutput.model', async () => {
    await endWith('run-resp-model-llmoutput', {
      ...generation({}),
      llmOutput: { model: 'gpt-4o-2024-11-20' },
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-2024-11-20');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
  });

  it('falls back to the message response_metadata.model (ChatAnthropic)', async () => {
    // ChatAnthropic passes the API response through, so the key is `model`.
    await endWith(
      'run-resp-model-meta',
      generation({ response_metadata: { model: 'claude-sonnet-4-5-20250929' } }),
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('claude-sonnet-4-5-20250929');
  });

  it('reads response_metadata.model_name (ChatOpenAI)', async () => {
    // @langchain/openai builds response_metadata as
    // { model_provider, model_name: rawResponse.model, usage, ... } and puts no
    // model on `llmOutput`, so probing `model` alone finds nothing.
    await endWith('run-resp-model-name', {
      ...generation({
        response_metadata: {
          model_provider: 'openai',
          model_name: 'gpt-4o-2024-11-20',
          usage: { prompt_tokens: 9, completion_tokens: 3 },
        },
      }),
      llmOutput: { tokenUsage: { promptTokens: 9, completionTokens: 3, totalTokens: 12 } },
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-2024-11-20');
  });

  it('reads additional_kwargs.model (streaming ChatAnthropic)', async () => {
    // A streamed Anthropic turn carries the model only here: `response_metadata`
    // has none, and neither does `llmOutput`.
    await endWith('run-resp-model-akw', {
      ...generation({
        response_metadata: { model_provider: 'anthropic' },
        additional_kwargs: { id: 'msg_2', model: 'claude-sonnet-4-5-20250929' },
      }),
      llmOutput: { tokenUsage: { promptTokens: 0, completionTokens: 20, totalTokens: 20 } },
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('claude-sonnet-4-5-20250929');
  });

  it('reads generationInfo.model_name (streaming ChatOpenAI)', async () => {
    // When LangChain streams inside invoke(), ChatOpenAI carries the model only on the generation.
    await endWith('run-resp-model-geninfo', {
      generations: [
        [
          {
            text: 'hi',
            generationInfo: { model_name: 'gpt-4o-2024-11-20' },
            message: { _getType: () => 'ai', content: 'hi', response_metadata: {} },
          },
        ],
      ],
    } as never);

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBe('gpt-4o-2024-11-20');
  });

  it('stays absent when the provider reports no model', async () => {
    await endWith('run-resp-model-absent', generation({}));

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_RESPONSE_MODEL]).toBeUndefined();
  });

  it('falls back to metadata ls_model_name for gen_ai.request.model', async () => {
    // A serialized shape without `kwargs.model` (some proxy/gateway classes strip
    // it) — every LangChain chat model still populates `ls_model_name` via
    // `getLsParams`, so it's the last honest source before "unknown".
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(
      { lc: 1, type: 'constructor', id: ['some-gateway', 'CustomChat'], kwargs: {} } as any,
      [[]] as any,
      'run-ls-model-name',
      undefined,
      undefined,
      undefined,
      { ls_model_name: 'gpt-4o' },
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: '', message: { _getType: () => 'ai', content: '' } }]] } as never,
      'run-ls-model-name',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gpt-4o');
  });
});

describe('LangChain adapter — provider name mapping', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  async function providerFor(id: string[], lsProvider?: string): Promise<unknown> {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const runId = `run-provider-${id.join('-')}`;
    await handler.handleChatModelStart!(
      { lc: 1, type: 'constructor', id, kwargs: { model: 'm' } } as any,
      [[]] as any,
      runId,
      undefined,
      undefined,
      undefined,
      lsProvider ? { ls_provider: lsProvider } : undefined,
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: '', message: { _getType: () => 'ai', content: '' } }]] } as never,
      runId,
    );
    const spans = h.spans.getFinishedSpans();
    return spans[spans.length - 1]?.attributes[ATTR_PROVIDER_NAME];
  }

  // Real @langchain/* serialized id paths → semconv well-known values. Checked
  // against the published packages in August 2026; a package that renames its
  // module path fails here.
  it.each([
    [['langchain', 'chat_models', 'openai', 'ChatOpenAI'], 'openai'],
    [['langchain', 'chat_models', 'anthropic', 'ChatAnthropic'], 'anthropic'],
    [['langchain', 'chat_models', 'vertexai', 'ChatVertexAI'], 'gcp.vertex_ai'],
    [['langchain', 'chat_models', 'google_genai', 'ChatGoogleGenerativeAI'], 'gcp.gemini'],
    [['langchain', 'chat_models', 'chat_bedrock_converse', 'ChatBedrockConverse'], 'aws.bedrock'],
    [['langchain', 'chat_models', 'azure_openai', 'AzureChatOpenAI'], 'azure.ai.openai'],
    [['langchain', 'chat_models', 'mistralai', 'ChatMistralAI'], 'mistral_ai'],
    [['langchain', 'chat_models', 'groq', 'ChatGroq'], 'groq'],
    [['langchain', 'chat_models', 'deepseek', 'ChatDeepSeek'], 'deepseek'],
    [['langchain', 'chat_models', 'xai', 'ChatXAI'], 'x_ai'],
    [['langchain', 'chat_models', 'cohere', 'ChatCohere'], 'cohere'],
    [['langchain', 'chat_models', 'watsonx', 'ChatWatsonx'], 'ibm.watsonx.ai'],
  ])('maps %j to %s', async (id, expected) => {
    expect(await providerFor(id as string[])).toBe(expected);
  });

  it('prefers the hosting platform over the model vendor it hosts', async () => {
    // AzureChatOpenAI's id path contains "openai", so the azure entry has to be
    // matched first.
    expect(await providerFor(['langchain', 'chat_models', 'azure_openai', 'AzureChatOpenAI'])).toBe(
      'azure.ai.openai',
    );
  });

  it('keeps a plain name for a provider the semconv list does not cover', async () => {
    expect(await providerFor(['langchain', 'chat_models', 'ollama', 'ChatOllama'])).toBe('ollama');
  });

  it('maps Azure AI Inference paths distinctly from Azure OpenAI', async () => {
    // Speculative: no LangChain JS class for Azure AI Inference exists yet, but
    // semconv defines `azure.ai.inference` as a separate provider. Locks in that
    // an id path containing `azure_ai` beats the `azure` (OpenAI) entry, and that
    // AzureChatOpenAI's path — which contains neither `azure_ai` nor `azureai` —
    // stays on `azure.ai.openai`.
    expect(
      await providerFor(['langchain', 'chat_models', 'azure_ai', 'AzureAIChatCompletionsModel']),
    ).toBe('azure.ai.inference');
    expect(await providerFor(['langchain', 'chat_models', 'azure_openai', 'AzureChatOpenAI'])).toBe(
      'azure.ai.openai',
    );
  });

  it('maps a Snowflake id path to snowflake', async () => {
    // Speculative: the path is modeled on Python's ChatSnowflakeCortex. `snowflake`
    // is not a semconv well-known value; it matches what the Vercel AI SDK
    // integration reports.
    expect(
      await providerFor(['langchain', 'chat_models', 'snowflake', 'ChatSnowflakeCortex']),
    ).toBe('snowflake');
  });

  it('falls back to metadata ls_provider when the class name matches nothing', async () => {
    // A proxy/gateway class name matches no known provider, but LangChain's run
    // metadata names it.
    expect(await providerFor(['some-gateway', 'CustomChat'], 'openai')).toBe('openai');
    // An ls_provider the table doesn't know is passed through rather than
    // reporting the class name.
    expect(await providerFor(['some-gateway', 'CustomChat'], 'togetherai')).toBe('togetherai');
  });

  it('keeps the id-path platform when ls_provider names the vendor it hosts', async () => {
    // AzureChatOpenAI inherits `ls_provider: "openai"` from @langchain/openai,
    // so the declared value must not beat the `id` path.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(
      {
        lc: 1,
        type: 'constructor',
        id: ['langchain', 'chat_models', 'azure_openai', 'AzureChatOpenAI'],
        kwargs: { model: 'my-gpt4o-deployment' },
      } as any,
      [[]] as any,
      'run-azure-declared',
      undefined,
      undefined,
      undefined,
      { ls_provider: 'openai' },
    );
    await handler.handleLLMEnd!(
      {
        generations: [
          [
            {
              text: '',
              message: {
                _getType: () => 'ai',
                content: '',
                response_metadata: { model_provider: 'openai', model_name: 'gpt-4o-2024-11-20' },
              },
            },
          ],
        ],
      } as never,
      'run-azure-declared',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('azure.ai.openai');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('my-gpt4o-deployment');
  });

  it('matches an ls_provider whose separators differ from the id path', async () => {
    // Hyphenated metadata values must reach the same value as the underscored
    // `id` path spelling.
    expect(await providerFor(['some-gateway', 'CustomChat'], 'google-genai')).toBe('gcp.gemini');
    expect(await providerFor(['some-gateway', 'CustomChat'], 'bedrock-converse')).toBe(
      'aws.bedrock',
    );
  });

  it('normalizes an ls_provider value to the semconv value', async () => {
    // `google_genai` matches, so it must be normalized rather than passed through.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(
      { lc: 1, type: 'constructor', id: ['x'], kwargs: { model: 'gemini-2.0-flash' } } as any,
      [[]] as any,
      'run-ls-google',
      undefined,
      undefined,
      undefined,
      { ls_provider: 'google_genai' },
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: '', message: { _getType: () => 'ai', content: '' } }]] } as never,
      'run-ls-google',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_PROVIDER_NAME]).toBe('gcp.gemini');
    expect(span?.attributes[ATTR_REQUEST_MODEL]).toBe('gemini-2.0-flash');
  });
});

describe('LangChain adapter — cache token counts', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  async function endWith(runId: string, result: unknown): Promise<void> {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[{ _getType: () => 'human', content: 'hi' }] as any],
      runId,
    );
    await handler.handleLLMEnd!(result as never, runId);
  }

  it('reads cache counts nested under usage_metadata.input_token_details', async () => {
    // LangChain's standardized UsageMetadata shape.
    await endWith('run-cache-nested', {
      generations: [
        [
          {
            text: 'hi',
            message: {
              _getType: () => 'ai',
              content: 'hi',
              usage_metadata: {
                input_tokens: 420,
                output_tokens: 66,
                total_tokens: 486,
                input_token_details: { cache_read: 300, cache_creation: 40 },
              },
            },
          },
        ],
      ],
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(420);
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(300);
    expect(span?.attributes[ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS]).toBe(40);
  });

  it('takes cache counts from the message when input counts tie (real ChatOpenAI)', async () => {
    // Real ChatOpenAI reports the same input count on both sources. The tie makes
    // `llmOutput` primary, and it has no cache breakdown, so the read count has
    // to come from the message.
    await endWith('run-cache-tie', {
      generations: [
        [
          {
            text: 'hi',
            message: {
              _getType: () => 'ai',
              content: 'hi',
              usage_metadata: {
                input_tokens: 2000,
                output_tokens: 10,
                total_tokens: 2010,
                input_token_details: { cache_read: 1920 },
              },
            },
          },
        ],
      ],
      llmOutput: { tokenUsage: { promptTokens: 2000, completionTokens: 10, totalTokens: 2010 } },
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(2000);
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(1920);
  });

  it('keeps cache counts from the source that loses on input tokens', async () => {
    // ChatAnthropic copies the raw response onto `llmOutput`, where input_tokens
    // excludes cached ones. Totals come from the message; the cache count only
    // exists here.
    await endWith('run-cache-losing-bag', {
      generations: [
        [
          {
            text: 'hi',
            message: {
              _getType: () => 'ai',
              content: 'hi',
              usage_metadata: { input_tokens: 25, output_tokens: 12, total_tokens: 37 },
            },
          },
        ],
      ],
      llmOutput: {
        id: 'msg_1',
        model: 'claude-x',
        stop_reason: 'end_turn',
        usage: { input_tokens: 0, output_tokens: 12, cache_read_input_tokens: 90 },
      },
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBe(90);
  });

  it('ignores a usage object nested under response_metadata', async () => {
    // ChatAnthropic({ streamUsage: false }) reports usage only under
    // `response_metadata.usage`. The adapter reads one usage object per
    // container and never descends into `response_metadata`, so nothing lands.
    await endWith('run-cache-orphan', {
      generations: [
        [
          {
            text: 'hi',
            message: {
              _getType: () => 'ai',
              content: 'hi',
              response_metadata: {
                usage: { cache_read_input_tokens: 768, cache_creation_input_tokens: 512 },
              },
            },
          },
        ],
      ],
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBeUndefined();
    expect(span?.attributes[ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS]).toBeUndefined();
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBeUndefined();
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBeUndefined();
  });

  it('omits the attributes when the provider reports no cache use', async () => {
    await endWith('run-cache-zero', {
      generations: [
        [
          {
            text: 'hi',
            message: {
              _getType: () => 'ai',
              content: 'hi',
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 2,
                input_token_details: { cache_read: 0, cache_creation: 0 },
              },
            },
          },
        ],
      ],
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBeUndefined();
    expect(span?.attributes[ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS]).toBeUndefined();
  });

  it('emits only the non-zero cache count', async () => {
    await endWith('run-cache-one-sided', {
      generations: [
        [
          {
            text: 'hi',
            message: {
              _getType: () => 'ai',
              content: 'hi',
              usage_metadata: {
                input_tokens: 10,
                output_tokens: 2,
                input_token_details: { cache_read: 0, cache_creation: 7 },
              },
            },
          },
        ],
      ],
    });

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_USAGE_CACHE_WRITE_INPUT_TOKENS]).toBe(7);
    expect(span?.attributes[ATTR_USAGE_CACHE_READ_INPUT_TOKENS]).toBeUndefined();
  });
});

describe('LangChain adapter — tool definitions', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** Parsed gen_ai.tool.definitions off the single finished span. */
  function toolDefs(): unknown {
    const [span] = h.spans.getFinishedSpans();
    const raw = span?.attributes[ATTR_TOOL_DEFINITIONS];
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }

  it('emits gen_ai.tool.definitions from Anthropic-shaped bound tools', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    const extraParams = {
      invocation_params: {
        model: 'claude-opus-4-8',
        tools: [
          {
            name: 'get_weather',
            description: 'Return current weather for a city',
            input_schema: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
          },
        ],
      },
    };
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[]] as any,
      'run-tools',
      undefined,
      extraParams,
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: 'ok', message: { _getType: () => 'ai', content: 'ok' } }]] } as any,
      'run-tools',
    );

    expect(toolDefs()).toEqual([
      {
        type: 'function',
        name: 'get_weather',
        description: 'Return current weather for a city',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      },
    ]);
  });

  it('emits only the required type + name under no_tool_content capture', async () => {
    // Tool schemas carry business detail, so description/parameters must be
    // withheld while type/name (the schema-required, non-sensitive fields)
    // still advertise tool topology.
    const handler = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'no_tool_content',
    });
    const extraParams = {
      invocation_params: {
        model: 'claude-opus-4-8',
        tools: [
          {
            name: 'get_weather',
            description: 'Return current weather for a city',
            input_schema: { type: 'object', properties: { city: { type: 'string' } } },
          },
        ],
      },
    };
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[]] as any,
      'run-ntc',
      undefined,
      extraParams,
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: 'ok', message: { _getType: () => 'ai', content: 'ok' } }]] } as any,
      'run-ntc',
    );

    expect(toolDefs()).toEqual([{ type: 'function', name: 'get_weather' }]);
  });

  it('normalizes OpenAI function-wrapped tools into { type, name, description, parameters }', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    const extraParams = {
      invocation_params: {
        model: 'gpt-4o',
        tools: [
          {
            type: 'function',
            function: {
              name: 'lookup',
              description: 'Look up a value',
              parameters: { type: 'object', properties: { q: { type: 'string' } } },
            },
          },
        ],
      },
    };
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[]] as any,
      'run-oa',
      undefined,
      extraParams,
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: 'ok', message: { _getType: () => 'ai', content: 'ok' } }]] } as any,
      'run-oa',
    );

    expect(toolDefs()).toEqual([
      {
        type: 'function',
        name: 'lookup',
        description: 'Look up a value',
        parameters: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  });

  it('does not emit the attribute when no tools are bound', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-none', undefined, {
      invocation_params: { model: 'gpt-4o' },
    });
    await handler.handleLLMEnd!(
      { generations: [[{ text: 'ok', message: { _getType: () => 'ai', content: 'ok' } }]] } as any,
      'run-none',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_DEFINITIONS]).toBeUndefined();
  });

  it('strips tool definitions under metadata_only capture', async () => {
    const handler = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'metadata_only',
    });
    const extraParams = {
      invocation_params: {
        model: 'gpt-4o',
        tools: [{ name: 'get_weather', input_schema: { type: 'object' } }],
      },
    };
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[]] as any,
      'run-md',
      undefined,
      extraParams,
    );
    await handler.handleLLMEnd!(
      { generations: [[{ text: 'ok', message: { _getType: () => 'ai', content: 'ok' } }]] } as any,
      'run-md',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_DEFINITIONS]).toBeUndefined();
  });
});

describe('LangChain adapter — streaming', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** True when a histogram of `name` recorded at least one data point. */
  function hasMetric(collected: unknown, name: string): boolean {
    const list = (collected as Array<{ scopeMetrics?: Array<{ metrics?: unknown[] }> }>) ?? [];
    for (const rm of list) {
      for (const sm of rm.scopeMetrics ?? []) {
        for (const m of (sm.metrics ?? []) as Array<{
          descriptor?: { name?: string };
          dataPoints?: unknown[];
        }>) {
          if (m.descriptor?.name === name && (m.dataPoints?.length ?? 0) > 0) return true;
        }
      }
    }
    return false;
  }

  const streamParams = { invocation_params: { model: 'claude-opus-4-8', stream: true } };

  it('marks the span as streaming and recovers input_tokens from message.usage_metadata', async () => {
    // An Anthropic stream delivers input tokens on
    // message_start, which LangChain aggregates onto the generation message's
    // usage_metadata — not llmOutput. The span must still carry both token
    // counts and be flagged as a stream.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[{ _getType: () => 'human', content: 'hi' }] as any],
      'run-stream-usage',
      undefined,
      streamParams,
    );
    await handler.handleLLMNewToken!('hel', {} as never, 'run-stream-usage');
    await handler.handleLLMEnd!(
      {
        generations: [
          [
            {
              text: 'hello',
              message: {
                _getType: () => 'ai',
                content: 'hello',
                usage_metadata: { input_tokens: 25, output_tokens: 12, total_tokens: 37 },
              },
            } as any,
          ],
        ],
        // Real ChatAnthropic streaming shape: llmOutput reports promptTokens 0
        // (a present-but-bogus zero) while the message carries the real count.
        llmOutput: { tokenUsage: { promptTokens: 0, completionTokens: 12, totalTokens: 12 } },
      },
      'run-stream-usage',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_REQUEST_STREAM]).toBe(true);
    expect(span?.attributes[ATTR_USAGE_INPUT_TOKENS]).toBe(25);
    expect(span?.attributes[ATTR_USAGE_OUTPUT_TOKENS]).toBe(12);
  });

  it('records time_to_first_token for a streamed call', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(
      llmSerialized as any,
      [[]] as any,
      'run-ttft',
      undefined,
      streamParams,
    );
    await handler.handleLLMNewToken!('a', {} as never, 'run-ttft');
    await handler.handleLLMEnd!(
      { generations: [[{ text: 'a', message: { _getType: () => 'ai', content: 'a' } }]] } as never,
      'run-ttft',
    );

    expect(hasMetric(await h.collectMetrics(), 'gen_ai.client.time_to_first_token')).toBe(true);
  });

  it('upgrades to streaming from token arrival even without an invocation flag', async () => {
    // Some integrations do not expose invocation_params.stream. Receiving a
    // streamed token is itself proof the call is streaming.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-token-only');
    await handler.handleLLMNewToken!('tok', {} as never, 'run-token-only');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'tok', message: { _getType: () => 'ai', content: 'tok' } }]],
      } as never,
      'run-token-only',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_REQUEST_STREAM]).toBe(true);
    expect(hasMetric(await h.collectMetrics(), 'gen_ai.client.time_to_first_token')).toBe(true);
  });

  it('marks a streamed call that returns only a tool call', async () => {
    // Each chunk of a tool-call-only stream has no text, so no token is ever seen.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-tool-stream');
    await handler.handleLLMNewToken!('', {} as never, 'run-tool-stream');
    await handler.handleLLMNewToken!('', {} as never, 'run-tool-stream');
    await handler.handleLLMEnd!(
      { generations: [[{ text: '', message: { _getType: () => 'ai', content: '' } }]] } as never,
      'run-tool-stream',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_REQUEST_STREAM]).toBe(true);
    // Time to first token still waits for text.
    expect(hasMetric(await h.collectMetrics(), 'gen_ai.client.time_to_first_token')).toBe(false);
  });

  it('leaves a synchronous call unmarked', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as any, [[]] as any, 'run-sync');
    await handler.handleLLMEnd!(
      {
        generations: [[{ text: 'hi', message: { _getType: () => 'ai', content: 'hi' } } as any]],
        llmOutput: { tokenUsage: { prompt_tokens: 4, completion_tokens: 1 } },
      },
      'run-sync',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_REQUEST_STREAM]).toBeUndefined();
  });
});

describe('LangChain adapter — tool lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits execute_tool spans with INTERNAL kind', async () => {
    const handler = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'full',
    });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-1');
    await handler.handleToolEnd!('result', 'tool-1');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_EXECUTE_TOOL);
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('search');
    expect(span?.kind).toBe(0 /* INTERNAL */);
  });

  it('records tool errors as tool_execution_error', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(toolSerialized as any, '{}', 'tool-err');
    await handler.handleToolError!(new Error('tool blew up'), 'tool-err');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes['error.type']).toBe('tool_execution_error');
  });

  it('names a failed tool from runName, not the serialized class name', async () => {
    // Failures go straight to handleToolError with no ToolMessage, so the
    // start-time runName (the tool instance name, present even on failures) is
    // the only real name available.
    const classToolSerialized = {
      lc: 1,
      type: 'constructor',
      id: ['langchain', 'tools', 'DynamicStructuredTool'],
      kwargs: {},
    };
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(
      classToolSerialized as any,
      '{"city":"Tokyo"}',
      'tool-fail',
      undefined,
      [],
      undefined,
      'get_weather',
    );
    await handler.handleToolError!(new Error('boom'), 'tool-fail');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('get_weather');
    expect(span?.name).toBe('execute_tool get_weather');
  });

  it('lets the tool-end ToolMessage name override runName on success', async () => {
    // runName is caller-overridable, so the authoritative ToolMessage name wins
    // when the tool succeeds.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(
      toolSerialized as any,
      '{"city":"Tokyo"}',
      'tool-override',
      undefined,
      [],
      undefined,
      'caller-renamed-run',
    );
    await handler.handleToolEnd!(
      { _getType: () => 'tool', name: 'get_weather', content: 'sunny' } as any,
      'tool-override',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('get_weather');
  });

  it('names the execute_tool span from the tool-end ToolMessage name', async () => {
    // Real tools serialize to their generic class name; the instance's real
    // `name` is authoritative and arrives on the tool-end ToolMessage.
    const classToolSerialized = {
      lc: 1,
      type: 'constructor',
      id: ['langchain', 'tools', 'DynamicStructuredTool'],
      kwargs: {},
    };
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(classToolSerialized as any, '{"city":"Tokyo"}', 'tool-run');
    await handler.handleToolEnd!(
      { _getType: () => 'tool', name: 'get_weather', content: 'sunny' } as any,
      'tool-run',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('get_weather');
    expect(span?.name).toBe('execute_tool get_weather');
  });

  it('gives two differently-named tools two differently-named spans', async () => {
    const classToolSerialized = {
      lc: 1,
      type: 'constructor',
      id: ['langchain', 'tools', 'DynamicStructuredTool'],
      kwargs: {},
    };
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(classToolSerialized as any, '{"city":"Tokyo"}', 't-weather');
    await handler.handleToolEnd!(
      { _getType: () => 'tool', name: 'get_weather', content: 'sunny' } as any,
      't-weather',
    );
    await handler.handleToolStart!(classToolSerialized as any, '{"weather":"sunny"}', 't-activity');
    await handler.handleToolEnd!(
      { _getType: () => 'tool', name: 'recommend_activity', content: 'go outside' } as any,
      't-activity',
    );

    const names = h.spans.getFinishedSpans().map((s) => s.name);
    expect(names).toContain('execute_tool get_weather');
    expect(names).toContain('execute_tool recommend_activity');
    expect(new Set(names).size).toBe(2);
  });

  it('falls back to the serialized class name when the result carries no name', async () => {
    // A bare-string result (direct .invoke, not a ToolMessage) has no name, so
    // the start-time class-name placeholder stands.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-fallback');
    await handler.handleToolEnd!('result', 'tool-fallback');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_NAME]).toBe('search');
    expect(span?.name).toBe('execute_tool search');
  });

  it('backfills gen_ai.tool.call.id from the tool-end ToolMessage', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(toolSerialized as any, '{"city":"Tokyo"}', 'tool-id');
    // Modern LangChain passes a ToolMessage (not a bare string) to tool-end.
    await handler.handleToolEnd!(
      {
        _getType: () => 'tool',
        tool_call_id: 'toolu_bdrk_01KasL9JjjkNha2wutiD9eDJ',
        content: 'Tokyo: sunny, 25C',
      } as any,
      'tool-id',
    );

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_CALL_ID]).toBe('toolu_bdrk_01KasL9JjjkNha2wutiD9eDJ');
  });

  it('unwraps the ToolMessage content for gen_ai.tool.call.result', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleToolStart!(toolSerialized as any, '{"city":"Shanghai"}', 'tool-res');
    // Modern LangChain wraps the tool return in a ToolMessage; the real answer
    // lives in `content`, surrounded by transport noise that must be dropped.
    await handler.handleToolEnd!(
      {
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'messages', 'ToolMessage'],
        _getType: () => 'tool',
        status: 'success',
        content: 'Shanghai: sunny, 25C, good for going outside',
        tool_call_id: 'toolu_bdrk_016q1Thxcjjz',
        name: 'get_weather',
        artifact: { raw: 'do-not-emit' },
        metadata: { versions: { '@langchain/core': '1.2.3' } },
        additional_kwargs: {},
        response_metadata: {},
      } as any,
      'tool-res',
    );

    const [span] = h.spans.getFinishedSpans();
    const result = span?.attributes[ATTR_TOOL_CALL_RESULT] as string;
    expect(result).toBe(JSON.stringify('Shanghai: sunny, 25C, good for going outside'));
    expect(result).not.toContain('kwargs');
    expect(result).not.toContain('response_metadata');
    expect(result).not.toContain('do-not-emit');
  });

  it('unwraps ToolMessage content-block arrays and keeps JSON results structured', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-blocks');
    await handler.handleToolEnd!(
      {
        _getType: () => 'tool',
        tool_call_id: 'call-1',
        content: [
          { type: 'text', text: '{"temp":' },
          { type: 'text', text: '25}' },
        ],
      } as any,
      'tool-blocks',
    );

    const [span] = h.spans.getFinishedSpans();
    // Content blocks flatten to the JSON string, which serializes as structured JSON.
    expect(JSON.parse(span?.attributes[ATTR_TOOL_CALL_RESULT] as string)).toEqual({ temp: 25 });
  });

  it('preserves mixed content blocks instead of dropping non-text parts', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleToolStart!(toolSerialized as any, '{"city":"Paris"}', 'tool-mixed');
    // A multimodal ToolMessage: a text block alongside an image block. Flattening
    // to text would silently discard the image, so the array is kept intact.
    await handler.handleToolEnd!(
      {
        _getType: () => 'tool',
        tool_call_id: 'call-mm',
        content: [
          { type: 'text', text: 'Here is the chart:' },
          { type: 'image_url', image_url: { url: 'https://example.com/chart.png' } },
        ],
      } as any,
      'tool-mixed',
    );

    const [span] = h.spans.getFinishedSpans();
    const result = JSON.parse(span?.attributes[ATTR_TOOL_CALL_RESULT] as string);
    expect(result).toEqual([
      { type: 'text', text: 'Here is the chart:' },
      { type: 'image_url', image_url: { url: 'https://example.com/chart.png' } },
    ]);
  });

  it('passes through a bare string result unchanged', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-bare');
    // Direct .invoke() (no tool call) path: the raw return value, not a ToolMessage.
    await handler.handleToolEnd!('plain answer', 'tool-bare');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_CALL_RESULT]).toBe(JSON.stringify('plain answer'));
    expect(span?.attributes[ATTR_TOOL_CALL_ARGUMENTS]).toBe('{"q":"hi"}');
  });

  it('does not mistake a raw object result for a ToolMessage', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-raw');
    // A directly-invoked tool may return a plain object that happens to carry
    // `content`/`tool_call_id` keys. Without a `_getType()` discriminator it must
    // be recorded verbatim, not unwrapped to `content`.
    await handler.handleToolEnd!(
      { tool_call_id: 'not-a-message', content: 'inner', extra: 42 } as any,
      'tool-raw',
    );

    const [span] = h.spans.getFinishedSpans();
    const result = JSON.parse(span?.attributes[ATTR_TOOL_CALL_RESULT] as string);
    expect(result).toEqual({ tool_call_id: 'not-a-message', content: 'inner', extra: 42 });
  });

  it('leaves gen_ai.tool.call.id unset when tool-end has a bare string result', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleToolStart!(toolSerialized as any, '{"q":"hi"}', 'tool-noid');
    await handler.handleToolEnd!('result', 'tool-noid');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_TOOL_CALL_ID]).toBeUndefined();
  });

  it('agrees with the tool_call id on the sibling chat span', async () => {
    const callId = 'toolu_bdrk_016q1Thxcjjz';
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });

    // Chat span whose assistant output requests a tool call carrying `callId`.
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'chat-1');
    await handler.handleLLMEnd!(
      {
        generations: [
          [
            {
              text: '',
              message: {
                _getType: () => 'ai',
                content: '',
                tool_calls: [{ id: callId, name: 'get_weather', args: { city: 'Shanghai' } }],
              },
            },
          ],
        ],
      } as never,
      'chat-1',
    );

    // Tool span for the execution of that call; the ToolMessage carries the id.
    await handler.handleToolStart!(toolSerialized as any, '{"city":"Shanghai"}', 'tool-1');
    await handler.handleToolEnd!(
      { _getType: () => 'tool', tool_call_id: callId, content: 'Shanghai: sunny, 25C' } as any,
      'tool-1',
    );

    const spans = h.spans.getFinishedSpans();
    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    const tool = spans.find((s) => s.name.startsWith('execute_tool'))!;

    // Id on the execute_tool span matches the tool_call part on the chat span.
    expect(tool.attributes[ATTR_TOOL_CALL_ID]).toBe(callId);
    const outMessages = JSON.parse(chat.attributes[ATTR_OUTPUT_MESSAGES] as string);
    const toolCallPart = outMessages
      .flatMap((m: { parts?: Array<{ type?: string; id?: string }> }) => m.parts ?? [])
      .find((p: { type?: string }) => p.type === 'tool_call');
    expect(toolCallPart?.id).toBe(callId);
  });
});

describe('LangChain adapter — chain lifecycle (invoke_agent)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('maps top-level chain start to invoke_agent span', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      chainSerialized as never,
      { question: 'what is otel?' } as never,
      'chain-1',
    );
    await handler.handleChainEnd!({ answer: 'an otel answer' } as never, 'chain-1');

    const [span] = h.spans.getFinishedSpans();
    expect(span?.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_AGENT);
  });

  it('skips child chain starts (parentRunId set)', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      chainSerialized as never,
      { x: 1 } as never,
      'child-1',
      'parent-1',
    );
    // No end call needed — should be a no-op
    expect(h.spans.getFinishedSpans().length).toBe(0);
  });

  it('captureChains=false disables chain instrumentation', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, captureChains: false });
    await handler.handleChainStart!(
      chainSerialized as never,
      { question: 'hi' } as never,
      'chain-skip',
    );
    await handler.handleChainEnd!({ answer: 'ok' } as never, 'chain-skip');
    expect(h.spans.getFinishedSpans().length).toBe(0);
  });

  it('applies handler contentCapture to the invoke_agent span', async () => {
    // A client that captures content makes a bare handler emit agent
    // input/output messages. `contentCapture: 'metadata_only'` on the handler
    // must strip them from the invoke_agent span too — not just from generation
    // and tool spans.
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
    const bare = new GenAIOtelCallbackHandler({ client: h.client });
    await bare.handleChainStart!(
      chainSerialized as never,
      { question: 'secret question' } as never,
      'chain-bare',
    );
    await bare.handleChainEnd!({ answer: 'secret answer' } as never, 'chain-bare');
    const bareSpan = h.spans.getFinishedSpans()[0]!;
    expect(bareSpan.attributes[ATTR_INPUT_MESSAGES]).toBeDefined();
    expect(bareSpan.attributes[ATTR_OUTPUT_MESSAGES]).toBeDefined();

    const guarded = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'metadata_only',
    });
    await guarded.handleChainStart!(
      chainSerialized as never,
      { question: 'secret question' } as never,
      'chain-guarded',
    );
    await guarded.handleChainEnd!({ answer: 'secret answer' } as never, 'chain-guarded');
    const guardedSpan = h.spans.getFinishedSpans()[1]!;
    expect(guardedSpan.attributes[ATTR_INPUT_MESSAGES]).toBeUndefined();
    expect(guardedSpan.attributes[ATTR_OUTPUT_MESSAGES]).toBeUndefined();
  });
});

describe('LangChain adapter — graph as agent or workflow', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ agentName: 'shop-bot' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  async function topLevelGraph(runName: string, metadata: Record<string, unknown> = {}) {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      graphSerialized as never,
      {} as never,
      'g1',
      undefined,
      [],
      metadata,
      undefined,
      runName,
    );
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'g1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'g1');
    const spans = h.spans.getFinishedSpans();
    return {
      graph: spans.find((s) => s.attributes[ATTR_OPERATION_NAME] !== OP_CHAT)!,
      chat: spans.find((s) => s.attributes[ATTR_OPERATION_NAME] === OP_CHAT)!,
    };
  }

  it('records an unnamed plain graph as a workflow with no agent name', async () => {
    const { graph, chat } = await topLevelGraph('LangGraph');
    expect(graph.name).toBe('invoke_workflow');
    expect(graph.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_WORKFLOW);
    expect(graph.attributes).not.toHaveProperty(ATTR_AGENT_NAME);
    expect(graph.attributes).not.toHaveProperty(ATTR_WORKFLOW_NAME);
    expect(chat.parentSpanContext?.spanId).toBe(graph.spanContext().spanId);
    // Spans under a workflow fall back to the client's agent name, as anywhere else.
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('shop-bot');
  });

  it('names the workflow after a named plain graph', async () => {
    const { graph } = await topLevelGraph('rag');
    expect(graph.name).toBe('invoke_workflow rag');
    expect(graph.attributes[ATTR_WORKFLOW_NAME]).toBe('rag');
  });

  it('records a createAgent graph as an agent', async () => {
    const { graph, chat } = await topLevelGraph('support', createAgentMetadata);
    expect(graph.name).toBe('invoke_agent support');
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('support');
  });

  it('records a graph with "agent" in its name as an agent', async () => {
    const { graph } = await topLevelGraph('Research_Agent');
    expect(graph.name).toBe('invoke_agent Research_Agent');
  });

  it("gives a workflow and the spans under it the run's thread and user", async () => {
    const { graph, chat } = await topLevelGraph('rag', { thread_id: 't1', user_id: 'u1' });
    for (const span of [graph, chat]) {
      expect(span.attributes[ATTR_CONVERSATION_ID], span.name).toBe('t1');
      expect(span.attributes[ATTR_USER_ID], span.name).toBe('u1');
    }
  });

  it('records the graph input and output on the workflow span', async () => {
    await h.shutdown();
    h = createHarness({ contentCaptureMode: 'full' });
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      graphSerialized as never,
      { question: 'what is otel?' } as never,
      'g1',
      undefined,
      [],
      {},
      undefined,
      'LangGraph',
    );
    await handler.handleChainEnd!({ output: 'an answer' } as never, 'g1');

    const [graph] = h.spans.getFinishedSpans();
    expect(JSON.parse(graph!.attributes[ATTR_INPUT_MESSAGES] as string)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'what is otel?' }] },
    ]);
    expect(JSON.parse(graph!.attributes[ATTR_OUTPUT_MESSAGES] as string)).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'an answer' }], finish_reason: 'stop' },
    ]);
  });

  it('records a failed graph on the workflow span', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(graphSerialized as never, {} as never, 'g1');
    await handler.handleChainError!(new TypeError('bad state'), 'g1');

    const [graph] = h.spans.getFinishedSpans();
    expect(graph!.attributes[ATTR_OPERATION_NAME]).toBe(OP_INVOKE_WORKFLOW);
    expect(graph!.attributes['error.type']).toBe('TypeError');
    expect(h.openSpanCount()).toBe(0);
  });
});

describe('LangChain adapter — span nesting', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** name → { spanId, parentSpanId } for every finished span. */
  function byName() {
    const out = new Map<string, { id: string; parent?: string }>();
    for (const s of h.spans.getFinishedSpans()) {
      out.set(s.name, { id: s.spanContext().spanId, parent: s.parentSpanContext?.spanId });
    }
    return out;
  }

  it('parents a chat span under the chain that started it', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'c1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(2);
    // one trace, chat nested under invoke_agent
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const map = byName();
    const agent = [...map.entries()].find(([n]) => n.startsWith('invoke_agent'))![1];
    const chat = [...map.entries()].find(([n]) => n.startsWith('chat'))![1];
    expect(agent.parent).toBeUndefined();
    expect(chat.parent).toBe(agent.id);
  });

  it('walks past suppressed intermediate chains to the nearest ancestor span', async () => {
    // LangGraph shape: root chain (span) → node chain (suppressed) → llm / tool.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'root');
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'node', 'root');
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'node');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'node');
    await handler.handleToolEnd!('ok' as never, 't1');
    await handler.handleChainEnd!({} as never, 'node');
    await handler.handleChainEnd!({} as never, 'root');

    const spans = h.spans.getFinishedSpans();
    // node chain is suppressed, so 3 spans: invoke_agent + chat + execute_tool
    expect(spans.length).toBe(3);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const map = byName();
    const agent = [...map.entries()].find(([n]) => n.startsWith('invoke_agent'))![1];
    const chat = [...map.entries()].find(([n]) => n.startsWith('chat'))![1];
    const toolSpan = [...map.entries()].find(([n]) => n.startsWith('execute_tool'))![1];
    expect(chat.parent).toBe(agent.id);
    expect(toolSpan.parent).toBe(agent.id);
  });

  it('nests the legacy handleLLMStart path too', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleLLMStart!(llmSerialized as never, ['prompt'], 'l1', 'c1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'c1');

    const map = byName();
    const agent = [...map.entries()].find(([n]) => n.startsWith('invoke_agent'))![1];
    const chat = [...map.entries()].find(([n]) => n.startsWith('chat'))![1];
    expect(chat.parent).toBe(agent.id);
  });

  it('gives a named graph called from a tool its own agent span', async () => {
    // A supervisor agent whose tool invokes a researcher agent.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      graphSerialized as never,
      {},
      'outer',
      undefined,
      [],
      createAgentMetadata,
      undefined,
      'supervisor',
    );
    await handler.handleChainStart!(
      sequenceSerialized as never,
      {},
      'tools',
      'outer',
      [],
      {},
      undefined,
      'tools',
    );
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'tools');
    await handler.handleChainStart!(
      graphSerialized as never,
      {},
      'inner',
      't1',
      [],
      {},
      undefined,
      'researcher',
    );
    await handler.handleChainStart!(
      sequenceSerialized as never,
      {},
      'node',
      'inner',
      [],
      {},
      undefined,
      'model_request',
    );
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'node');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    for (const run of ['node', 'inner']) await handler.handleChainEnd!({} as never, run);
    await handler.handleToolEnd!('ok' as never, 't1');
    for (const run of ['tools', 'outer']) await handler.handleChainEnd!({} as never, run);

    const spans = h.spans.getFinishedSpans();
    expect(spans.map((s) => s.name).sort()).toEqual([
      'chat gpt-4o',
      'execute_tool search',
      'invoke_agent researcher',
      'invoke_agent supervisor',
    ]);
    const map = byName();
    expect(map.get('invoke_agent researcher')!.parent).toBe(map.get('execute_tool search')!.id);
    expect(map.get('chat gpt-4o')!.parent).toBe(map.get('invoke_agent researcher')!.id);
    const chat = spans.find((s) => s.name === 'chat gpt-4o')!;
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('researcher');
  });

  it('gives a named graph added as a node its own agent span', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      graphSerialized as never,
      {},
      'outer',
      undefined,
      [],
      {},
      undefined,
      'pipeline',
    );
    await handler.handleChainStart!(
      sequenceSerialized as never,
      {},
      'node',
      'outer',
      [],
      {},
      undefined,
      'research',
    );
    await handler.handleChainStart!(
      graphSerialized as never,
      {},
      'inner',
      'node',
      [],
      {},
      undefined,
      'researcher',
    );
    for (const run of ['inner', 'node', 'outer']) await handler.handleChainEnd!({} as never, run);

    const map = byName();
    expect([...map.keys()].sort()).toEqual(['invoke_agent researcher', 'invoke_workflow pipeline']);
    expect(map.get('invoke_agent researcher')!.parent).toBe(
      map.get('invoke_workflow pipeline')!.id,
    );
  });

  it('keeps an unnamed nested graph as a step of the outer graph', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      graphSerialized as never,
      {},
      'outer',
      undefined,
      [],
      {},
      undefined,
      'pipeline',
    );
    await handler.handleChainStart!(
      graphSerialized as never,
      {},
      'inner',
      'outer',
      [],
      {},
      undefined,
      'LangGraph',
    );
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'inner');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    for (const run of ['inner', 'outer']) await handler.handleChainEnd!({} as never, run);

    const map = byName();
    expect([...map.keys()].sort()).toEqual(['chat gpt-4o', 'invoke_workflow pipeline']);
    expect(map.get('chat gpt-4o')!.parent).toBe(map.get('invoke_workflow pipeline')!.id);
  });

  it('leaves a span with no ancestor as a root', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0]!.parentSpanContext?.spanId).toBeUndefined();
  });
});

describe('LangChain adapter — conversation id from LangGraph thread_id', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  const md = { thread_id: 'thread-42' };

  it('maps thread_id to gen_ai.conversation.id on chat, tool and chain spans', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1', undefined, [], md);
    await handler.handleChatModelStart!(
      llmSerialized as never,
      [[]] as never,
      'l1',
      'c1',
      {},
      [],
      md,
    );
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'c1', [], md);
    await handler.handleToolEnd!('ok' as never, 't1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.length).toBe(3);
    for (const s of spans) {
      expect(s.attributes[ATTR_CONVERSATION_ID]).toBe('thread-42');
    }
  });

  it("records the run's user_id metadata as user.id", async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const withUser = { ...md, user_id: 'user-7' };
    await handler.handleChainStart!(chainSerialized as never, {}, 'c1', undefined, [], withUser);
    await handler.handleChatModelStart!(
      llmSerialized as never,
      [[]] as never,
      'l1',
      'c1',
      {},
      [],
      withUser,
    );
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    expect(spans.map((s) => s.attributes[ATTR_USER_ID])).toEqual(['user-7', 'user-7']);
  });

  it("prefers the run's thread_id over a withConversationId scope", async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await withConversationId('ambient', async () => {
      await handler.handleChatModelStart!(
        llmSerialized as never,
        [[]] as never,
        'l1',
        undefined,
        {},
        [],
        md,
      );
      await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    });

    const span = h.spans.getFinishedSpans()[0]!;
    expect(span.attributes[ATTR_CONVERSATION_ID]).toBe('thread-42');
  });

  it('keeps per-run thread_id isolated when handle* is driven concurrently', async () => {
    // Regression (direct-call form): a single handler shared across two
    // concurrent runs under different scopes must tag each span with its own
    // run's thread_id, which beats the scope.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });

    const runA = withConversationId('ambient-A', async () => {
      await handler.handleChatModelStart!(
        llmSerialized as never,
        [[]] as never,
        'run-A',
        undefined,
        {},
        [],
        { thread_id: 'thread-A' },
      );
      await handler.handleLLMEnd!({ generations: [[{ text: 'a' }]] } as never, 'run-A');
    });
    const runB = withConversationId('ambient-B', async () => {
      await handler.handleChatModelStart!(
        llmSerialized as never,
        [[]] as never,
        'run-B',
        undefined,
        {},
        [],
        { thread_id: 'thread-B' },
      );
      await handler.handleLLMEnd!({ generations: [[{ text: 'b' }]] } as never, 'run-B');
    });
    await Promise.all([runA, runB]);

    const byId = new Map(
      h.spans
        .getFinishedSpans()
        .map((s) => [s.attributes[ATTR_CONVERSATION_ID] as string, s] as const),
    );
    expect([...byId.keys()].sort()).toEqual(['thread-A', 'thread-B']);
  });

  it('keeps conversation ids isolated across concurrent real RunnableLambda invokes', async () => {
    // Driven through the real callback manager, so each span must get its own
    // run's thread_id even with both runs in flight.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const echo = RunnableLambda.from(async (input: { q: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { answer: input.q };
    });

    const runA = withConversationId('ambient-A', () =>
      echo.invoke({ q: 'a' }, { callbacks: [handler], metadata: { thread_id: 'thread-A' } }),
    );
    const runB = withConversationId('ambient-B', () =>
      echo.invoke({ q: 'b' }, { callbacks: [handler], metadata: { thread_id: 'thread-B' } }),
    );
    await Promise.all([runA, runB]);

    const ids = h.spans
      .getFinishedSpans()
      .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT)
      .map((s) => s.attributes[ATTR_CONVERSATION_ID] as string)
      .sort();
    expect(ids).toEqual(['thread-A', 'thread-B']);
  });

  it('omits conversation.id when the run has no thread_id', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');

    const span = h.spans.getFinishedSpans()[0]!;
    expect(span.attributes[ATTR_CONVERSATION_ID]).toBeUndefined();
  });
});

describe('LangChain adapter — retriever lifecycle (retrieval span)', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('emits a CLIENT retrieval span and nests an in-retriever chat under it', async () => {
    // MultiQueryRetriever shape: chain → retriever (rewrites query with an LLM)
    // → chat. The desired tree is invoke_agent → retrieval → chat.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', 'c1');
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'r1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleRetrieverEnd!([] as never, 'r1');
    await handler.handleChainEnd!({} as never, 'c1');

    const spans = h.spans.getFinishedSpans();
    // invoke_agent + retrieval + chat
    expect(spans.length).toBe(3);
    expect(new Set(spans.map((s) => s.spanContext().traceId)).size).toBe(1);
    const agent = spans.find((s) => s.name.startsWith('invoke_agent'))!;
    const retrieval = spans.find((s) => s.name.startsWith('retrieval'))!;
    const chat = spans.find((s) => s.name.startsWith('chat'))!;
    expect(retrieval.attributes[ATTR_OPERATION_NAME]).toBe(OP_RETRIEVAL);
    expect(retrieval.kind).toBe(2 /* CLIENT */);
    expect(agent.parentSpanContext?.spanId).toBeUndefined();
    expect(retrieval.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(chat.parentSpanContext?.spanId).toBe(retrieval.spanContext().spanId);
  });

  it('records the query text, top_k, and returned documents', async () => {
    const handler = new GenAIOtelCallbackHandler({
      client: h.client,
      contentCapture: 'full',
    });
    const retrieverWithK = {
      ...retrieverSerialized,
      kwargs: { k: 3 },
    };
    await handler.handleRetrieverStart!(retrieverWithK as never, 'what is otel?', 'r1');
    await handler.handleRetrieverEnd!(
      [
        { pageContent: 'OTel is a spec', metadata: { source: 'a.md', score: 0.9 }, id: 'd1' },
        { pageContent: 'It defines spans', metadata: { source: 'b.md' } },
      ] as never,
      'r1',
    );

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.attributes[ATTR_RETRIEVAL_QUERY_TEXT]).toBe('what is otel?');
    expect(span.attributes[ATTR_RETRIEVAL_TOP_K]).toBe(3);
    const docs = JSON.parse(span.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string);
    expect(docs).toHaveLength(2);
    expect(docs[0]).toMatchObject({ id: 'd1', content: 'OTel is a spec', score: 0.9 });
    expect(docs[1]).toMatchObject({ content: 'It defines spans' });
  });

  it('does not stamp provider/model on the retrieval span from LangChain', async () => {
    const retrieverWithEmbeddings = {
      ...retrieverSerialized,
      kwargs: {
        vectorStore: {
          lc: 1,
          type: 'constructor',
          id: ['langchain', 'vectorstores', 'pinecone', 'PineconeStore'],
          kwargs: {
            embeddings: {
              lc: 1,
              type: 'constructor',
              id: ['langchain', 'embeddings', 'openai', 'OpenAIEmbeddings'],
              kwargs: { model: 'text-embedding-3-small' },
            },
          },
        },
      },
    };
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(retrieverWithEmbeddings as never, 'q', 'r1');
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.attributes[ATTR_PROVIDER_NAME]).toBeUndefined();
    expect(span.attributes[ATTR_REQUEST_MODEL]).toBeUndefined();
  });

  it('nests a retrieval span under a suppressed intermediate chain', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'root');
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'node', 'root');
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', 'node');
    await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'r1');
    await handler.handleToolEnd!('ok' as never, 't1');
    await handler.handleRetrieverEnd!([] as never, 'r1');
    await handler.handleChainEnd!({} as never, 'node');
    await handler.handleChainEnd!({} as never, 'root');

    const spans = h.spans.getFinishedSpans();
    // invoke_agent + retrieval + execute_tool
    expect(spans.length).toBe(3);
    const agent = spans.find((s) => s.name.startsWith('invoke_agent'))!;
    const retrieval = spans.find((s) => s.name.startsWith('retrieval'))!;
    const toolSpan = spans.find((s) => s.name.startsWith('execute_tool'))!;
    expect(retrieval.parentSpanContext?.spanId).toBe(agent.spanContext().spanId);
    expect(toolSpan.parentSpanContext?.spanId).toBe(retrieval.spanContext().spanId);
  });

  it('records a failed retrieval as provider_call_error and clears the edge', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', 'c1');
    await handler.handleRetrieverError!(new Error('boom') as never, 'r1');
    await handler.handleChainEnd!({} as never, 'c1');

    const retrieval = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(retrieval.attributes['error.type']).toBe('provider_call_error');

    // A later run reusing 'r1' as a parent finds no ancestor (edge cleared on
    // error) and starts its own root rather than attaching to a stale edge.
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'r1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    const chat = h.spans.getFinishedSpans().find((s) => s.name.startsWith('chat'))!;
    expect(chat.parentSpanContext?.spanId).toBeUndefined();
  });

  it('omits data_source.id and does not fabricate one from the class or run name', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(
      retrieverSerialized as never,
      'q',
      'r1',
      undefined,
      [],
      undefined,
      'my-retriever-run',
    );
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.name).toBe('retrieval');
    expect(span.attributes[ATTR_DATA_SOURCE_ID]).toBeUndefined();
  });

  it('does not read data_source.id from run metadata (no LangChain standard for it)', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', undefined, [], {
      data_source_id: 'docs-index',
      index: 42,
      namespace: 'tenant-a',
      collection: 'ui-widgets',
    });
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.name).toBe('retrieval');
    expect(span.attributes[ATTR_DATA_SOURCE_ID]).toBeUndefined();
  });

  it('reads data_source.id from a live nested Serializable (direct retriever.toJSON())', async () => {
    // LangChain hands retriever.toJSON() to the callback WITHOUT stringifying,
    // so the nested store stays a live Serializable — its config is under
    // lc_kwargs (camelCase), not a serialized `kwargs` object.
    const store = new FakeSerializable({ indexName: 'prod-index' });
    const retriever = new FakeSerializable({ vectorStore: store });
    const serialized = retriever.toJSON();
    // Sanity: the nested value is the live instance, with no `kwargs`.
    expect((serialized as any).kwargs.vector_store).toBe(store);
    expect((serialized as any).kwargs.vector_store.kwargs).toBeUndefined();

    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(serialized as never, 'q', 'r1');
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.attributes[ATTR_DATA_SOURCE_ID]).toBe('prod-index');
  });

  it('prefers the live store field over a stale constructor snapshot', async () => {
    // lc_kwargs is the constructor-time snapshot ('old'); the live instance field
    // ('new') is current and must win.
    const store = new FakeSerializable({ indexName: 'old' });
    (store as unknown as { indexName: string }).indexName = 'new';
    const retriever = new FakeSerializable({ vectorStore: store });

    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(retriever.toJSON() as never, 'q', 'r1');
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.attributes[ATTR_DATA_SOURCE_ID]).toBe('new');
  });

  it('reads data_source.id from a pre-serialized (snake_case) vector-store payload', async () => {
    const retrieverWithIndex = {
      ...retrieverSerialized,
      kwargs: { vector_store: { kwargs: { index_name: 'prod-index' } } },
    };
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(retrieverWithIndex as never, 'q', 'r1');
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.attributes[ATTR_DATA_SOURCE_ID]).toBe('prod-index');
  });

  it('does not read top_k from run metadata (no LangChain standard for it)', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1', undefined, [], {
      k: 99,
    });
    await handler.handleRetrieverEnd!([] as never, 'r1');

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    expect(span.attributes[ATTR_RETRIEVAL_TOP_K]).toBeUndefined();
  });

  it('does not map a raw vector distance to score', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client, contentCapture: 'full' });
    await handler.handleRetrieverStart!(retrieverSerialized as never, 'q', 'r1');
    await handler.handleRetrieverEnd!(
      [{ pageContent: 'doc', metadata: { _distance: 0.42, source: 'a.md' } }] as never,
      'r1',
    );

    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('retrieval'))!;
    const docs = JSON.parse(span.attributes[ATTR_RETRIEVAL_DOCUMENTS] as string);
    expect(docs[0].score).toBeUndefined();
    expect(docs[0].metadata._distance).toBe(0.42);
  });
});

describe('LangChain adapter — chain input messages on the agent span', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** Parsed gen_ai.input.messages off the single invoke_agent span. */
  function agentInput(): unknown {
    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'))!;
    const raw = span.attributes[ATTR_INPUT_MESSAGES];
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }

  it('maps a LangGraph `messages` channel through the BaseMessage mapping', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const inputs = {
      messages: [
        { _getType: () => 'system', content: 'be brief' },
        { _getType: () => 'human', content: 'what is 2+2?' },
      ],
    };
    await handler.handleChainStart!(chainSerialized as never, inputs as never, 'c1');
    await handler.handleChainEnd!({ output: '4' } as never, 'c1');

    expect(agentInput()).toEqual([
      { role: 'system', parts: [{ type: 'text', content: 'be brief' }] },
      { role: 'user', parts: [{ type: 'text', content: 'what is 2+2?' }] },
    ]);
  });

  it('maps a string `input` field to one user message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, { input: 'hello' } as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'hello' }] }]);
  });

  it('maps RetrievalQA-style `question` too', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, { question: 'why?' } as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toEqual([{ role: 'user', parts: [{ type: 'text', content: 'why?' }] }]);
  });

  it('falls back to JSON for an unrecognized shape', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, { foo: 42 } as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toEqual([
      { role: 'user', parts: [{ type: 'text', content: '{"foo":42}' }] },
    ]);
  });

  it('emits no input messages for an empty input', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentInput()).toBeUndefined();
  });
});

describe('LangChain adapter — callback dispatch mode', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('runs callbacks inline (awaitHandlers) so they inherit the caller context', () => {
    // With awaitHandlers on, LangChain executes the callbacks in the caller's
    // async context instead of on its shared background queue — the root cause
    // fix for cross-run context bleed (see concurrency test below).
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    expect(handler.awaitHandlers).toBe(true);
  });
});

describe('LangChain adapter — external parent isolation under concurrency', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('parents each concurrent invoke_agent under its own external OTel span', async () => {
    // The review scenario: two concurrent RunnableLambda.invoke() calls, each
    // under a different active OpenTelemetry span. On LangChain's shared
    // background queue both invoke_agent spans previously inherited whichever
    // request started queue processing. Running callbacks inline (awaitHandlers)
    // keeps each run's active context authoritative, so each agent span nests
    // under its own external parent and lands on its own trace.
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const tracer = h.tracerProvider.getTracer('test');
    const echo = RunnableLambda.from(async (input: { q: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      return { answer: input.q };
    });

    const extA = tracer.startSpan('ext-A');
    const extB = tracer.startSpan('ext-B');
    const runA = context.with(trace.setSpan(context.active(), extA), () =>
      echo.invoke({ q: 'a' }, { callbacks: [handler] }),
    );
    const runB = context.with(trace.setSpan(context.active(), extB), () =>
      echo.invoke({ q: 'b' }, { callbacks: [handler] }),
    );
    await Promise.all([runA, runB]);
    extA.end();
    extB.end();

    const agents = h.spans
      .getFinishedSpans()
      .filter((s) => s.attributes[ATTR_OPERATION_NAME] === OP_INVOKE_AGENT);
    expect(agents.length).toBe(2);

    // No cross-contamination: two distinct traces, each agent under its own ext.
    const byTrace = new Map(agents.map((s) => [s.spanContext().traceId, s] as const));
    expect(byTrace.size).toBe(2);
    const agentA = byTrace.get(extA.spanContext().traceId);
    const agentB = byTrace.get(extB.spanContext().traceId);
    expect(agentA?.parentSpanContext?.spanId).toBe(extA.spanContext().spanId);
    expect(agentB?.parentSpanContext?.spanId).toBe(extB.spanContext().spanId);
  });
});

describe('LangChain adapter — chain output messages on the agent span', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'no_tool_content' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  /** Parsed gen_ai.output.messages off the single invoke_agent span. */
  function agentOutput(): unknown {
    const span = h.spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'))!;
    const raw = span.attributes[ATTR_OUTPUT_MESSAGES];
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }

  it('maps a LangGraph `messages` channel to the final assistant message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    // Final graph state carries the whole conversation; only the last message
    // is the agent's answer — the human turn is already captured as input.
    const output = {
      messages: [
        { _getType: () => 'human', content: 'what is 2+2?' },
        { _getType: () => 'ai', content: '4' },
      ],
    };
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!(output as never, 'c1');

    expect(agentOutput()).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: '4' }], finish_reason: 'stop' },
    ]);
  });

  it('does not JSON-encode graph state when messages is empty', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({ messages: [], privateState: 'secret' } as never, 'c1');

    expect(agentOutput()).toBeUndefined();
  });

  it('does not JSON-encode graph state when the final message is unrenderable', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!(
      {
        messages: [{ _getType: () => 'ai', content: '' }],
        privateState: 'secret',
      } as never,
      'c1',
    );

    expect(agentOutput()).toBeUndefined();
  });

  it('maps a string `output` field to one assistant message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({ output: 'done' } as never, 'c1');

    expect(agentOutput()).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'done' }], finish_reason: 'stop' },
    ]);
  });

  it('falls back to JSON for an unrecognized shape', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({ foo: 42 } as never, 'c1');

    expect(agentOutput()).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: '{"foo":42}' }],
        finish_reason: 'stop',
      },
    ]);
  });

  it('emits no output messages for an empty output', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd!({} as never, 'c1');

    expect(agentOutput()).toBeUndefined();
  });
});

describe('LangChain adapter — identity', () => {
  let h: Harness;
  afterEach(async () => {
    await h.shutdown();
  });

  async function chainAndChat(handler: GenAIOtelCallbackHandler, runName?: string) {
    await handler.handleChainStart!(
      chainSerialized as never,
      {} as never,
      'c1',
      undefined,
      [],
      {},
      undefined,
      runName,
    );
    await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'c1');
    await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
    await handler.handleChainEnd!({} as never, 'c1');
    const spans = h.spans.getFinishedSpans();
    return {
      agent: spans.find((s) => s.name.startsWith('invoke_agent'))!,
      chat: spans.find((s) => s.name.startsWith('chat'))!,
    };
  }

  async function agentGraph(runName: string) {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    await handler.handleChainStart!(
      graphSerialized as never,
      {} as never,
      'g1',
      undefined,
      [],
      createAgentMetadata,
      undefined,
      runName,
    );
    await handler.handleChainEnd!({} as never, 'g1');
    return h.spans.getFinishedSpans()[0]!;
  }

  it("gives an unnamed chain the client's agent name, not the class name", async () => {
    h = createHarness({ agentName: 'shop-bot' });
    const { agent, chat } = await chainAndChat(new GenAIOtelCallbackHandler({ client: h.client }));
    expect(agent.attributes[ATTR_AGENT_NAME]).toBe('shop-bot');
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('shop-bot');
  });

  it("treats LangChain's default runName as no name", async () => {
    h = createHarness({ agentName: 'shop-bot' });
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const echo = RunnableLambda.from((x: unknown) => x);
    await echo.invoke({ q: 'hi' }, { callbacks: [handler] });
    await echo.withRetry().invoke({ q: 'hi' }, { callbacks: [handler] });
    const agents = h.spans.getFinishedSpans().filter((s) => s.name.startsWith('invoke_agent'));
    expect(agents.map((s) => s.attributes[ATTR_AGENT_NAME])).toEqual(['shop-bot', 'shop-bot']);
  });

  it('names an agent nothing names langchain, and the spans under it too', async () => {
    h = createHarness();
    const { agent, chat } = await chainAndChat(
      new GenAIOtelCallbackHandler({ client: h.client }),
      'RetrievalQA',
    );
    expect(agent.name).toBe('invoke_agent langchain');
    expect(chat.attributes[ATTR_AGENT_NAME]).toBe('langchain');
  });

  it('names an unnamed createAgent graph langchain', async () => {
    h = createHarness();
    expect((await agentGraph('LangGraph')).name).toBe('invoke_agent langchain');
  });

  it("treats LangGraph's default graph name as no name, and keeps a graph's own", async () => {
    h = createHarness({ agentName: 'shop-bot' });
    expect((await agentGraph('LangGraph')).attributes[ATTR_AGENT_NAME]).toBe('shop-bot');
    await h.shutdown();

    h = createHarness({ agentName: 'shop-bot' });
    expect((await agentGraph('support-graph')).name).toBe('invoke_agent support-graph');
  });

  it("gives chat and tool spans under a chain the chain's identity", async () => {
    h = createHarness();
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const md = { thread_id: 'thread-1', user_id: 'user-1' };
    await withAgent('outer-agent', '1.0', async () => {
      await handler.handleChainStart!(
        chainSerialized as never,
        {} as never,
        'c1',
        undefined,
        [],
        md,
        undefined,
        'checkout',
      );
      await handler.handleChatModelStart!(llmSerialized as never, [[]] as never, 'l1', 'c1');
      await handler.handleLLMEnd!({ generations: [[{ text: 'hi' }]] } as never, 'l1');
      await handler.handleToolStart!(toolSerialized as never, '{}', 't1', 'c1');
      await handler.handleToolEnd!('done', 't1');
      await handler.handleChainEnd!({} as never, 'c1');
    });

    for (const op of [OP_CHAT, OP_EXECUTE_TOOL]) {
      const span = h.spans
        .getFinishedSpans()
        .find((s) => s.attributes[ATTR_OPERATION_NAME] === op)!;
      expect(span.attributes[ATTR_AGENT_NAME], op).toBe('checkout');
      expect(span.attributes[ATTR_AGENT_VERSION], op).toBeUndefined();
      expect(span.attributes[ATTR_CONVERSATION_ID], op).toBe('thread-1');
      expect(span.attributes[ATTR_USER_ID], op).toBe('user-1');
    }
  });

  it("lets the run's own name beat the enclosing scope", async () => {
    h = createHarness();
    const { agent } = await withAgent('scoped-agent', '1.0', () =>
      chainAndChat(new GenAIOtelCallbackHandler({ client: h.client }), 'checkout'),
    );
    expect(agent.attributes[ATTR_AGENT_NAME]).toBe('checkout');
    expect(agent.attributes[ATTR_AGENT_VERSION]).toBeUndefined();
  });

  it('takes identity the run does not set from the enclosing scope', async () => {
    h = createHarness();
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const { agent, chat } = await withAgent('scoped-agent', '2', () =>
      withConversationId('scoped-conv', () =>
        withUserId('scoped-user', () => chainAndChat(handler)),
      ),
    );
    for (const span of [agent, chat]) {
      expect(span.attributes[ATTR_AGENT_NAME]).toBe('scoped-agent');
      expect(span.attributes[ATTR_AGENT_VERSION]).toBe('2');
      expect(span.attributes[ATTR_CONVERSATION_ID]).toBe('scoped-conv');
      expect(span.attributes[ATTR_USER_ID]).toBe('scoped-user');
    }
  });
});

describe('LangChain adapter — agent output never carries tool results', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness({ contentCaptureMode: 'full' });
  });
  afterEach(async () => {
    await h.shutdown();
  });

  const toolCall = { id: 'call-1', name: 'lookup_order', args: { order_id: '1001' } };
  const orderJson = '{"item":"Ethiopia Yirgacheffe, 1 kg","status":"delivered","total":38}';

  function agentSpan() {
    return h.spans.getFinishedSpans().find((s) => s.name.startsWith('invoke_agent'));
  }
  function agentOutput(): Array<{ role: string; parts: unknown[] }> | undefined {
    const raw = agentSpan()?.attributes[ATTR_OUTPUT_MESSAGES];
    return raw === undefined ? undefined : JSON.parse(raw as string);
  }

  it('uses the last AI message when the graph state ends on a ToolMessage', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    // e.g. a `returnDirect` tool, or an interrupt right after the tools node.
    const messages = [
      new HumanMessage('order id 1001, tell me the status'),
      new AIMessage({ content: '', tool_calls: [toolCall] }),
      new ToolMessage({ content: orderJson, tool_call_id: 'call-1', name: 'lookup_order' }),
    ];
    await handler.handleChainStart?.(chainSerialized as never, { messages } as never, 'c1');
    await handler.handleChainEnd?.({ messages } as never, 'c1');

    expect(agentOutput()).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call-1',
            name: 'lookup_order',
            arguments: { order_id: '1001' },
          },
        ],
        finish_reason: 'stop',
      },
    ]);
    // Inputs are history, so they keep the tool message.
    const input = JSON.parse(String(agentSpan()?.attributes[ATTR_INPUT_MESSAGES]));
    expect(input.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('emits no output when the trailing tool messages follow a non-AI message', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const messages = [
      new HumanMessage('hi'),
      new ToolMessage({ content: orderJson, tool_call_id: 'call-1' }),
    ];
    await handler.handleChainStart?.(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd?.({ messages } as never, 'c1');

    expect(agentOutput()).toBeUndefined();
  });

  it('emits no output for a chain whose output is a bare ToolMessage', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    // LangChain passes a returned message object through to handleChainEnd as is.
    const output = new ToolMessage({ content: orderJson, tool_call_id: 'call-1' });
    await handler.handleChainStart?.(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd?.(output as never, 'c1');

    expect(agentOutput()).toBeUndefined();
  });

  it('still maps the final AI answer after a tool round-trip', async () => {
    const handler = new GenAIOtelCallbackHandler({ client: h.client });
    const messages = [
      new HumanMessage('order id 1001, tell me the status'),
      new AIMessage({ content: '', tool_calls: [toolCall] }),
      new ToolMessage({ content: orderJson, tool_call_id: 'call-1' }),
      new AIMessage('Your order 1001 has been delivered!'),
    ];
    await handler.handleChainStart?.(chainSerialized as never, {} as never, 'c1');
    await handler.handleChainEnd?.({ messages } as never, 'c1');

    expect(agentOutput()).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'Your order 1001 has been delivered!' }],
        finish_reason: 'stop',
      },
    ]);
  });
});
