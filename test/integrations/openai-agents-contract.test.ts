/**
 * Compile-time conformance checks against the real `@openai/agents` types.
 *
 * `src/integrations/openai-agents/_sdk-types.ts` declares the SDK's tracing
 * shapes locally, so the published `.d.ts` does not force every consumer of
 * `@genai-otel/core` to install `@openai/agents`. The cost of that choice is that
 * nothing in `src/` is checked against the real SDK. This file is where that check
 * lives, against a dev-only dependency.
 *
 * `tsc` does the work here: if the SDK renames a field, changes `startedAt` from a
 * string to a number, or adds a required method to `TracingProcessor`, this file
 * stops compiling. Without it, such a change would surface as spans missing
 * attributes.
 */

import type {
  AgentSpanData,
  FunctionSpanData,
  GenerationSpanData,
  Model,
  ResponseSpanData,
  Span as SdkRealSpan,
  Trace as SdkRealTrace,
  SpanData,
  TracingProcessor,
} from '@openai/agents';

import { describe, expect, it } from 'vitest';

import type {
  SdkAgentSpanData,
  SdkFunctionSpanData,
  SdkGenerationSpanData,
  SdkModel,
  SdkResponseSpanData,
  SdkSpan,
  SdkTrace,
} from '../../src/integrations/openai-agents/_sdk-types.js';
import { parseSdkTimestamp } from '../../src/integrations/openai-agents/_sdk-types.js';
import { GenAIOtelTracingProcessor } from '../../src/integrations/openai-agents/index.js';

/** Fails to compile unless `T` is assignable to `U`. */
type Extends<T extends U, U> = T;

// -----------------------------------------------------------------------------
// The processor satisfies the SDK's own interface
// -----------------------------------------------------------------------------

// `addTraceProcessor(p)` only accepts a `TracingProcessor`, so if our class
// drifts from that contract the integration cannot be registered at all.
type _ProcessorConforms = Extends<GenAIOtelTracingProcessor, TracingProcessor>;

// -----------------------------------------------------------------------------
// Real SDK span/trace objects are accepted where we declare our own shapes
// -----------------------------------------------------------------------------

// Direction matters: we consume the SDK's types, so they have to be assignable to
// ours. Ours name a subset of fields on purpose, so the reverse check would fail
// on every field we leave out.
type _SpanAccepted = Extends<SdkRealSpan<SpanData>, SdkSpan>;
type _TraceAccepted = Extends<SdkRealTrace, SdkTrace>;

type _AgentAccepted = Extends<AgentSpanData, SdkAgentSpanData>;
type _FunctionAccepted = Extends<FunctionSpanData, SdkFunctionSpanData>;
type _GenerationAccepted = Extends<GenerationSpanData, SdkGenerationSpanData>;
type _ResponseAccepted = Extends<ResponseSpanData, SdkResponseSpanData>;
type _ModelAccepted = Extends<Model, SdkModel>;

describe('openai-agents SDK contract', () => {
  it('keeps the type-level conformance checks referenced', () => {
    // The checks above are erased at runtime; this keeps `noUnusedLocals` from
    // deleting the file's whole purpose and gives the suite something to report.
    const checks: Array<
      | _ProcessorConforms
      | _SpanAccepted
      | _TraceAccepted
      | _AgentAccepted
      | _FunctionAccepted
      | _GenerationAccepted
      | _ResponseAccepted
      | _ModelAccepted
      | undefined
    > = [undefined];
    expect(checks).toHaveLength(1);
  });

  it('implements every method the SDK requires of a processor', () => {
    // A structural belt to the type-level braces. The SDK calls
    // `TracingProcessor` methods through a plain object reference, so a missing
    // one surfaces as a runtime TypeError, with no compile error at the call site.
    const processor = new GenAIOtelTracingProcessor();
    for (const method of [
      'onTraceStart',
      'onTraceEnd',
      'onSpanStart',
      'onSpanEnd',
      'shutdown',
      'forceFlush',
    ] as const) {
      expect(typeof processor[method], `${method} must be callable`).toBe('function');
    }
  });

  it('parses the SDK timestamp format, including sub-millisecond precision', () => {
    // `startedAt` / `endedAt` are ISO-8601 *strings* with sub-millisecond
    // precision. Read as epoch numbers they put every span at the epoch or at
    // `Invalid Date`.
    expect(parseSdkTimestamp('2026-09-11T04:05:06.789Z')).toBe(
      Date.parse('2026-09-11T04:05:06.789Z'),
    );
    expect(parseSdkTimestamp('2026-09-11T04:05:06.7891234Z')).toBeGreaterThan(0);
    expect(parseSdkTimestamp(null)).toBeUndefined();
    expect(parseSdkTimestamp('not a date')).toBeUndefined();
  });
});
