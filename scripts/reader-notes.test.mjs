import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const directory = await mkdtemp(path.join(os.tmpdir(), "reader-notes-test-"));
process.env.READING_MCP_DATA_DIR = directory;
process.env.MCP_SSE_HOST = "127.0.0.1";
process.env.MCP_SSE_PORT = "0";
process.env.MCP_AUTH_TOKEN = "synthetic-test-token";
const source = "A beginning 🐾.\nRepeated words.\nA different middle.\nRepeated words.\n";
await mkdir(path.join(directory, "books/demo/chunks"), { recursive: true });
await writeFile(path.join(directory, "books/demo/chunks/c1.txt"), source);
await writeFile(path.join(directory, "books/demo/manifest.json"), JSON.stringify({ bookId: "demo", title: "Synthetic book", chunks: [{ id: "c1", title: "Synthetic chapter", order: 0, path: "chunks/c1.txt" }] }));
const store = await import("../src/store.js");
const { callTool, handle } = await import("../src/server.js");
const { startSseServer } = await import("../src/server-sse.js");
const server = startSseServer();
await once(server, "listening");
const base = `http://127.0.0.1:${server.address().port}`;
let serial = 0;
const requestId = () => `synthetic_request_${++serial}`;
const quote = "Repeated words.";
const payload = (extra = {}) => ({ bookId: "demo", chunkId: "c1", quote, note: "A synthetic private thought", anchor: { start: source.lastIndexOf(quote), end: source.lastIndexOf(quote) + quote.length }, visibility: "private", clientRequestId: requestId(), ...extra });
const jsonTool = async (name, args = {}) => JSON.parse((await callTool(name, args)).content[0].text);
async function http(method, route, body, authenticated = true) {
  const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json", ...(authenticated ? { Authorization: "Bearer synthetic-test-token" } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
}
after(async () => { await new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }); await rm(directory, { recursive: true, force: true }); });

test("capability and tool schemas require truthful assistant identity; read routes remain arrays", async () => {
  assert.equal((await http("GET", "/api/reader/capabilities", undefined, false)).status, 401);
  const capability = await http("GET", "/api/reader/capabilities");
  assert.equal(capability.body.readerAnnotations.anchorEncoding, "utf16");
  assert.equal(capability.body.readerAnnotations.version, 1);
  const listing = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  for (const name of ["reading_annotate_passage", "reading_reply_to_annotation"]) {
    assert.ok(listing.result.tools.find((item) => item.name === name).inputSchema.required.includes("author"));
  }
  await assert.rejects(jsonTool("reading_annotate_passage", { bookId: "demo", chunkId: "c1", quote, note: "Thought" }), /identity_required/);
  assert.ok(Array.isArray((await http("GET", "/api/annotations")).body));
});

test("reader create preserves the second precise occurrence and private stays absent from all common MCP reads", async () => {
  const created = await http("POST", "/api/reader/annotations", payload());
  assert.equal(created.status, 201);
  const annotation = created.body.annotation;
  assert.equal(annotation.role, "human"); assert.equal(annotation.author, "user");
  assert.equal(annotation.anchor.start, source.lastIndexOf(quote));
  assert.equal(annotation.revision, 1); assert.equal(annotation.status, "private");
  assert.equal((await http("GET", `/api/reader/annotations/${annotation.id}`)).body.annotation.id, annotation.id);
  assert.ok(!(await jsonTool("reading_list_annotations", { includePrivate: true })).some((item) => item.id === annotation.id));
  assert.ok(!(await jsonTool("reading_read_chunk", { bookId: "demo", chunkId: "c1" })).annotations.some((item) => item.id === annotation.id));
  assert.ok(!(await jsonTool("reading_continue", { bookId: "demo" })).annotations.some((item) => item.id === annotation.id));
  assert.equal((await jsonTool("reading_submit_user_notes")).count, 0);
  assert.ok((await http("GET", "/api/annotations")).body.some((item) => item.id === annotation.id));
});

