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

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClientShutdownError } from '../src/errors.js';
import { type Harness, createHarness } from './_harness.js';

describe('Client lifecycle', () => {
  let h: Harness;
  beforeEach(() => {
    h = createHarness();
  });
  afterEach(async () => {
    await h.shutdown();
  });

  it('flush() returns without throwing', async () => {
    await h.client.flush();
  });

  it('shutdown() is idempotent', async () => {
    await h.client.shutdown();
    await h.client.shutdown();
  });

  it('startGeneration after shutdown throws ClientShutdownError', async () => {
    await h.client.shutdown();
    expect(() => h.client.startGeneration({ model: { provider: 'p', name: 'm' } })).toThrow(
      ClientShutdownError,
    );
  });

  it('await using client triggers shutdown on scope exit', async () => {
    let outerClient: { closed?: boolean } | undefined;
    {
      await using client = (await import('../src/client.js')).Client.prototype.constructor
        ? new (await import('../src/client.js')).Client()
        : (h.client as never);
      // Sanity touch
      const rec = client.startGeneration({ model: { provider: 'p', name: 'm' } });
      await rec.end();
      outerClient = client as unknown as { closed?: boolean };
    }
    // closed is private — best we can do is verify subsequent ops throw.
    expect(() =>
      (outerClient as unknown as import('../src/client.js').Client).startGeneration({
        model: { provider: 'p', name: 'm' },
      }),
    ).toThrow(ClientShutdownError);
  });
});
