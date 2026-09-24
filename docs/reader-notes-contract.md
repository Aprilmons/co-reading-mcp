# Reader Notes v1

Implementation baseline: `3dd57be3a384fc0667f09af8575c62b2279051ba`.

These authenticated human-reader endpoints supplement the existing API. Existing
array-shaped GET endpoints remain compatible. The service is one shared personal
library; visibility is not a per-model recipient list. Making a note private stops
future tool retrieval but cannot erase copies already read by a person or model.

## Capabilities

`GET /api/reader/capabilities` returns:

```json
{"readerAnnotations":{"version":1,"write":true,"reply":true,"visibility":true,"maxNoteLength":20000,"maxQuoteLength":12000,"anchorEncoding":"utf16"}}
```

A missing/unsupported capability leaves old clients in read-only mode. Do not
probe write routes to discover support.

## Create, edit, and read back

`POST /api/reader/annotations` accepts:

```json
{"bookId":"demo","chunkId":"c1","quote":"A synthetic sentence.","note":"My thought.","anchor":{"start":0,"end":21},"visibility":"private","clientRequestId":"unique-request-001"}
```

`parentId` is optional for a reply. Parent book/chunk must match. Offsets count
JavaScript UTF-16 code units and `text.slice(start,end)` must exactly equal quote.
The example offsets are illustrative; clients compute them from the actual text.
`quote` is 1–12000 units and `note` 1–20000 units, each with non-whitespace content.
No caller-provided role, author, status, timestamp, or revision is accepted.

`PATCH /api/reader/annotations/:id` accepts `expectedRevision`, `clientRequestId`,
and one or both of `note` and `visibility`. Only human-authored notes are editable;
quote, source anchor, parent, and authorship remain unchanged. New notes begin at
revision 1; old notes without revision are treated as revision 1. A shared reply
requires all its ancestors to be shared.

`GET /api/reader/annotations/:id` retrieves the authoritative human-reader view.
Successful calls return `{ "annotation": { ... } }`. The annotation retains old
fields (`author`, `quoteOffset`, `status`, etc.) and adds `role`, `displayName`,
`visibility`, `revision`, `anchor`, and `updatedAt`. Reader writes use canonical
`author: "user"`, `role: "human"`, `displayName: "读者"`. Clients may display a
local name without changing that ownership role. Private uses `status: "private"`;
shared uses `status: "published"`.

`clientRequestId` is 8–120 ASCII letters/digits/underscore/hyphen. Retry the exact
same request with the same ID after an uncertain network result. Replays do not
write again and return the current authoritative annotation. Reusing an ID for
different content is a conflict. Revision checks, idempotency, and writes share
the same serialized store transaction used by MCP annotations and submissions.

Errors have `{ "error": { "code": "...", "message": "..." } }`:

- `409 revision_conflict` additionally includes `error.latest`.
- `409 idempotency_conflict` rejects changed payload with a reused request ID.
- `409 private_thread` rejects sharing a reply under a private ancestor.
- `400 invalid_request` / `anchor_mismatch`, `403 not_owner`, `404 not_found`,
  and `413 too_large` describe other validation failures.

## Assistant tools and visibility

MCP annotation/reply writes require explicit assistant `author` and optional
`displayName`; the service fixes role to assistant and refuses human aliases.
Identity is a truthful caller assertion, not cryptographic model attestation.
Existing Claude records retain their original authorship. Missing identity is an
error rather than silently attributing new writing to Claude.

MCP read/continue return `annotations` containing the current shared annotations
for that chunk, including shared replies. MCP listing/search/submission/card paths
never opt into human-private records. All ancestors must be visible. Historical
submission batches are filtered against current visibility when read. Explicit
private notes are never bulk-submitted; legacy open/draft staging remains supported.
Shared notes can be read repeatedly by any connected partner; they are not consumed.

## Isolated test service

Set `READING_MCP_DATA_DIR` to a temporary fixture directory, `MCP_SSE_HOST=127.0.0.1`,
`MCP_SSE_PORT` to an unused port, and `MCP_AUTH_TOKEN` to a synthetic fixture token;
run `node src/server-sse.js`. Send `Authorization: Bearer <fixture token>`.
Never use production data or credentials in tests.

A minimal fixture is `books/demo/manifest.json` with a title, `bookId: "demo"`,
and `chunks: [{"id":"c1","title":"Chapter One","order":0,"path":"chunks/c1.txt"}]`,
plus the synthetic UTF-8 file `books/demo/chunks/c1.txt`.
