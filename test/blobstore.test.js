import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { statSync } from 'node:fs';
import { makeLab } from './helpers.js';
import { MaxSizeExceeded } from '../src/blobstore.js';
import { safeFilename } from '../src/parse.js';

test('identical content is stored once', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const a = await lab.blobs.putBuffer('the same bytes');
  const b = await lab.blobs.putBuffer('the same bytes');

  assert.equal(a.hash, b.hash);
  assert.equal(b.deduped, true, 'second put should reuse the stored blob');

  const { count } = await lab.blobs.totalSize();
  assert.equal(count, 1, 'only one file on disk');
});

test('content round-trips byte for byte', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const original = Buffer.alloc(200_000);
  for (let i = 0; i < original.length; i += 1) original[i] = (i * 31) % 256;

  const { hash, size } = await lab.blobs.put(Readable.from([original]));
  assert.equal(size, original.length);
  assert.deepEqual(await lab.blobs.read(hash), original);
});

test('gc removes only unreferenced blobs', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const keep = await lab.blobs.putBuffer('still referenced');
  const drop = await lab.blobs.putBuffer('orphaned');

  const result = await lab.blobs.gc(new Set([keep.hash]));

  assert.equal(result.removed, 1);
  assert.equal(await lab.blobs.has(keep.hash), true, 'referenced blob survives');
  assert.equal(await lab.blobs.has(drop.hash), false, 'orphan is gone');
});

test('gc after a real delivery keeps everything the database points at', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const att = await lab.blobs.putBuffer('attachment bytes');
  const { id } = await lab.delivery.deliverComposed({
    from: 'a@x.test',
    to: ['b@y.test'],
    subject: 'keep me',
    html: '<p>hi</p>',
    attachments: [{ ...att, filename: 'f.txt', contentType: 'text/plain' }],
  });

  // The temporary upload blob is now also referenced by the stored message.
  const before = await lab.blobs.totalSize();
  const result = await lab.blobs.gc(lab.db.referencedHashes());
  const after = await lab.blobs.totalSize();

  assert.equal(result.removed, 0, 'nothing a message needs may be collected');
  assert.equal(after.count, before.count);

  const stored = lab.db.getAttachments(id);
  assert.equal((await lab.blobs.read(stored[0].content_hash)).toString(), 'attachment bytes');
});

test('the size limit is enforced and leaves nothing behind', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  await assert.rejects(
    () => lab.blobs.put(Readable.from([Buffer.alloc(5000)]), { maxSize: 1000 }),
    MaxSizeExceeded,
  );

  const { count } = await lab.blobs.totalSize();
  assert.equal(count, 0, 'the partial write must not be kept');
});

test('a hostile attachment name cannot steer a write out of the store', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  // Blob paths come from the hash, never the name, so traversal is impossible by
  // construction. The name is separately sanitised for display and download.
  const { hash } = await lab.blobs.putBuffer('x');
  assert.match(lab.blobs.pathFor(hash), /\/[0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{64}$/);

  assert.equal(safeFilename('../../etc/passwd', 'text/plain'), 'passwd');
  assert.equal(safeFilename('..\\..\\windows\\system32\\cmd.exe', 'text/plain'), 'cmd.exe');
  assert.equal(safeFilename('...', 'text/plain'), 'attachment.txt');
  assert.equal(safeFilename('', 'application/pdf'), 'attachment.pdf');
  // CRLF is removed outright rather than splitting the name, so no header break survives.
  assert.equal(safeFilename('evil\r\nX-Injected: yes', 'text/plain'), 'evilX-Injected: yes');
  assert.equal(safeFilename(null, 'image/png'), 'attachment.png');
});

test('a bad hash is rejected rather than used as a path', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  for (const bad of ['../../etc/passwd', 'nothex', '', null, 'abc']) {
    assert.throws(() => lab.blobs.pathFor(bad), /not a blob hash/);
  }
});

test('the database stays small when a large attachment is delivered', async (t) => {
  const lab = await makeLab();
  t.after(() => lab.cleanup());

  const tenMb = Buffer.alloc(10 * 1024 * 1024, 7);
  const stored = await lab.blobs.put(Readable.from([tenMb]));
  await lab.delivery.deliverComposed({
    from: 'big@x.test',
    to: ['recv@y.test'],
    subject: 'large',
    text: 'see attached',
    attachments: [{ ...stored, filename: 'big.bin', contentType: 'application/octet-stream' }],
  });

  // This is the guarantee the whole storage split exists for: SQLite indexes,
  // the filesystem holds the bytes.
  const dbBytes = statSync(lab.config.dbPath).size;
  const blobBytes = (await lab.blobs.totalSize()).bytes;

  assert.ok(blobBytes > 10 * 1024 * 1024, 'the bytes really were stored');
  assert.ok(dbBytes < 512 * 1024, `database grew to ${dbBytes} bytes; it should stay an index`);
});
