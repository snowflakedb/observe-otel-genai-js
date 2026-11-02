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

/**
 * What a LangGraph graph says about itself when it starts a run.
 *
 * The run's metadata is no proof: child runs inherit it, so a run started inside
 * a `createAgent` tool carries that agent's markers too. The graph object's own
 * config is not passed on. `LangChainInstrumentation` reads it when LangGraph
 * serializes the graph for the run's start callback, and keys it by that
 * serialized object, which is what the callback receives.
 */

/** The graph's own answer: whether `createAgent` built it, and the name it was given. */
export interface GraphIdentity {
  builtByCreateAgent: boolean;
  name?: string;
}

/** The run metadata `createAgent` (from `langchain`) puts on its graph. */
export const CREATE_AGENT_INTEGRATION = 'langchain_create_agent';

/** The model node every `createAgent` graph has. */
const CREATE_AGENT_MODEL_NODE = 'model_request';

/** LangGraph's name for a graph compiled without one (`Pregel.lc_name()`). */
export const LANGGRAPH_DEFAULT_NAME = 'LangGraph';

export interface GraphLike {
  name?: string;
  nodes?: Record<string, unknown>;
  config?: { metadata?: Record<string, unknown> };
}

const identities = new WeakMap<object, GraphIdentity>();

/**
 * Records what `graph` says about itself against the object its `toJSON()`
 * returned. `langchain` 1.4.4 and later mark a `createAgent` graph in its own
 * config; earlier versions do not, so their graphs are known by the model node
 * instead. `createAgent` compiles its name into the graph in every version.
 */
export function rememberGraphIdentity(serialized: object, graph: GraphLike): void {
  const builtByCreateAgent =
    graph.config?.metadata?.ls_integration === CREATE_AGENT_INTEGRATION ||
    (graph.nodes !== undefined && CREATE_AGENT_MODEL_NODE in graph.nodes);
  const name = graph.name && graph.name !== LANGGRAPH_DEFAULT_NAME ? graph.name : undefined;
  identities.set(serialized, { builtByCreateAgent, name });
}

/** What the graph behind a run's serialized form said about itself, if it was recorded. */
export function graphIdentity(serialized: object): GraphIdentity | undefined {
  return identities.get(serialized);
}
