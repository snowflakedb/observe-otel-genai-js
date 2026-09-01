/**
 * OpenTelemetry instrumentation for LangChain.js / LangGraph.
 *
 * Registers like any other OTel instrumentation:
 *
 *   import { registerInstrumentations } from '@opentelemetry/instrumentation';
 *   import { LangChainInstrumentation } from '@genai-otel/core/langchain/instrumentation';
 *
 *   registerInstrumentations({ instrumentations: [new LangChainInstrumentation()] });
 *
 * On load it patches `@langchain/core`'s `CallbackManager` so a
 * `GenAIOtelCallbackHandler` is auto-injected into every chain / LLM / tool run.
 * Callers no longer have to thread a handler through
 * `invoke(..., { callbacks: [...] })` by hand — telemetry is emitted even when
 * the run is invoked with no callbacks at all.
 *
 * The patch wraps the static `CallbackManager._configureSync` (which
 * `configure` delegates to). It runs synchronously at the start of every
 * `invoke`/`stream` in the caller's context, and adds the handler as an
 * inheritable handler so nested runs pick it up. The handler is deduped by
 * name, so a caller that also passes it manually won't double-instrument.
 *
 * ## CJS vs ESM
 *
 *  - **CJS** auto-patches with zero code: once `registerInstrumentations` runs
 *    (before the app first `require`s `@langchain/core`), require-in-the-middle
 *    intercepts the CommonJS build (`dist/callbacks/manager.cjs`) and we patch
 *    it. See {@link MANAGER_CJS}.
 *  - **ESM** is served by {@link LangChainInstrumentation.manuallyInstrument}:
 *    import the `@langchain/core/callbacks/manager` module and hand it over once
 *    at startup. Needs no launch flags.
 *
 * We deliberately register only the concrete `.cjs` file, NOT the bare
 * `@langchain/core` package name. Registering the package name makes
 * OpenTelemetry create an import-in-the-middle hook over the whole
 * `@langchain/core` ESM namespace; IITM's source rewriting then breaks
 * `@langchain/core`'s langsmith interop (`awaitAllCallbacks` throws
 * `TypeError: Client is not a constructor`). Scoping the hook to `manager.cjs`
 * keeps CJS auto-patching working while leaving the ESM module graph untouched
 * — ESM users call `manuallyInstrument` instead of enabling the loader.
 */

import {
  InstrumentationBase,
  type InstrumentationConfig,
  InstrumentationNodeModuleDefinition,
  isWrapped,
} from '@opentelemetry/instrumentation';

import { Client } from '../../client.js';
import { VERSION } from '../../version.js';
import { GenAIOtelCallbackHandler, type GenAIOtelCallbackHandlerOptions } from './index.js';

/**
 * The CommonJS file that defines `CallbackManager`. Registering this concrete
 * `.cjs` path (rather than the bare `@langchain/core` package name) is what lets
 * require-in-the-middle auto-patch CJS without dragging the ESM module graph
 * through import-in-the-middle — see the class doc for why that matters.
 */
const MANAGER_CJS = '@langchain/core/dist/callbacks/manager.cjs';
/** Covers `@langchain/core` 0.3.x and 1.x (the `_configureSync` layouts). */
const SUPPORTED_VERSIONS = ['>=0.3.0 <2'];

/** Shape of the module namespace exported by `@langchain/core/callbacks/manager`. */
interface CallbackManagerModuleExports {
  CallbackManager?: CallbackManagerClass;
}

/**
 * Config for {@link LangChainInstrumentation}. Extends the OTel
 * `InstrumentationConfig` (e.g. `enabled`) and reuses every option from
 * {@link GenAIOtelCallbackHandlerOptions} — the injected handler's defaults —
 * except `client`, which is made optional here.
 */
export interface LangChainInstrumentationConfig
  extends InstrumentationConfig,
    Omit<GenAIOtelCallbackHandlerOptions, 'client'> {
  /**
   * Reuse an existing `Client`. When omitted, one is created lazily using the
   * instrumentation's tracer/meter (i.e. the globally-registered providers).
   */
  client?: Client;
}

