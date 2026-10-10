import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  annotatePassage,
  createReaderAnnotation,
  createReaderExplanation,
  listReaderCollections,
  collectReaderAnnotation,
  deleteReaderCollection,
  listReaderMarks,
  saveReaderMark,
  deleteReaderMark,
  updateReaderAnnotation,
  getReaderAnnotation,
  readerCapabilities,
  ReaderNoteError,
  collectCard,
  continueReading,
  deleteBook,
  dismissCard,
  getProgress,
  listCardInbox,
  listCardCollection,
  listCards,
  listAnnotations,
  listBooks,
  listChunks,
  markRead,
  readCard,
  readChunk,
  replyToAnnotation,
  searchChunks,
  submitUserNotes,
} from "./store.js";
import { importBook } from "./importer.js";
import { renderCardPng, renderCardSvg } from "./card-renderer.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const publicDir = path.join(ROOT, "public");
const defaultMaxBodyBytes = Number(process.env.READING_HTTP_MAX_BODY_BYTES || process.env.READING_IMPORT_MAX_BYTES || 25_000_000);

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

export function sendJson(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(value, null, 2));
}

export function sendError(res, status, message) {
  sendJson(res, status, { error: message });
}

export async function readBody(req, { maxBytes = defaultMaxBodyBytes, allowEmpty = true } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes`);
    chunks.push(chunk);
  }
  if (!chunks.length) {
    if (allowEmpty) return {};
    throw new Error("Missing JSON body");
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function routeParts(url) {
  return url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));
}

export async function handleApi(req, res, url, options = {}) {
  const parts = routeParts(url);
  const maxBytes = options.maxBodyBytes || defaultMaxBodyBytes;

  if (parts[1] === "reader") {
    try {
      if (req.method === "GET" && parts.length === 3 && parts[2] === "capabilities") return sendJson(res, 200, readerCapabilities);
      if (req.method === "GET" && parts.length === 3 && parts[2] === "collections") return sendJson(res, 200, await listReaderCollections({ bookId: url.searchParams.get("bookId") || undefined, kind: url.searchParams.get("kind") || undefined, includePrivate: true }));
      if (req.method === "GET" && parts.length === 3 && parts[2] === "marks") return sendJson(res, 200, await listReaderMarks({ bookId: url.searchParams.get("bookId") || undefined, chunkId: url.searchParams.get("chunkId") || undefined }));
      if (req.method === "GET" && parts.length === 4 && parts[2] === "annotations") return sendJson(res, 200, await getReaderAnnotation(parts[3]));
      if (req.method === "DELETE" && parts.length === 4 && ["collections", "marks"].includes(parts[2])) {
        return sendJson(res, 200, await (parts[2] === "collections" ? deleteReaderCollection(parts[3]) : deleteReaderMark(parts[3])));
      }
      const create = req.method === "POST" && parts.length === 3 && ["annotations", "explanations", "collections", "marks"].includes(parts[2]);
      const edit = req.method === "PATCH" && parts.length === 4 && parts[2] === "annotations";
      if (create || edit) {
        let body;
        try { body = await readBody(req, { maxBytes: Math.min(maxBytes, 160000), allowEmpty: false }); }
        catch (error) {
          const tooLarge = /exceeds/.test(error.message || "");
          return sendJson(res, tooLarge ? 413 : 400, { error: { code: tooLarge ? "too_large" : "invalid_request", message: tooLarge ? "Reader request is too large" : "A valid JSON reader request is required" } });
        }
        const handlers = { annotations: createReaderAnnotation, explanations: createReaderExplanation, collections: collectReaderAnnotation, marks: saveReaderMark };
        const result = edit ? await updateReaderAnnotation(parts[3], body) : await handlers[parts[2]](body);
        return sendJson(res, create && !result.replayed ? 201 : 200, result);
      }
      return sendJson(res, 404, { error: { code: "not_found", message: "Reader endpoint was not found" } });
    } catch (error) {
      if (!(error instanceof ReaderNoteError)) throw error;
      return sendJson(res, error.status, { error: { code: error.code, message: error.message, ...(error.latest ? { latest: error.latest } : {}) } });
    }
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "books") {
    return sendJson(res, 200, await listBooks({ includePrivate: true }));
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "books" && parts[3] === "chunks") {
    return sendJson(res, 200, await listChunks(parts[2], { includePrivate: true }));
  }

  if (req.method === "DELETE" && parts.length === 3 && parts[1] === "books") {
    return sendJson(res, 200, await deleteBook(parts[2]));
  }

  if (req.method === "GET" && parts.length === 5 && parts[1] === "books" && parts[3] === "chunks") {
    return sendJson(res, 200, await readChunk(parts[2], parts[4]));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "continue") {
    return sendJson(res, 200, await continueReading({ bookId: url.searchParams.get("bookId") || undefined }));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "annotations") {
    return sendJson(
      res,
      200,
      await listAnnotations({
        bookId: url.searchParams.get("bookId") || undefined,
        chunkId: url.searchParams.get("chunkId") || undefined,
        kind: url.searchParams.get("kind") || undefined,
        author: url.searchParams.get("author") || undefined,
        status: url.searchParams.get("status") || undefined,
        parentId: url.searchParams.has("parentId") ? url.searchParams.get("parentId") : undefined,
        includePrivate: true,
      }),
    );
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "cards") {
    return sendJson(
      res,
      200,
      await listCards({
        includePrivate: true,
        bookId: url.searchParams.get("bookId") || undefined,
        chunkId: url.searchParams.get("chunkId") || undefined,
        source: url.searchParams.get("source") || undefined,
        limit: Number(url.searchParams.get("limit") || 20),
        offset: Number(url.searchParams.get("offset") || 0),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "card-collection") {
    return sendJson(
      res,
      200,
      await listCardCollection({
        includePrivate: true,
        bookId: url.searchParams.get("bookId") || undefined,
        limit: Number(url.searchParams.get("limit") || 12),
        offset: Number(url.searchParams.get("offset") || 0),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "card-inbox") {
    return sendJson(
      res,
      200,
      await listCardInbox({
        includePrivate: true,
        bookId: url.searchParams.get("bookId") || undefined,
        limit: Number(url.searchParams.get("limit") || 10),
      }),
    );
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "cards" && parts[3] === "image.svg") {
    const card = await readCard(parts[2], { includePrivate: true });
    res.writeHead(200, { "content-type": "image/svg+xml; charset=utf-8" });
    res.end(renderCardSvg(card));
    return;
  }

  if (req.method === "GET" && parts.length === 4 && parts[1] === "cards" && parts[3] === "image.png") {
    const card = await readCard(parts[2], { includePrivate: true });
    res.writeHead(200, { "content-type": "image/png" });
    res.end(renderCardPng(card));
    return;
  }

  if (req.method === "POST" && parts.length === 4 && parts[1] === "cards" && parts[3] === "dismiss") {
    return sendJson(res, 200, await dismissCard(parts[2], { includePrivate: true }));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "cards") {
    const body = await readBody(req, { maxBytes });
    return sendJson(res, 201, await collectCard({ ...body, createdBy: "human" }, { includePrivate: true }));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "annotations") {
    const body = await readBody(req, { maxBytes });
    return sendJson(
      res,
      201,
      await annotatePassage({
        ...body,
        author: "user", role: "human", displayName: "读者",
        status: body.status || "open",
      }),
    );
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "replies") {
    const body = await readBody(req, { maxBytes });
    return sendJson(
      res,
      201,
      await replyToAnnotation({
        ...body,
        author: "user", role: "human", displayName: "读者",
        kind: body.kind || "reply",
      }),
    );
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "submit-notes") {
    return sendJson(res, 200, await submitUserNotes(await readBody(req, { maxBytes })));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "mark-read") {
    const body = await readBody(req, { maxBytes });
    return sendJson(res, 200, await markRead(body.bookId, body.chunkId));
  }

  if (req.method === "POST" && parts.length === 2 && parts[1] === "import") {
    return sendJson(res, 201, await importBook(await readBody(req, { maxBytes })));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "progress") {
    return sendJson(res, 200, await getProgress(url.searchParams.get("bookId") || undefined));
  }

  if (req.method === "GET" && parts.length === 2 && parts[1] === "search") {
    return sendJson(
      res,
      200,
      await searchChunks({
        bookId: url.searchParams.get("bookId") || undefined,
        query: url.searchParams.get("q") || "",
        limit: Number(url.searchParams.get("limit") || 10),
      }),
    );
  }

  return sendError(res, 404, "Not found");
}

export async function serveStatic(req, res, url) {
  const requested = url.pathname === "/" ? "reader.html" : url.pathname.slice(1);
  const resolved = path.resolve(publicDir, requested);
  const relative = path.relative(publicDir, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return sendError(res, 403, "Forbidden");
  }

  try {
    const body = await readFile(resolved);
    res.writeHead(200, {
      "content-type": contentTypes[path.extname(resolved)] || "application/octet-stream",
    });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") return sendError(res, 404, "Not found");
    throw error;
  }
}
