/**
 * Library error hierarchy.
 *
 * All errors thrown or surfaced by the recorder API extend `GenAIOtelError`,
 * so consumers can `catch (e: GenAIOtelError)` without enumerating subtypes.
 */

export class GenAIOtelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = new.target.name;
  }
}

/** A user-supplied seed or result was invalid. */
export class ValidationError extends GenAIOtelError {}

/** A `BlobStore.put(...)` call failed. The span still gets the truncated body. */
export class BlobStoreError extends GenAIOtelError {}

/** A method was called on a client/recorder that has been shut down. */
export class ClientShutdownError extends GenAIOtelError {}

/** `Client.flush(timeoutMs)` did not complete before the deadline. */
export class FlushTimeoutError extends GenAIOtelError {}
