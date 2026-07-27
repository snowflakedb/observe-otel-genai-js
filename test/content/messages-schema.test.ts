import { describe, expect, it } from 'vitest';
import {
  resolveFinishReason,
  toSemconvInputMessages,
  toSemconvOutputMessages,
  toSystemInstructions,
} from '../../src/content/messages-schema.js';
import type { Message } from '../../src/models/message.js';

describe('messages-schema: toSemconvInputMessages', () => {
  it('maps text parts to {type:text, content}', () => {
    const msgs: Message[] = [{ role: 'user', parts: [{ kind: 'text', text: 'hello' }] }];
    expect(toSemconvInputMessages(msgs)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'hello' }] },
    ]);
  });

  it('maps thinking parts to {type:reasoning, content}', () => {
    const msgs: Message[] = [{ role: 'assistant', parts: [{ kind: 'thinking', thinking: 'hmm' }] }];
    expect(toSemconvInputMessages(msgs)).toEqual([
      { role: 'assistant', parts: [{ type: 'reasoning', content: 'hmm' }] },
    ]);
  });

  it('maps tool_call parts and parses inputJson into structured arguments', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        parts: [
          {
            kind: 'tool_call',
            toolCall: { id: 'call_1', name: 'get_weather', inputJson: '{"location":"Paris"}' },
          },
        ],
      },
    ];
    expect(toSemconvInputMessages(msgs)).toEqual([
      {
        role: 'assistant',
        parts: [
          {
            type: 'tool_call',
            id: 'call_1',
            name: 'get_weather',
            arguments: { location: 'Paris' },
          },
        ],
      },
    ]);
  });

  it('keeps raw string when tool_call arguments are not valid JSON', () => {
    const msgs: Message[] = [
      {
        role: 'assistant',
        parts: [{ kind: 'tool_call', toolCall: { name: 't', inputJson: 'not json' } }],
      },
    ];
    const [m] = toSemconvInputMessages(msgs);
    expect(m?.parts[0]).toEqual({ type: 'tool_call', name: 't', arguments: 'not json' });
  });

  it('maps tool_result parts to {type:tool_call_response, id, response}', () => {
    const msgs: Message[] = [
      {
        role: 'tool',
        parts: [{ kind: 'tool_result', toolResult: { toolCallId: 'call_1', content: 'rainy' } }],
      },
    ];
    expect(toSemconvInputMessages(msgs)).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: 'rainy' }],
      },
    ]);
  });

  it('emits response:null when a tool_result has no value (spec requires response)', () => {
    const msgs: Message[] = [
      { role: 'tool', parts: [{ kind: 'tool_result', toolResult: { toolCallId: 'call_1' } }] },
    ];
    expect(toSemconvInputMessages(msgs)).toEqual([
      {
        role: 'tool',
        parts: [{ type: 'tool_call_response', id: 'call_1', response: null }],
      },
    ]);
  });

  it('drops messages with no renderable parts', () => {
    const msgs: Message[] = [
      { role: 'user', parts: [{ kind: 'text', text: '' }] },
      { role: 'user', parts: [{ kind: 'text', text: 'keep' }] },
    ];
    expect(toSemconvInputMessages(msgs)).toEqual([
      { role: 'user', parts: [{ type: 'text', content: 'keep' }] },
    ]);
  });

  it('returns [] for empty/undefined', () => {
    expect(toSemconvInputMessages(undefined)).toEqual([]);
    expect(toSemconvInputMessages([])).toEqual([]);
  });
});

describe('messages-schema: toSemconvOutputMessages', () => {
  it('attaches finish_reason to each output message when provided', () => {
    const msgs: Message[] = [
      { role: 'assistant', parts: [{ kind: 'text', text: 'a' }] },
      { role: 'assistant', parts: [{ kind: 'text', text: 'b' }] },
    ];
    expect(toSemconvOutputMessages(msgs, 'stop')).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'a' }], finish_reason: 'stop' },
      { role: 'assistant', parts: [{ type: 'text', content: 'b' }], finish_reason: 'stop' },
    ]);
  });

  it('derives finish_reason from error state when not provided', () => {
    const msgs: Message[] = [{ role: 'assistant', parts: [{ kind: 'text', text: 'a' }] }];
    expect(toSemconvOutputMessages(msgs, resolveFinishReason(undefined, false))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'a' }], finish_reason: 'stop' },
    ]);
    expect(toSemconvOutputMessages(msgs, resolveFinishReason(undefined, true))).toEqual([
      { role: 'assistant', parts: [{ type: 'text', content: 'a' }], finish_reason: 'error' },
    ]);
  });
});

describe('messages-schema: resolveFinishReason', () => {
  it('prefers the real reason, else derives from error state', () => {
    expect(resolveFinishReason('length', false)).toBe('length');
    expect(resolveFinishReason('length', true)).toBe('length');
    expect(resolveFinishReason(undefined, false)).toBe('stop');
    expect(resolveFinishReason('', false)).toBe('stop');
    expect(resolveFinishReason(undefined, true)).toBe('error');
  });
});

describe('messages-schema: toSystemInstructions', () => {
  it('wraps a system prompt into a flat text-part list', () => {
    expect(toSystemInstructions('be nice')).toEqual([{ type: 'text', content: 'be nice' }]);
  });
  it('returns [] for empty/whitespace', () => {
    expect(toSystemInstructions('')).toEqual([]);
    expect(toSystemInstructions('   ')).toEqual([]);
    expect(toSystemInstructions(undefined)).toEqual([]);
  });
});
