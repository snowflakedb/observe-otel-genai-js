import { describe, expect, it } from 'vitest';
import type { Generation } from '../src/models/generation.js';
import { createSecretRedactionSanitizer } from '../src/sanitizers/secret.js';

const baseGeneration = (over: Partial<Generation> = {}): Generation => ({
  systemPrompt: '',
  input: [],
  output: [],
  ...over,
});

describe('createSecretRedactionSanitizer', () => {
  it('redacts OpenAI keys in the system prompt', async () => {
    const sanitize = createSecretRedactionSanitizer();
    const out = (await sanitize(
      baseGeneration({
        systemPrompt: 'config: sk-proj-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      }),
    )) as Generation;
    expect(out.systemPrompt).toBe('config: [REDACTED:openai-project-key]');
  });

  it('redacts bearer tokens', async () => {
    const sanitize = createSecretRedactionSanitizer();
    const out = (await sanitize(
      baseGeneration({ systemPrompt: 'Bearer abcdefghijklmnopqrstuvwxyz0123' }),
    )) as Generation;
    expect(out.systemPrompt).toContain('[REDACTED:bearer-token]');
  });

  it('redacts emails by default; can be disabled', async () => {
    const def = createSecretRedactionSanitizer();
    const noEmail = createSecretRedactionSanitizer({ redactEmailAddresses: false });
    const o1 = (await def(
      baseGeneration({ systemPrompt: 'ping me at alice@example.com' }),
    )) as Generation;
    const o2 = (await noEmail(
      baseGeneration({ systemPrompt: 'ping me at alice@example.com' }),
    )) as Generation;
    expect(o1.systemPrompt).toContain('[REDACTED:email]');
    expect(o2.systemPrompt).toBe('ping me at alice@example.com');
  });

  it('redacts tool result content with full mode', async () => {
    const sanitize = createSecretRedactionSanitizer();
    const out = (await sanitize(
      baseGeneration({
        output: [
          {
            role: 'tool',
            parts: [
              {
                kind: 'tool_result',
                toolResult: {
                  content: 'API_KEY=secret-token-value',
                },
              },
            ],
          },
        ],
      }),
    )) as Generation;
    const part = out.output![0]!.parts[0]!;
    expect(part.toolResult?.content).toContain('[REDACTED:env-secret-value]');
  });

  it('skips input messages by default', async () => {
    const sanitize = createSecretRedactionSanitizer();
    const out = (await sanitize(
      baseGeneration({
        input: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: `my token is sk-ant-api03-${'a'.repeat(93)}AA` }],
          },
        ],
      }),
    )) as Generation;
    const userText = out.input![0]!.parts[0]!.text!;
    // Input is untouched when redactInputMessages=false (default).
    expect(userText).toContain('sk-ant-api03-');
  });

  it('redacts input messages when opted in', async () => {
    const sanitize = createSecretRedactionSanitizer({ redactInputMessages: true });
    const out = (await sanitize(
      baseGeneration({
        input: [
          {
            role: 'user',
            parts: [{ kind: 'text', text: `my token is sk-ant-api03-${'a'.repeat(93)}AA` }],
          },
        ],
      }),
    )) as Generation;
    const userText = out.input![0]!.parts[0]!.text!;
    expect(userText).toContain('[REDACTED:anthropic-api-key]');
  });

  it('uses light redaction on assistant output (no tier 2)', async () => {
    const sanitize = createSecretRedactionSanitizer();
    const out = (await sanitize(
      baseGeneration({
        output: [
          {
            role: 'assistant',
            parts: [{ kind: 'text', text: 'set API_KEY=plain in the .env file (do not commit)' }],
          },
        ],
      }),
    )) as Generation;
    const text = out.output![0]!.parts[0]!.text!;
    // Tier 2 ENV pattern should NOT have fired on assistant text.
    expect(text).toContain('API_KEY=plain');
  });

  it('does not mutate the original generation when redactInputMessages=false', async () => {
    const sanitize = createSecretRedactionSanitizer();
    const original = baseGeneration({
      systemPrompt: `bearer abcdefghijklmnopqrst${'X'.repeat(20)}`,
      input: [
        {
          role: 'user',
          parts: [{ kind: 'text', text: `secret sk-ant-api03-${'a'.repeat(93)}AA` }],
        },
      ],
      output: [
        {
          role: 'assistant',
          parts: [{ kind: 'text', text: 'no secrets here' }],
        },
      ],
    });
    const snapshot = JSON.parse(JSON.stringify(original));

    await sanitize(original);

    // Original must be unchanged.
    expect(original.systemPrompt).toBe(snapshot.systemPrompt);
    expect(original.input![0]!.parts[0]!.text).toBe(snapshot.input[0].parts[0].text);
    expect(original.output![0]!.parts[0]!.text).toBe(snapshot.output[0].parts[0].text);
  });
});