test("strict anchors, length bounds, and caller identity injection are rejected without writes", async () => {
  for (const body of [payload({ anchor: { start: 0, end: quote.length } }), payload({ author: "claude" }), payload({ role: "assistant" }), payload({ note: "x".repeat(20001) }), payload({ anchor: { start: -1, end: 5 } }), payload({ visibility: "published" })]) {
    assert.equal((await http("POST", "/api/reader/annotations", body)).status, 400);
  }
  assert.equal((await http("POST", "/api/reader/annotations", payload({ note: "x".repeat(180000) }))).status, 413);
});

test("persistent idempotency and revision conflicts never duplicate or silently overwrite notes", async () => {
  const body = payload();
  const first = await http("POST", "/api/reader/annotations", body);
  const retry = await http("POST", "/api/reader/annotations", body);
  assert.equal(retry.status, 200); assert.equal(retry.body.annotation.id, first.body.annotation.id);
  assert.equal((await http("POST", "/api/reader/annotations", { ...body, note: "Changed" })).body.error.code, "idempotency_conflict");
  const id = first.body.annotation.id;
  const edit = { expectedRevision: 1, clientRequestId: requestId(), note: "Edited once" };
  const edited = await http("PATCH", `/api/reader/annotations/${id}`, edit);
  assert.equal(edited.body.annotation.revision, 2);
  assert.equal((await http("PATCH", `/api/reader/annotations/${id}`, edit)).body.annotation.revision, 2);
  const conflict = await http("PATCH", `/api/reader/annotations/${id}`, { ...edit, clientRequestId: requestId(), note: "Stale edit" });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.error.latest.note, "Edited once");
  assert.ok(!JSON.stringify(edited.body).includes("_readerRequests"));
  assert.ok((await readFile(path.join(directory, "annotations.jsonl"), "utf8")).includes(body.clientRequestId));
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", "import { createReaderAnnotation } from './src/store.js'; console.log(JSON.stringify(await createReaderAnnotation(JSON.parse(process.argv[1]))));", JSON.stringify(body)], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, READING_MCP_DATA_DIR: directory } }));
  assert.equal(restarted.replayed, true); assert.equal(restarted.annotation.id, id); assert.equal(restarted.annotation.revision, 2);
  const simultaneous = await Promise.all(["A", "B"].map((note) => http("PATCH", `/api/reader/annotations/${id}`, { expectedRevision: 2, clientRequestId: requestId(), note })));
  assert.deepEqual(simultaneous.map((item) => item.status).sort(), [200, 409]);
});

test("sharing one note leaves other private notes hidden; every partner can read shared notes repeatedly", async () => {
  const a = (await http("POST", "/api/reader/annotations", payload({ note: "Only this one is shared" }))).body.annotation;
  const b = (await http("POST", "/api/reader/annotations", payload({ note: "This remains private" }))).body.annotation;
  await http("PATCH", `/api/reader/annotations/${a.id}`, { expectedRevision: 1, clientRequestId: requestId(), visibility: "shared" });
  for (let partner = 0; partner < 2; partner++) {
    const notes = (await jsonTool("reading_read_chunk", { bookId: "demo", chunkId: "c1" })).annotations;
    assert.ok(notes.some((item) => item.id === a.id)); assert.ok(!notes.some((item) => item.id === b.id));
  }
  const reply = await jsonTool("reading_reply_to_annotation", { parentId: a.id, author: "codex", displayName: "Codex", note: "An explicitly signed response" });
  assert.equal(reply.author, "codex"); assert.equal(reply.role, "assistant"); assert.equal(reply.parentId, a.id);
  assert.deepEqual(reply.anchor, a.anchor, "A reply must retain the parent's selected occurrence, not the first identical quote");
  assert.ok((await http("GET", "/api/annotations")).body.some((item) => item.id === reply.id));
  assert.equal((await http("PATCH", `/api/reader/annotations/${reply.id}`, { expectedRevision: 1, clientRequestId: requestId(), note: "Not mine" })).status, 403);
  await http("PATCH", `/api/reader/annotations/${a.id}`, { expectedRevision: 2, clientRequestId: requestId(), visibility: "private" });
  assert.ok(!(await jsonTool("reading_list_annotations")).some((item) => item.id === a.id || item.id === reply.id));
  await assert.rejects(jsonTool("reading_reply_to_annotation", { parentId: a.id, author: "codex", note: "No private parent" }), /Unknown parent|unavailable/);
  const attemptedChild = await http("POST", "/api/reader/annotations", payload({ parentId: a.id, visibility: "shared" }));
  assert.equal(attemptedChild.body.error.code, "private_thread");
});

