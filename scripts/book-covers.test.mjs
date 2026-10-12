import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';

const directory = await mkdtemp(path.join(os.tmpdir(), 'book-covers-test-'));
process.env.READING_MCP_DATA_DIR = directory;
process.env.MCP_SSE_HOST = '127.0.0.1';
process.env.MCP_SSE_PORT = '0';
process.env.MCP_AUTH_TOKEN = 'synthetic-cover-test-token';
const book = path.join(directory, 'books/demo');
await mkdir(path.join(book, 'chunks'), { recursive: true });
const original = {
  'books/demo/manifest.json': JSON.stringify({ bookId: 'demo', title: 'Synthetic long title', chunks: [{ id: 'c1', title: 'Chapter', order: 0, path: 'chunks/c1.txt' }] }, null, 2),
  'books/demo/chunks/c1.txt': 'Synthetic chapter with exact anchors.\n',
  'progress.json': JSON.stringify({ demo: { readChunkIds: ['c1'] } }),
  'annotations.jsonl': JSON.stringify({ id: 'ann-original', bookId: 'demo', chunkId: 'c1', author: 'reader', note: 'Never rewritten', quote: 'Synthetic', status: 'private' }) + '\n',
};
for (const [name, body] of Object.entries(original)) await writeFile(path.join(directory, name), body);
const fixtures = JSON.parse(execFileSync('python3', ['-c', `import sys,json,base64; sys.path.insert(0,'scripts'); from book_cover_test import picture,epub; print(json.dumps({'png':base64.b64encode(picture()).decode(), 'epub':base64.b64encode(epub().getvalue()).decode(), 'empty':base64.b64encode(epub('absent').getvalue()).decode()}))`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
const { startSseServer } = await import('../src/server-sse.js');
const { importBook } = await import('../src/importer.js');
const { listBooks } = await import('../src/store.js');
const server = startSseServer();
await once(server, 'listening');
const base = `http://127.0.0.1:${server.address().port}`;
async function http(method, route, body, authenticated = true) {
  const response = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(authenticated ? { Authorization: 'Bearer synthetic-cover-test-token' } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
async function assertOriginal() {
  for (const [name, body] of Object.entries(original)) assert.equal(await readFile(path.join(directory, name), 'utf8'), body, `${name} must retain identical bytes`);
}
after(async () => { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); await rm(directory, { recursive: true, force: true }); });

test('cover routes require authentication and absent covers retain books', async () => {
  for (const method of ['GET', 'POST']) assert.equal((await http(method, '/api/books/demo/cover', method === 'POST' ? {} : undefined, false)).status, 401);
  assert.deepEqual((await http('GET', '/api/books/demo/cover')).body, { bookId: 'demo', cover: null });
  assert.equal((await http('GET', '/api/books/missing/cover')).status, 404);
  const capabilities = (await http('GET', '/api/reader/capabilities')).body.bookCovers;
  assert.equal(capabilities.epub, true); assert.equal(capabilities.maxBytes, 524288);
  assert.equal(capabilities.ifAbsent, true);
  assert.equal((await listBooks())[0].cover, null);
});

test('cover-only EPUB update preserves manifest, chunks, progress and annotations exactly', async () => {
  const result = await http('POST', '/api/books/demo/cover', { format: 'epub', dataBase64: fixtures.epub });
  assert.equal(result.status, 200); assert.equal(result.body.cover.height, 640);
  assert.equal(result.body.cover.dataBase64, undefined);
  await assertOriginal();
  const fetched = (await http('GET', '/api/books/demo/cover')).body.cover;
  assert.equal(crypto.createHash('sha256').update(Buffer.from(fetched.dataBase64, 'base64')).digest('hex'), result.body.cover.sha256);
  assert.deepEqual((await listBooks())[0].cover, result.body.cover);
  assert.deepEqual((await readdir(book)).sort(), ['chunks', 'cover.json', 'manifest.json']);
});

test('image update is normalized and malformed, oversized, unknown-book uploads never overwrite', async () => {
  const uploaded = await http('POST', '/api/books/demo/cover', { mimeType: 'image/png', dataBase64: fixtures.png });
  assert.equal(uploaded.status, 200); assert.equal(uploaded.body.cover.mimeType, 'image/jpeg');
  const saved = await readFile(path.join(book, 'cover.json'), 'utf8');
  const invalid = [
    { mimeType: 'image/svg+xml', dataBase64: Buffer.from('<svg/>').toString('base64') },
    { mimeType: 'image/jpeg', dataBase64: fixtures.png },
    { mimeType: 'image/png', dataBase64: '../invalid' },
    { format: 'epub', dataBase64: fixtures.epub, overwrite: true },
    { format: 'epub', dataBase64: fixtures.epub, mimeType: 'image/png' },
    { format: 'epub', dataBase64: fixtures.empty },
    // A normal multi-megabyte file must report a decoding error, not overflow V8's regex stack.
    { format: 'epub', dataBase64: Buffer.alloc(5 * 1024 * 1024, 42).toString('base64') },
  ];
  for (const payload of invalid) assert.equal((await http('POST', '/api/books/demo/cover', payload)).status, 400);
  assert.equal((await http('POST', '/api/books/demo/cover', { mimeType: 'image/png', dataBase64: Buffer.alloc(524289).toString('base64') })).status, 413);
  assert.equal((await http('POST', '/api/books/missing/cover', { mimeType: 'image/png', dataBase64: fixtures.png })).status, 404);
  assert.equal(await readFile(path.join(book, 'cover.json'), 'utf8'), saved);
  await assertOriginal();
});

test('encoded path traversal cannot select outside book storage', async () => {
  for (const id of ['..%2f..%2foutside', '%2fabsolute', 'demo%00', 'demo%5c..%5cother']) {
    assert.equal((await http('GET', `/api/books/${id}/cover`)).status, 400);
  }
});

test('ifAbsent atomically preserves an existing cover byte-for-byte, including concurrent requests', async () => {
  const saved = await readFile(path.join(book, 'cover.json'), 'utf8');
  const expected = (await http('GET', '/api/books/demo/cover')).body.cover.sha256;
  const different = JSON.parse(execFileSync('python3', ['-c', `import io,base64,json; from PIL import Image; b=io.BytesIO(); Image.new('RGB',(25,40),'red').save(b,'PNG'); print(json.dumps({'dataBase64':base64.b64encode(b.getvalue()).decode()}))`], { encoding: 'utf8' }));
  const results = await Promise.all(Array.from({ length: 3 }, () => http('POST', '/api/books/demo/cover', { mimeType: 'image/png', dataBase64: different.dataBase64, ifAbsent: true })));
  for (const result of results) { assert.equal(result.status, 200); assert.equal(result.body.cover.sha256, expected); }
  assert.equal(await readFile(path.join(book, 'cover.json'), 'utf8'), saved);
  assert.equal((await http('POST', '/api/books/demo/cover', { mimeType: 'image/png', dataBase64: fixtures.png, ifAbsent: 'true' })).status, 400);
  await assertOriginal();
});

test('new EPUB import automatically stores optional cover without changing original books', async () => {
  const result = await importBook({ filename: 'synthetic.epub', bookId: 'new-import', dataBase64: fixtures.epub });
  assert.equal(result.bookId, 'new-import');
  const cover = (await http('GET', '/api/books/new-import/cover')).body.cover;
  assert.equal(cover.height, 640);
  await assertOriginal();
});

test('corrupt optional cover leaves book visible, and explicit cover read reports error', async () => {
  await writeFile(path.join(book, 'cover.json'), '{damaged');
  const books = await listBooks();
  assert.equal(books.find((item) => item.bookId === 'demo').cover, null);
  assert.equal((await http('GET', '/api/books/demo/cover')).status, 400);
  await assertOriginal();
});

test('Python extractor checks EPUB variants, ZIP/XML/image bounds and strips metadata', () => {
  execFileSync('python3', ['-m', 'unittest', 'scripts/book_cover_test.py'], { cwd: new URL('..', import.meta.url), stdio: 'pipe' });
});