/** Minimal shape of a `CallbackManager` instance we rely on. */
interface LangChainCallbackManager {
  handlers?: Array<{ name?: string }>;
  addHandler(handler: unknown, inherit?: boolean): void;
}

/** Minimal shape of the `CallbackManager` class (constructor + static). */
interface CallbackManagerClass {
  new (): LangChainCallbackManager;
  _configureSync: (this: unknown, ...args: unknown[]) => LangChainCallbackManager | undefined;
}

type ConfigureSync = CallbackManagerClass['_configureSync'];

export class LangChainInstrumentation extends InstrumentationBase<LangChainInstrumentationConfig> {
  private handlerInstance?: GenAIOtelCallbackHandler;
  /**
   * The `Client` we created ourselves (when the caller didn't supply one), so
   * {@link shutdown} knows it owns its lifecycle. A caller-supplied client is
   * never shut down by us — its owner is responsible for that.
   */
  private ownedClient?: Client;
  /** Modules patched via {@link manuallyInstrument}; OTel's hook never saw them, so {@link disable} unpatches them itself. */
  private readonly manualModules = new Set<CallbackManagerModuleExports>();

  constructor(config: LangChainInstrumentationConfig = {}) {
    super('@genai-otel/instrumentation-langchain', VERSION, config);
  }

  /**
   * The handler that gets injected into LangChain runs. Exposed so callers can
   * `await instrumentation.handler.dispose()` on shutdown to drain open runs.
   */
  get handler(): GenAIOtelCallbackHandler {
    return this.getHandler();
  }

  protected init(): InstrumentationNodeModuleDefinition {
    // Register the concrete CJS file as the module. The bare package name is
    // intentionally avoided so OTel doesn't hook the ESM namespace via
    // import-in-the-middle — see the class doc.
    return new InstrumentationNodeModuleDefinition(
      MANAGER_CJS,
      SUPPORTED_VERSIONS,
      (moduleExports: CallbackManagerModuleExports, moduleVersion?: string) =>
        this.patchCallbackManager(moduleExports, moduleVersion),
      (moduleExports?: CallbackManagerModuleExports) => this.unpatchCallbackManager(moduleExports),
    );
  }

  /**
   * Patch a `@langchain/core/callbacks/manager` module namespace directly.
   *
   * Use this when the automatic require/import hook can't fire — most commonly
   * in ESM projects started without the OpenTelemetry loader hook. Import the
   * module and hand it over once, before any runs execute:
   *
   *   import * as CallbackManagerModule from '@langchain/core/callbacks/manager';
   *   instrumentation.manuallyInstrument(CallbackManagerModule);
   *
   * Idempotent: re-patching an already-patched module is a no-op.
   */
  manuallyInstrument(moduleExports: { CallbackManager?: unknown }): void {
    this._diag.debug('manually instrumenting @langchain/core CallbackManager');
    const exports = moduleExports as CallbackManagerModuleExports;
    this.patchCallbackManager(exports);
    this.manualModules.add(exports);
  }

  private getHandler(): GenAIOtelCallbackHandler {
    if (!this.handlerInstance) {
      // `enabled` is an instrumentation-level flag, not a handler option.
      const { client, enabled: _enabled, ...handlerOptions } = this.getConfig();
      let resolvedClient = client;
      if (!resolvedClient) {
        resolvedClient = new Client({ tracer: this.tracer, meter: this.meter });
        this.ownedClient = resolvedClient;
      }
      this.handlerInstance = new GenAIOtelCallbackHandler({
        client: resolvedClient,
        ...handlerOptions,
      });
    }
    return this.handlerInstance;
  }

