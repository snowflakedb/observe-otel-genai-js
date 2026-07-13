/**
 * Shared per-call metadata plumbing for OpenAI / Anthropic adapters.
 *
 * Both providers expose a single `create(params)` entry point and don't have
 * a place to hand metadata in. We attach it under a non-enumerable Symbol on
 * the params object so the proxy can pick it up before forwarding the call.
 *
 * The Symbol is stripped before the params reach the underlying SDK so it
 * never leaks into the wire request.
 */

import type { ContentCaptureMode } from '../../content/capture.js';
import type { GenerationStart, ParentGenerationRef } from '../../models/generation.js';

/** Common per-call metadata shape shared by OpenAI / Anthropic / Vercel adapters. */
export interface AdapterCallOptions {
  conversationId?: string;
  conversationTitle?: string;
  agentName?: string;
  agentVersion?: string;
  userId?: string;
  turnIndex?: number;
  turnRole?: string;
  contentCapture?: ContentCaptureMode;
  parentGenerationIds?: ParentGenerationRef[];
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

/**
 * Creates a metadata accessor pair scoped to a unique Symbol per provider.
 * Each provider gets its own Symbol so OpenAI and Anthropic params can't
 * accidentally leak metadata into one another.
 */
export function createMetadataAccessor<O extends AdapterCallOptions>(
  symbolKey: string,
): {
  withMetadata: <T extends object>(params: T, options: O) => T;
  readMetadata: (params: unknown) => O;
  stripMetadata: <T>(params: T) => T;
  resolveParams: <T>(params: T, options: O) => { params: T; options: O };
} {
  // Module-local Symbol (NOT Symbol.for): a globally-registered symbol would
  // be shared across two co-loaded copies of this package (e.g. a hoisting
  // miss in a monorepo), letting them clobber each other's per-call metadata.
  // The string is only a debug description here.
  const KEY = Symbol(symbolKey);

  function withMetadata<T extends object>(params: T, options: O): T {
    Object.defineProperty(params, KEY, {
      value: options,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    return params;
  }

  function readMetadata(params: unknown): O {
    if (params && typeof params === 'object') {
      const meta = (params as Record<symbol, unknown>)[KEY];
      if (meta && typeof meta === 'object') return meta as O;
    }
    return {} as O;
  }

  function stripMetadata<T>(params: T): T {
    if (params && typeof params === 'object') {
      delete (params as Record<symbol, unknown>)[KEY];
    }
    return params;
  }

  function resolveParams<T>(params: T, options: O): { params: T; options: O } {
    // Merge any metadata attached in-place via withMetadata(params, opts), then
    // strip the brand so it never reaches the provider wire request. Using the
    // symbol brand (not structural key-matching on `params`/`options`) means a
    // native provider params object is never misread as a metadata wrapper.
    const attached = readMetadata(params);
    stripMetadata(params);
    return { params, options: { ...attached, ...options } };
  }

  return { withMetadata, readMetadata, stripMetadata, resolveParams };
}

/**
 * Maps an `AdapterCallOptions` into the identity-field subset of
 * `GenerationStart` so the various wrappers can spread the result directly
 * into a recorder seed.
 */
export function identityFieldsFromOptions(
  options: AdapterCallOptions,
): Pick<
  GenerationStart,
  | 'conversationId'
  | 'conversationTitle'
  | 'agentName'
  | 'agentVersion'
  | 'userId'
  | 'turnIndex'
  | 'turnRole'
> {
  return {
    conversationId: options.conversationId,
    conversationTitle: options.conversationTitle,
    agentName: options.agentName,
    agentVersion: options.agentVersion,
    userId: options.userId,
    turnIndex: options.turnIndex,
    turnRole: options.turnRole,
  };
}
