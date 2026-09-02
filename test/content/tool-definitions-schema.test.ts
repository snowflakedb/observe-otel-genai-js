import { describe, expect, it } from 'vitest';
import { toToolDefinitions } from '../../src/content/tool-definitions-schema.js';
import type { ToolDefinition } from '../../src/models/generation.js';

describe('tool-definitions-schema: toToolDefinitions', () => {
  it('emits type + name and parses inputSchemaJson into parameters (content included)', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        type: 'function',
        description: 'Return current weather for a city',
        inputSchemaJson: JSON.stringify({
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        }),
      },
    ];
    expect(toToolDefinitions(tools, true)).toEqual([
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

  it('defaults type to "function" when the definition has none', () => {
    const tools: ToolDefinition[] = [{ name: 'ping' }];
    expect(toToolDefinitions(tools, true)).toEqual([{ type: 'function', name: 'ping' }]);
  });

  it('preserves a non-default type', () => {
    const tools: ToolDefinition[] = [{ name: 'search', type: 'extension' }];
    expect(toToolDefinitions(tools, true)).toEqual([{ type: 'extension', name: 'search' }]);
  });

  it('withholds description and parameters when content is not included', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Return current weather for a city',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
      },
    ];
    // Only the schema-required, non-sensitive fields survive.
    expect(toToolDefinitions(tools, false)).toEqual([{ type: 'function', name: 'get_weather' }]);
  });

  it('is privacy-safe by default: a one-argument call strips content', () => {
    const tools: ToolDefinition[] = [
      {
        name: 'get_weather',
        description: 'Return current weather for a city',
        inputSchemaJson: JSON.stringify({ type: 'object' }),
      },
    ];
    // No explicit includeContent — external callers must opt in to get schemas.
    expect(toToolDefinitions(tools)).toEqual([{ type: 'function', name: 'get_weather' }]);
  });

  it('drops entries without a name (required by the schema)', () => {
    const tools = [{ name: '' }, { description: 'no name' }, { name: 'ok' }] as ToolDefinition[];
    expect(toToolDefinitions(tools, true)).toEqual([{ type: 'function', name: 'ok' }]);
  });

  it('keeps an unparseable schema as a raw string rather than throwing', () => {
    const tools: ToolDefinition[] = [{ name: 't', inputSchemaJson: 'not json' }];
    expect(toToolDefinitions(tools, true)).toEqual([
      { type: 'function', name: 't', parameters: 'not json' },
    ]);
  });

  it('returns [] for empty or missing input', () => {
    expect(toToolDefinitions(undefined, true)).toEqual([]);
    expect(toToolDefinitions([], false)).toEqual([]);
  });
});