test("legacy staged notes submit once globally; explicit-private notes and current-private historical batches remain hidden", async () => {
  const legacy = await http("POST", "/api/annotations", { bookId: "demo", chunkId: "c1", quote, note: "A legacy staged note", status: "open" });
  const explicit = (await http("POST", "/api/reader/annotations", payload())).body.annotation;
  const submission = await jsonTool("reading_submit_user_notes", { bookId: "demo", sessionId: "partner-one" });
  assert.ok(submission.notes.some((item) => item.id === legacy.body.id)); assert.ok(!submission.notes.some((item) => item.id === explicit.id));
  assert.equal((await jsonTool("reading_submit_user_notes", { bookId: "demo", sessionId: "partner-two" })).count, 0);
  const reread = await jsonTool("reading_read_submission", { submissionId: submission.submissionId });
  assert.ok(reread.notes.some((item) => item.id === legacy.body.id));
  const current = (await http("GET", `/api/reader/annotations/${legacy.body.id}`)).body.annotation;
  await http("PATCH", `/api/reader/annotations/${legacy.body.id}`, { expectedRevision: current.revision, clientRequestId: requestId(), visibility: "private" });
  await assert.rejects(jsonTool("reading_read_submission", { submissionId: submission.submissionId }), /unavailable/);
  assert.ok(!(await jsonTool("reading_list_submissions")).some((item) => item.id === submission.submissionId));
});

test("mixed HTTP and MCP annotation writes share the same transaction lock", async () => {
  const initial = (await http("GET", "/api/annotations")).body.length;
  const work = [];
  for (let i = 0; i < 12; i++) {
    work.push(http("POST", "/api/reader/annotations", payload({ note: `Reader note ${i}` })));
    work.push(jsonTool("reading_annotate_passage", { bookId: "demo", chunkId: "c1", quote, note: `Assistant note ${i}`, author: "test-assistant" }));
  }
  const results = await Promise.all(work);
  assert.ok(results.filter((_, i) => i % 2 === 0).every((item) => item.status === 201));
  const final = (await http("GET", "/api/annotations")).body;
  assert.equal(final.length, initial + 24); assert.equal(new Set(final.map((note) => note.id)).size, final.length);
  assert.equal(await readFile(path.join(directory, "progress.json"), "utf8").catch((error) => error.code), "ENOENT");
});

const explanationPayload = (extra = {}) => payload({ note: "A provider explanation of the selected passage.", question: "Explain this term in context.", provider: "openrouter", model: "deepseek/deepseek-v3.2", ...extra });
const collectPayload = (annotationId, extra = {}) => ({ annotationId, kind: "term", title: "Repeated words", clientRequestId: requestId(), ...extra });
const markPayload = (extra = {}) => { const { note, visibility, ...selection } = payload(); return { ...selection, style: "highlight", color: "purple", ...extra }; };

test("excerpt kinds allow collecting before understanding; plain notes stay nonempty and kind edits are revision checked", async () => {
  for (const kind of ["word", "term", "knowledge"]) {
    const created = await http("POST", "/api/reader/annotations", payload({ note: "", kind, tags: ["待理解", "研究方法"] }));
    assert.equal(created.status, 201); assert.equal(created.body.annotation.note, ""); assert.equal(created.body.annotation.kind, kind);
    const id = created.body.annotation.id;
    assert.equal((await http("PATCH", `/api/reader/annotations/${id}`, { expectedRevision: 1, clientRequestId: requestId(), kind: "annotation" })).status, 400);
    const edited = await http("PATCH", `/api/reader/annotations/${id}`, { expectedRevision: 1, clientRequestId: requestId(), kind: "knowledge", note: "My own understanding", tags: ["已整理"] });
    assert.equal(edited.body.annotation.revision, 2); assert.deepEqual(edited.body.annotation.tags, ["已整理"]);
  }
  assert.equal((await http("POST", "/api/reader/annotations", payload({ note: "" }))).status, 400);
  for (const extra of [{ kind: "explanation" }, { tags: ["x".repeat(81)] }, { tags: Array(21).fill("x") }]) assert.equal((await http("POST", "/api/reader/annotations", payload(extra))).status, 400);
});

