/**
 * Serializes the library's internal `ToolDefinition[]` into the OpenTelemetry
 * GenAI semantic-conventions Tool Definitions shape used by the
 * `gen_ai.tool.definitions` attribute.
 *
 * The published JSON schema requires BOTH `type` and `name`; `description` and
 * `parameters` are optional and — because the list can be large and carries
 * business detail — MUST NOT be populated unless content capture is enabled:
 *   https://opentelemetry.io/docs/specs/semconv/gen-ai/
 *
 * So the serializer always emits `{ type, name }` and only adds `description`
 * and `parameters` when `includeContent` is true (the caller passes this based
 * on the resolved content-capture mode — `full` vs `no_tool_content`).
 *
 * As with the message serializers, the output here is the *structured* JS value
 * (array of maps); the content sink owns the structured-vs-JSON-string decision.
 *
 * Field mapping (`ToolDefinition` -> semconv definition):
 *   type            -> type (required; defaults to "function" when unset)
 *   name            -> name (required; entries without one are dropped)
 *   description     -> description (content; only when includeContent)
 *   inputSchemaJson -> parameters (content; parsed JSON; only when includeContent)
 */

import type { ToolDefinition } from '../models/generation.js';

/** A single semconv tool definition entry. `type` + `name` are always present. */
export interface SemconvToolDefinition {
  type: string;
  name: string;
  description?: string;
  parameters?: unknown;
}

/** Default tool type — the cross-provider client-side function-tool shape. */
const DEFAULT_TOOL_TYPE = 'function';

/**
 * Best-effort parse of a JSON string into a structured value. Returns the raw
 * string when it does not parse (the spec allows opaque content), so we never
 * throw while building telemetry.
 */
function parseJsonOrRaw(value: string | undefined): unknown {
  if (value == null || value === '') return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function definitionToSemconv(
  tool: ToolDefinition,
  includeContent: boolean,
): SemconvToolDefinition | undefined {
  const name = tool.name;
  if (typeof name !== 'string' || name.length === 0) return undefined;
  // `type` and `name` are always required by the schema; keep both even when
  // content is stripped, so tool topology stays visible.
  const type = tool.type && tool.type.length > 0 ? tool.type : DEFAULT_TOOL_TYPE;
  const out: SemconvToolDefinition = { type, name };
  if (!includeContent) return out;
  if (tool.description && tool.description.length > 0) out.description = tool.description;
  const parameters = parseJsonOrRaw(tool.inputSchemaJson);
  if (parameters !== undefined) out.parameters = parameters;
  return out;
}

/**
 * Converts the bound tool list into the `gen_ai.tool.definitions` shape.
 * `type` and `name` are always emitted; the sensitive `description` /
 * `parameters` only when `includeContent` is true (defaults to `false` so
 * callers are privacy-safe). Nameless definitions are dropped.
 */
export function toToolDefinitions(
  tools: readonly ToolDefinition[] | undefined,
  includeContent = false,
): SemconvToolDefinition[] {
  if (!tools || tools.length === 0) return [];
  return tools
    .map((tool) => definitionToSemconv(tool, includeContent))
    .filter((t): t is SemconvToolDefinition => t !== undefined);
}
