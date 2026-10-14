/**
 * The `allow_list` content mode. Spans started under it are wrapped in an
 * `AllowListSpan`, which forwards only what the allowlist permits:
 *
 * - Attributes (on the span, its events, and its links) keep only keys in
 *   `CONTENT_ALLOW_LIST`.
 * - Exceptions keep only `exception.type`; the message and stack trace can quote
 *   the input that caused them.
 * - Status keeps its code and drops the message, for the same reason.
 */

import type {
  AttributeValue,
  Attributes,
  Exception,
  Link,
  Span,
  SpanContext,
  SpanOptions,
  SpanStatus,
  TimeInput,
} from '@opentelemetry/api';

/**
 * Span attribute keys kept under the `allow_list` content mode. Matching is by
 * exact key; anything not listed is dropped.
 *
 * Adding a key needs a privacy review. The Python SDK (observe-otel-genai-python,
 * `_content_allow_list.json`) applies the same list, so change both together.
 */
export const CONTENT_ALLOW_LIST: ReadonlySet<string> = new Set([
  'error.category',
  'error.type',
  'exception.type',
  'gen_ai.agent.description',
  'gen_ai.agent.id',
  'gen_ai.agent.name',
  'gen_ai.agent.version',
  'gen_ai.conversation.id',
  'gen_ai.operation.name',
  'gen_ai.output.type',
  'gen_ai.provider.name',
  'gen_ai.request.choice.count',
  'gen_ai.request.encoding_formats',
  'gen_ai.request.frequency_penalty',
  'gen_ai.request.max_tokens',
  'gen_ai.request.model',
  'gen_ai.request.presence_penalty',
  'gen_ai.request.seed',
  'gen_ai.request.stream',
  'gen_ai.request.temperature',
  'gen_ai.request.thinking.budget_tokens',
  'gen_ai.request.thinking.enabled',
  'gen_ai.request.tool_choice',
  'gen_ai.request.top_p',
  'gen_ai.response.finish_reasons',
  'gen_ai.response.id',
  'gen_ai.response.model',
  'gen_ai.token.type',
  'gen_ai.tool.call.id',
  'gen_ai.tool.description',
  'gen_ai.tool.name',
  'gen_ai.tool.type',
  'gen_ai.usage.cache_creation.input_tokens',
  'gen_ai.usage.cache_read.input_tokens',
  'gen_ai.usage.input_tokens',
  'gen_ai.usage.output_tokens',
  'gen_ai.usage.reasoning.output_tokens',
  'genai.conversation.turn_index',
  'genai.conversation.turn_role',
  'genai.generation.id',
  'genai.parent_generation_ids',
  'genai.sdk.name',
  'server.address',
  'server.port',
  'user.id',
]);

export class AllowListSpan implements Span {
  constructor(private readonly inner: Span) {}

  spanContext(): SpanContext {
    return this.inner.spanContext();
  }

  setAttribute(key: string, value: AttributeValue): this {
    if (CONTENT_ALLOW_LIST.has(key)) this.inner.setAttribute(key, value);
    return this;
  }

  setAttributes(attributes: Attributes): this {
    this.inner.setAttributes(filterAttributes(attributes));
    return this;
  }

  addEvent(
    name: string,
    attributesOrStartTime?: Attributes | TimeInput,
    startTime?: TimeInput,
  ): this {
    if (attributesOrStartTime === undefined || isTimeInput(attributesOrStartTime)) {
      this.inner.addEvent(name, attributesOrStartTime, startTime);
    } else {
      this.inner.addEvent(name, filterAttributes(attributesOrStartTime), startTime);
    }
    return this;
  }

  addLink(link: Link): this {
    this.inner.addLink(filterLink(link));
    return this;
  }

  addLinks(links: Link[]): this {
    this.inner.addLinks(links.map(filterLink));
    return this;
  }

  setStatus(status: SpanStatus): this {
    this.inner.setStatus({ code: status.code });
    return this;
  }

  updateName(name: string): this {
    this.inner.updateName(name);
    return this;
  }

  end(endTime?: TimeInput): void {
    this.inner.end(endTime);
  }

  isRecording(): boolean {
    return this.inner.isRecording();
  }

  recordException(exception: Exception, time?: TimeInput): void {
    const type = exceptionType(exception);
    if (type) this.inner.addEvent('exception', { 'exception.type': type }, time);
  }
}

/** The `exception.type` the OTel SDK would record: the error code, else its name. */
function exceptionType(exception: Exception): string | undefined {
  if (typeof exception === 'string') return undefined;
  const type = exception.code || exception.name;
  return type ? String(type) : undefined;
}

/** Filters the attributes and links passed when the span is started. */
export function allowListSpanOptions(options: SpanOptions): SpanOptions {
  return {
    ...options,
    attributes: options.attributes && filterAttributes(options.attributes),
    links: options.links?.map(filterLink),
  };
}

function filterAttributes(attributes: Attributes): Attributes {
  const kept: Attributes = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (CONTENT_ALLOW_LIST.has(key)) kept[key] = value;
  }
  return kept;
}

function filterLink(link: Link): Link {
  return link.attributes ? { ...link, attributes: filterAttributes(link.attributes) } : link;
}

function isTimeInput(value: Attributes | TimeInput): value is TimeInput {
  return typeof value === 'number' || value instanceof Date || Array.isArray(value);
}