test("provider explanations derive immutable assistant identity and reject spoofed or mismatched source fields", async () => {
  const capabilities = (await http("GET", "/api/reader/capabilities")).body;
  for (const key of ["readerExplanations", "readerCollections", "readerMarks"]) assert.equal(capabilities[key].version, 1);
  const created = await http("POST", "/api/reader/explanations", explanationPayload());
  assert.equal(created.status, 201);
  const annotation = created.body.annotation;
  assert.equal(annotation.author, "openrouter:deepseek/deepseek-v3.2"); assert.equal(annotation.role, "assistant");
  assert.equal(annotation.kind, "explanation"); assert.equal(annotation.displayName, "OpenRouter · deepseek/deepseek-v3.2");
  assert.deepEqual(annotation.explanation, { provider: "openrouter", model: "deepseek/deepseek-v3.2", question: "Explain this term in context." });
  assert.equal(annotation.anchor.start, source.lastIndexOf(quote));
  assert.equal((await http("PATCH", `/api/reader/annotations/${annotation.id}`, { expectedRevision: 1, clientRequestId: requestId(), note: "Impersonating the model" })).status, 403);
  for (const extra of [{ author: "codex" }, { role: "human" }, { displayName: "Claude" }, { kind: "annotation" }, { provider: "custom" }, { model: "Claude\nHuman" }, { note: "" }, { question: "" }, { anchor: { start: 0, end: quote.length } }]) {
    assert.equal((await http("POST", "/api/reader/explanations", explanationPayload(extra))).status, 400);
  }
  const deepseek = await http("POST", "/api/reader/explanations", explanationPayload({ provider: "deepseek", model: "deepseek-chat" }));
  assert.equal(deepseek.body.annotation.author, "deepseek:deepseek-chat");
});

test("complete explanation retries are durable and cannot be reused for altered answers", async () => {
  const body = explanationPayload();
  const first = await http("POST", "/api/reader/explanations", body);
  const duplicate = await http("POST", "/api/reader/explanations", body);
  assert.equal(duplicate.status, 200); assert.equal(duplicate.body.replayed, true);
  assert.equal(duplicate.body.annotation.id, first.body.annotation.id);
  assert.equal((await http("POST", "/api/reader/explanations", { ...body, note: "Different answer" })).body.error.code, "idempotency_conflict");
  const restarted = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", "import { createReaderExplanation } from './src/store.js'; console.log(JSON.stringify(await createReaderExplanation(JSON.parse(process.argv[1]))));", JSON.stringify(body)], { cwd: new URL("..", import.meta.url), encoding: "utf8", env: { ...process.env, READING_MCP_DATA_DIR: directory } }));
  assert.equal(restarted.replayed, true); assert.equal(restarted.annotation.id, first.body.annotation.id);
});

