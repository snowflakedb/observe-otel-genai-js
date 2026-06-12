import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { BlobStoreError } from '../errors.js';

/**
 * Pluggable blob storage for large content payloads.
 *
 * When a `ContentCapture.blobStore` is configured and a prompt / tool result
 * exceeds `maxContentLength`, the library uploads the full content and writes
 * the returned URI to `gen_ai.content.uri` on the span event instead of
 * truncating.
 *
 * Implementations should be best-effort: a slow or failing `put` will be
 * surfaced as a `BlobStoreError` on the recorder; the span is still recorded
 * with the truncated content as a fallback.
 */
export interface BlobStore {
  /**
   * Persist `content` under `key` and return a URI used in telemetry.
   *
   * @param key      Stable, application-meaningful key.
   * @param content  The full payload as UTF-8 bytes.
   * @param hint     Optional content-type hint for backends that care
   *                 (e.g. `"application/json"`, `"text/plain"`).
   * @returns        A URI string. The library writes this verbatim to
   *                 `gen_ai.content.uri`, so it should be something the
   *                 operator can dereference (e.g. `s3://bucket/key`).
   */
  put(key: string, content: Uint8Array, hint?: string): Promise<string>;
}

/**
 * Default ergonomic adapter that writes blobs under a directory on the local
 * filesystem. The returned URI is `file://<absolute-path>`.
 *
 * Useful for development, examples, and integration tests; production users
 * should plug in an object-store adapter via the `BlobStore` interface.
 */
export class LocalFsBlobStore implements BlobStore {
  private readonly root: string;

  constructor(root: string) {
    if (!root || typeof root !== 'string') {
      throw new BlobStoreError('LocalFsBlobStore requires a non-empty root path');
    }
    this.root = isAbsolute(root) ? root : resolve(process.cwd(), root);
  }

  async put(key: string, content: Uint8Array, _hint?: string): Promise<string> {
    const safeKey = key.replace(/[^A-Za-z0-9._/-]/g, '_');
    const target = join(this.root, safeKey);
    try {
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    } catch (err) {
      throw new BlobStoreError(
        `LocalFsBlobStore failed to write ${target}: ${(err as Error).message}`,
        { cause: err },
      );
    }
    return `file://${target}`;
  }
}
