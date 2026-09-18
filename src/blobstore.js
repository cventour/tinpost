import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat, readdir, unlink, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

/**
 * Content-addressed store for anything large: raw .eml sources, HTML parts and
 * attachments. Keeping these on disk is what stops the SQLite file from bloating,
 * and hashing the content means identical attachments cost one copy no matter how
 * many mailboxes receive them.
 *
 * Layout: <blobDir>/ab/cd/<full sha256>. Two levels of fan-out keeps directory
 * sizes sane; names are always hashes, never anything a sender chose, so a hostile
 * filename can never steer a write outside the store.
 */
export class BlobStore {
  #blobDir;
  #tmpDir;

  constructor({ blobDir, tmpDir }) {
    this.#blobDir = blobDir;
    this.#tmpDir = tmpDir;
  }

  pathFor(hash) {
    assertHash(hash);
    return join(this.#blobDir, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  /**
   * Stream `source` into the store. Hashes while writing, so the content is never
   * buffered in full — a 25 MB attachment costs a few KB of memory.
   *
   * @param {import('node:stream').Readable} source
   * @param {{ maxSize?: number }} [opts]
   * @returns {Promise<{ hash: string, size: number, deduped: boolean }>}
   */
  async put(source, { maxSize } = {}) {
    const tmpPath = join(this.#tmpDir, `put-${Date.now()}-${randomBytes(8).toString('hex')}`);
    const hasher = createHash('sha256');
    let size = 0;
    let exceeded = false;

    try {
      await pipeline(
        source,
        async function* (chunks) {
          for await (const chunk of chunks) {
            size += chunk.length;
            if (maxSize !== undefined && size > maxSize) {
              exceeded = true;
              throw new MaxSizeExceeded(maxSize);
            }
            hasher.update(chunk);
            yield chunk;
          }
        },
        createWriteStream(tmpPath),
      );
    } catch (err) {
      await rm(tmpPath, { force: true });
      if (exceeded) throw err;
      throw err;
    }

    const hash = hasher.digest('hex');
    const target = this.pathFor(hash);

    // Already stored? Drop the duplicate and reuse the existing blob.
    const existing = await sizeOrNull(target);
    if (existing !== null) {
      await rm(tmpPath, { force: true });
      return { hash, size: existing, deduped: true };
    }

    await mkdir(join(this.#blobDir, hash.slice(0, 2), hash.slice(2, 4)), { recursive: true });
    try {
      await rename(tmpPath, target);
    } catch (err) {
      // A concurrent put may have landed the same content first; that is a win, not an error.
      await rm(tmpPath, { force: true });
      if ((await sizeOrNull(target)) === null) throw err;
      return { hash, size, deduped: true };
    }
    return { hash, size, deduped: false };
  }

  /** Convenience for small in-memory content (test fixtures, generated bodies). */
  async putBuffer(buffer, opts) {
    const { Readable } = await import('node:stream');
    return this.put(Readable.from([Buffer.from(buffer)]), opts);
  }

  openRead(hash) {
    return createReadStream(this.pathFor(hash));
  }

  async read(hash) {
    const { readFile } = await import('node:fs/promises');
    return readFile(this.pathFor(hash));
  }

  async has(hash) {
    return (await sizeOrNull(this.pathFor(hash))) !== null;
  }

  async size(hash) {
    return sizeOrNull(this.pathFor(hash));
  }

  /** Walk the store, yielding every stored hash. */
  async *list() {
    for (const l1 of await safeReaddir(this.#blobDir)) {
      for (const l2 of await safeReaddir(join(this.#blobDir, l1))) {
        for (const name of await safeReaddir(join(this.#blobDir, l1, l2))) {
          if (/^[0-9a-f]{64}$/.test(name)) yield name;
        }
      }
    }
  }

  /** Total bytes on disk, for the admin page's "how big is this lab" answer. */
  async totalSize() {
    let total = 0;
    let count = 0;
    for await (const hash of this.list()) {
      const s = await sizeOrNull(this.pathFor(hash));
      if (s !== null) {
        total += s;
        count += 1;
      }
    }
    return { bytes: total, count };
  }

  /**
   * Delete every blob not present in `referenced`. Callers pass the full set of
   * hashes the database still points at; anything else is unreachable and goes.
   *
   * @param {Set<string>} referenced
   */
  async gc(referenced) {
    let removed = 0;
    let bytes = 0;
    for await (const hash of this.list()) {
      if (referenced.has(hash)) continue;
      const p = this.pathFor(hash);
      const s = await sizeOrNull(p);
      await unlink(p).catch(() => {});
      removed += 1;
      bytes += s ?? 0;
    }
    await this.#pruneEmptyDirs();
    return { removed, bytes };
  }

  async #pruneEmptyDirs() {
    for (const l1 of await safeReaddir(this.#blobDir)) {
      for (const l2 of await safeReaddir(join(this.#blobDir, l1))) {
        await rmdir(join(this.#blobDir, l1, l2)).catch(() => {});
      }
      await rmdir(join(this.#blobDir, l1)).catch(() => {});
    }
  }
}

export class MaxSizeExceeded extends Error {
  constructor(limit) {
    super(`content exceeds the ${limit} byte limit`);
    this.name = 'MaxSizeExceeded';
    this.limit = limit;
  }
}

function assertHash(hash) {
  if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) {
    throw new Error(`not a blob hash: ${JSON.stringify(hash)}`);
  }
}

async function sizeOrNull(path) {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : null;
  } catch {
    return null;
  }
}

async function safeReaddir(dir) {
  try {
    return await readdir(dir);
  } catch {
    return [];
  }
}
