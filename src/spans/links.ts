/**
 * Bounded in-memory map from generation_id → SpanContext, used to convert
 * a list of parent generation ids (strings) into native OTel span links.
 *
 * - Entries are added when a recorder starts and we know both the generation
 *   id and the active span's context.
 * - Entries expire after `ttlMs` (default 5 min) and the map is capped at
 *   `maxEntries` (default 10k) via LRU eviction.
 * - `resolveLinks` takes a mixed list of strings + SpanContext-like objects
 *   and returns a list of OTel `Link` records. Misses are silently skipped
 *   (still emitted as the `genai.parent_generation_ids` attribute by the
 *   caller as a fallback).
 *
 * Process-local by design: cross-process linkage requires the caller to
 * propagate `traceparent` themselves and pass the resulting `SpanContext` to
 * `parentGenerationIds`.
 */

import type { Link, SpanContext } from '@opentelemetry/api';
import { TraceFlags } from '@opentelemetry/api';
import type { Logger, SpanLinkMapConfig } from '../config.js';
import type { ParentGenerationRef, SpanContextLike } from '../models/generation.js';

interface Entry {
  ctx: SpanContext;
  /** epoch ms when the entry expires. */
  expiresAt: number;
}

export class SpanLinkMap {
  private readonly map = new Map<string, Entry>();
  private readonly config: SpanLinkMapConfig;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(config: SpanLinkMapConfig, now: () => number, logger: Logger) {
    this.config = config;
    this.now = now;
    this.logger = logger;
  }

  set(generationId: string, ctx: SpanContext): void {
    if (!generationId || !ctx.traceId || !ctx.spanId) return;
    const expiresAt = this.now() + this.config.ttlMs;
    // Touch-on-write: re-insertion moves entry to most-recently-used position.
    this.map.delete(generationId);
    this.map.set(generationId, { ctx, expiresAt });
    // Evict LRU entries until we are back at or under the cap. Map iteration
    // order is insertion order, so the first key is least-recently-used.
    while (this.map.size > this.config.maxEntries) {
      const lru = this.map.keys().next().value;
      if (lru === undefined) break;
      this.map.delete(lru);
      this.logger.debug?.('genai-otel: span-link map evicted LRU entry', { key: lru });
    }
  }

  get(generationId: string): SpanContext | undefined {
    const entry = this.map.get(generationId);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.map.delete(generationId);
      this.logger.debug?.('genai-otel: span-link map evicted expired entry', { generationId });
      return undefined;
    }
    // Touch-on-read: refresh LRU position so hot entries stay alive.
    this.map.delete(generationId);
    this.map.set(generationId, entry);
    return entry.ctx;
  }

  /**
   * Resolves a mixed list of parent references into OTel `Link` records.
   * Returns the resolved links and the (string-form) ids of every parent so
   * the caller can still emit the fallback `genai.parent_generation_ids`
   * attribute.
   */
  resolveLinks(refs: readonly ParentGenerationRef[] | undefined): {
    links: Link[];
    parentIds: string[];
  } {
    const links: Link[] = [];
    const parentIds: string[] = [];
    if (!refs || refs.length === 0) return { links, parentIds };

    for (const ref of refs) {
      if (typeof ref === 'string') {
        parentIds.push(ref);
        const ctx = this.get(ref);
        if (ctx) links.push({ context: ctx, attributes: { 'gen_ai.relationship': 'depends_on' } });
      } else if (ref != null) {
        const ctx = toSpanContext(ref);
        if (ctx) {
          links.push({ context: ctx, attributes: { 'gen_ai.relationship': 'depends_on' } });
          parentIds.push(`${ctx.traceId}:${ctx.spanId}`);
        }
      }
    }
    return { links, parentIds };
  }

  size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

function toSpanContext(value: SpanContextLike): SpanContext | undefined {
  if (!value || !value.traceId || !value.spanId) return undefined;
  // We intentionally drop tracestate when constructing from a structural
  // input; callers who need full fidelity should pass an actual SpanContext
  // (which they get from `span.spanContext()`).
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    traceFlags: value.traceFlags ?? TraceFlags.SAMPLED,
    isRemote: value.isRemote ?? true,
  };
}