test("private provider answers and their collections never leak to MCP, counts, cards or submission reads", async () => {
  const countBefore = (await jsonTool("reading_list_books")).find((book) => book.bookId === "demo").annotationCount;
  const parent = (await http("POST", "/api/reader/annotations", payload({ visibility: "shared" }))).body.annotation;
  const answer = (await http("POST", "/api/reader/explanations", explanationPayload({ parentId: parent.id, visibility: "private" }))).body.annotation;
  const collected = await http("POST", "/api/reader/collections", collectPayload(answer.id));
  assert.equal(collected.status, 201); assert.equal(collected.body.collection.annotation.id, answer.id);
  assert.ok(!(await store.listReaderCollections()).some((item) => item.annotationId === answer.id));
  assert.ok((await http("GET", "/api/reader/collections")).body.some((item) => item.annotationId === answer.id));
  for (const notes of [(await jsonTool("reading_list_annotations")), (await jsonTool("reading_read_chunk", { bookId: "demo", chunkId: "c1" })).annotations, (await jsonTool("reading_continue", { bookId: "demo" })).annotations]) assert.ok(!notes.some((item) => item.id === answer.id));
  assert.equal((await jsonTool("reading_list_books")).find((book) => book.bookId === "demo").annotationCount, countBefore + 1);
  assert.ok(!(await jsonTool("reading_submit_user_notes")).notes?.some((item) => item.id === answer.id));
  const parentCollection = (await http("POST", "/api/reader/collections", collectPayload(parent.id))).body.collection;
  assert.ok(!(await store.listReaderCollections()).find((item) => item.id === parentCollection.id).thread.some((item) => item.id === answer.id));
  await assert.rejects(jsonTool("reading_collect_card", { bookId: "demo", chunkId: "c1", quote, note: "Private copy", sourceAnnotationIds: [answer.id] }), /not available for sharing/);
});

test("follow-up explanations keep exact source and privacy follows a newly private human ancestor", async () => {
  const parent = (await http("POST", "/api/reader/annotations", payload({ visibility: "shared" }))).body.annotation;
  const answer = (await http("POST", "/api/reader/explanations", explanationPayload({ visibility: "shared", parentId: parent.id }))).body.annotation;
  const next = (await http("POST", "/api/reader/explanations", explanationPayload({ visibility: "shared", parentId: answer.id, question: "Give an example." }))).body.annotation;
  assert.equal(next.parentId, answer.id);
  const firstAnchor = { start: source.indexOf(quote), end: source.indexOf(quote) + quote.length };
  assert.equal((await http("POST", "/api/reader/explanations", explanationPayload({ parentId: answer.id, anchor: firstAnchor }))).body.error.code, "anchor_mismatch");
  const collection = (await http("POST", "/api/reader/collections", collectPayload(answer.id))).body.collection;
  assert.ok(collection.thread.some((item) => item.id === next.id));
  assert.ok((await store.listReaderCollections()).some((item) => item.id === collection.id));
  await http("PATCH", `/api/reader/annotations/${parent.id}`, { expectedRevision: 1, clientRequestId: requestId(), visibility: "private" });
  assert.ok(!(await store.listReaderCollections()).some((item) => item.id === collection.id));
  assert.ok(!(await jsonTool("reading_list_annotations")).some((item) => [parent.id, answer.id, next.id].includes(item.id)));
  assert.equal((await http("POST", "/api/reader/explanations", explanationPayload({ parentId: next.id, visibility: "shared" }))).body.error.code, "private_thread");
});

test("collection is a single live reference, replay safe, editable without altering author, and removable without deleting notes", async () => {
  const annotation = (await http("POST", "/api/reader/annotations", payload({ kind: "term", note: "", visibility: "shared" }))).body.annotation;
  const body = collectPayload(annotation.id);
  const first = (await http("POST", "/api/reader/collections", body)).body.collection;
  assert.equal((await http("POST", "/api/reader/collections", body)).body.replayed, true);
  assert.equal((await http("POST", "/api/reader/collections", { ...body, title: "Changed" })).body.error.code, "idempotency_conflict");
  const changed = (await http("POST", "/api/reader/collections", collectPayload(annotation.id, { kind: "knowledge", title: "A principle" }))).body.collection;
  assert.equal(changed.id, first.id); assert.equal(changed.revision, 2);
  assert.equal((await http("GET", "/api/reader/collections?bookId=demo&kind=knowledge")).body.filter((item) => item.annotationId === annotation.id).length, 1);
  await http("PATCH", `/api/reader/annotations/${annotation.id}`, { expectedRevision: 1, clientRequestId: requestId(), note: "My understanding, later" });
  const live = (await http("GET", "/api/reader/collections")).body.find((item) => item.id === first.id);
  assert.equal(live.annotation.note, "My understanding, later"); assert.equal(live.annotation.author, "user");
  assert.ok(!JSON.stringify(live).includes("_readerRequests"));
  for (let i = 0; i < 2; i++) assert.equal((await http("DELETE", `/api/reader/collections/${first.id}`)).status, 200);
  assert.equal((await http("POST", "/api/reader/collections", body)).body.error.code, "item_removed");
  assert.ok(!(await http("GET", "/api/reader/collections")).body.some((item) => item.id === first.id));
  assert.equal((await http("GET", `/api/reader/annotations/${annotation.id}`)).body.annotation.note, "My understanding, later");
  assert.notEqual((await http("POST", "/api/reader/collections", collectPayload(annotation.id))).body.collection.id, first.id);
});

