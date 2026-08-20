import type { ContentCaptureMode } from '../content/capture.js';

/**
 * Seed fields used when retrieval recording starts.
 *
 * A retrieval span (`gen_ai.operation.name = retrieval`, span kind CLIENT)
 * models a single request that fetches context from a vector database or
 * search system — the "R" in a RAG pipeline. See the OTel GenAI conventions,
 * span type `gen_ai.retrieval.client`.
 */
export interface RetrievalStart {
  /**
   * Identifier for the data source being queried (e.g. the vector store /
   * index / collection name). Emitted as `gen_ai.data_source.id` and used in
   * the span name (`retrieval {dataSourceId}`).
   */
  dataSourceId?: string;
  /**
   * Embedding / inference provider that produced the query embedding (e.g.
   * `openai`), emitted as `gen_ai.provider.name`. Per OTel GenAI semconv this
   * attribute is the *inference* provider, NOT the vector-store vendor. Omitted
   * when not derivable.
   */
  provider?: string;
  /** Embedding/search model used for the query (emitted as `gen_ai.request.model`). */
  requestModel?: string;
  /** Number of documents requested (emitted as `gen_ai.retrieval.top_k`). */
  topK?: number;
  /**
   * The query text sent to the data source. Opt-in content — emitted as
   * `gen_ai.retrieval.query.text` under the same capture/truncation policy as
   * `gen_ai.input.messages`.
   */
  queryText?: string;
  agentName?: string;
  agentVersion?: string;
  conversationId?: string;
  /** Per-call content-capture override (see `GenerationStart.contentCapture`). */
  contentCapture?: ContentCaptureMode;
  tags?: Record<string, string>;
  metadata?: Record<string, unknown>;
  startedAt?: Date | number;
}

/**
 * A single retrieved document. Serialized into the opt-in
 * `gen_ai.retrieval.documents` attribute (subject to content-capture config).
 */
export interface RetrievalDocument {
  id?: string;
  /** The document text / page content. */
  content?: string;
  /** Relevance / similarity score when the retriever reports one. */
  score?: number;
  metadata?: Record<string, unknown>;
}

/**
 * Completion payload for a retrieval span.
 *
 * Note: there is deliberately no `topK` here. `gen_ai.retrieval.top_k` is the
 * number of documents *requested* (a request parameter carried on
 * `RetrievalStart`), not the number returned, so it is never derived from the
 * result. The count of returned documents is implicit in `documents.length`.
 */
export interface RetrievalResult {
  /** The documents returned by the data source. */
  documents?: RetrievalDocument[];
}