  private patchCallbackManager(
    moduleExports: CallbackManagerModuleExports,
    moduleVersion?: string,
  ): CallbackManagerModuleExports {
    const CallbackManager = moduleExports?.CallbackManager;
    if (!CallbackManager) {
      this._diag.debug('@langchain/core module has no CallbackManager export; skipping patch');
      return moduleExports;
    }
    if (isWrapped(CallbackManager._configureSync)) {
      this._diag.debug('@langchain/core CallbackManager already patched; skipping');
      return moduleExports;
    }
    this._diag.debug(
      `patching @langchain/core CallbackManager._configureSync${
        moduleVersion ? ` (v${moduleVersion})` : ''
      }`,
    );
    this._wrap(CallbackManager, '_configureSync', this.configureWrapper());
    return moduleExports;
  }

  private unpatchCallbackManager(moduleExports?: CallbackManagerModuleExports): void {
    const CallbackManager = moduleExports?.CallbackManager;
    if (CallbackManager && isWrapped(CallbackManager._configureSync)) {
      this._diag.debug('unpatching @langchain/core CallbackManager._configureSync');
      this._unwrap(CallbackManager, '_configureSync');
    }
  }

  private configureWrapper(): (original: ConfigureSync) => ConfigureSync {
    const instrumentation = this;
    return (original: ConfigureSync): ConfigureSync =>
      function patchedConfigureSync(
        this: unknown,
        ...args: unknown[]
      ): LangChainCallbackManager | undefined {
        // Always run LangChain's own logic first with the original args, so
        // that even if our injection throws below the caller still gets a
        // correct manager. This is the golden rule of instrumentation: never
        // let telemetry wiring break the user's call.
        const base = original.apply(this, args);
        try {
          const handler = instrumentation.getHandler();
          // `this` is the CallbackManager class in a static call. When the base
          // returned nothing (no user callbacks, no tracing), build a manager so
          // telemetry is still emitted.
          const ManagerClass = this as CallbackManagerClass;
          const manager: LangChainCallbackManager = base ?? new ManagerClass();
          const already = manager.handlers?.some((h) => h?.name === handler.name);
          if (!already) manager.addHandler(handler, true);
          return manager;
        } catch (err) {
          // Injection failed (e.g. Client construction threw). Fall back to
          // LangChain's unmodified result — this run just won't be traced.
          instrumentation._diag.error(
            'failed to inject genai-otel callback handler; continuing without instrumentation for this run',
            err instanceof Error ? err.message : String(err),
          );
          return base;
        }
      };
  }

  /**
   * Removes the require/import hooks and, when set up, drains the injected
   * handler's open runs. Kept synchronous to satisfy the OTel
   * `Instrumentation` contract; the drain is best-effort and fire-and-forget.
   * For a guaranteed drain (and to shut down a self-created `Client`), call
   * {@link shutdown} and `await` it instead.
   */
  override disable(): void {
    super.disable();
    // OTel only unpatches modules its hook saw (CJS); undo our manual (ESM) ones.
    for (const mod of this.manualModules) this.unpatchCallbackManager(mod);
    this.manualModules.clear();
    if (this.handlerInstance) {
      this.handlerInstance
        .dispose()
        .catch((err) =>
          this._diag.error(
            'failed to drain genai-otel LangChain handler on disable',
            err instanceof Error ? err.message : String(err),
          ),
        );
    }
  }

  /**
   * Awaitable teardown. Drains any open runs on the injected handler and, when
   * this instrumentation created its own `Client` (no `client` was supplied in
   * config), shuts that client down so its provider flush runs. A
   * caller-supplied client is left untouched — you own its shutdown.
   *
   * Note: `disable()` alone does not shut down a self-created client. If you
   * rely on auto-patching without your own `Client`, call `await
   * instrumentation.shutdown()` (or shut down your global TracerProvider) so
   * trailing spans are flushed.
   */
  async shutdown(): Promise<void> {
    if (this.handlerInstance) {
      try {
        await this.handlerInstance.dispose();
      } catch (err) {
        this._diag.error(
          'failed to drain genai-otel LangChain handler on shutdown',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
    if (this.ownedClient) {
      try {
        await this.ownedClient.shutdown();
      } catch (err) {
        this._diag.error(
          'failed to shut down genai-otel Client on shutdown',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }
}