test("marks validate exact selection, upsert styles and colors, remain separate from notes, and never resurrect on retry", async () => {
  const initialAnnotations = (await http("GET", "/api/annotations")).body.length;
  const body = markPayload();
  const first = (await http("POST", "/api/reader/marks", body)).body.mark;
  assert.equal(first.anchor.start, source.lastIndexOf(quote)); assert.equal(first.style, "highlight");
  assert.equal((await http("POST", "/api/reader/marks", body)).body.replayed, true);
  assert.equal((await http("POST", "/api/reader/marks", { ...body, color: "green" })).body.error.code, "idempotency_conflict");
  for (const [index, style] of ["ink", "underline", "sideline"].entries()) {
    const changed = (await http("POST", "/api/reader/marks", markPayload({ style, color: ["green", "blue", "pink"][index] }))).body.mark;
    assert.equal(changed.id, first.id); assert.equal(changed.style, style);
  }
  assert.equal((await http("GET", "/api/reader/marks?bookId=demo&chunkId=c1")).body.filter((item) => item.id === first.id).length, 1);
  for (const extra of [{ style: "dotted" }, { color: "red" }, { anchor: { start: 0, end: quote.length } }, { author: "user" }]) assert.equal((await http("POST", "/api/reader/marks", markPayload(extra))).status, 400);
  assert.equal((await http("GET", "/api/annotations")).body.length, initialAnnotations);
  for (let i = 0; i < 2; i++) assert.equal((await http("DELETE", `/api/reader/marks/${first.id}`)).status, 200);
  assert.equal((await http("POST", "/api/reader/marks", body)).body.error.code, "item_removed");
  assert.ok(!(await http("GET", "/api/reader/marks")).body.some((item) => item.id === first.id));
});

test("book deletion archives excerpt references and marks with their source data", async () => {
  const bookId = "archive-demo";
  await mkdir(path.join(directory, `books/${bookId}/chunks`), { recursive: true });
  await writeFile(path.join(directory, `books/${bookId}/chunks/c1.txt`), source);
  await writeFile(path.join(directory, `books/${bookId}/manifest.json`), JSON.stringify({ bookId, title: "Synthetic archive book", chunks: [{ id: "c1", title: "A chapter", order: 0, path: "chunks/c1.txt" }] }));
  const annotation = (await http("POST", "/api/reader/annotations", payload({ bookId, kind: "term", note: "" }))).body.annotation;
  const collection = (await http("POST", "/api/reader/collections", collectPayload(annotation.id))).body.collection;
  const mark = (await http("POST", "/api/reader/marks", markPayload({ bookId }))).body.mark;
  const removed = await store.deleteBook(bookId);
  const archive = JSON.parse(await readFile(path.join(removed.archivedAt, "deleted-book-data.json"), "utf8"));
  assert.ok(archive.removed.readerCollections.some((row) => row.id === collection.id));
  assert.ok(archive.removed.readerMarks.some((row) => row.id === mark.id));
  assert.equal((await http("GET", `/api/reader/collections?bookId=${bookId}`)).body.length, 0);
  assert.equal((await http("GET", `/api/reader/marks?bookId=${bookId}`)).body.length, 0);
  assert.equal((await http("GET", `/api/reader/annotations/${annotation.id}`)).status, 404);
});
