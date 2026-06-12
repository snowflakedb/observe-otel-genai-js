/**
 * BlobStore example.
 *
 * Sends a 100KB prompt through `startGeneration` with a `LocalFsBlobStore`
 * configured. The library offloads the full content to the filesystem and
 * the span event carries a `gen_ai.content.uri` attribute pointing at it.
 *
 * Run:
 *   pnpm exec tsx examples/blob-store/index.ts
 */

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  LocalFsBlobStore,
  defaultContentCapture,
  userTextMessage,
} from '../../src/index.js';
import { setupOtel } from '../_setup.js';

const otel = setupOtel('blob-store-example');

async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'genai-otel-blob-'));
  console.log(`[example] BlobStore root: ${dir}`);

  const client = new Client({
    contentCaptureMode: 'full',
    contentCapture: {
      ...defaultContentCapture(),
      maxContentLength: 4 * 1024,
      blobStore: new LocalFsBlobStore(dir),
    },
  });

  const longPrompt = `OpenTelemetry GenAI semantics: ${'x'.repeat(100 * 1024)}`;

  await using rec = client.startGeneration({
    model: { provider: 'openai', name: 'gpt-4o' },
    agentName: 'rag',
  });
  rec.setResult({
    input: [userTextMessage(longPrompt)],
    usage: { inputTokens: 30_000, outputTokens: 10 },
  });
}

await main();
await otel.shutdown();
