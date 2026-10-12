# Book covers · 0.3.1

This is an additive HTTP feature. All routes remain under the existing API
authentication. No new MCP write tool or permissions are introduced.

## Discovery and reading

`GET /api/reader/capabilities` adds:

```json
{
  "bookCovers": {
    "version": 1,
    "get": true,
    "write": true,
    "epub": true,
    "ifAbsent": true,
    "maxBytes": 524288,
    "maxEpubBytes": 25000000,
    "mimeTypes": ["image/jpeg", "image/png", "image/webp"]
  }
}
```

Every `GET /api/books` item adds `cover: null` or metadata of this shape:

```json
{"mimeType":"image/jpeg","sha256":"<64 lowercase hex characters>","width":424,"height":640}
```

`GET /api/books/:bookId/cover` returns:

```json
{"bookId":"existing-book","cover":{"mimeType":"image/jpeg","sha256":"<sha256>","width":424,"height":640,"dataBase64":"<canonical base64>"}}
```

An existing book without a cover returns HTTP 200 with `cover: null`. An unknown
book returns HTTP 404. List responses omit image bytes; clients can fetch by
book ID and cache by source identity, book ID and SHA-256. Clients should retrieve
the image in their trusted process using the existing authorization header;
credentials must not be placed into an image URL or renderer-visible data.

## Cover-only updates

`POST /api/books/:bookId/cover` accepts exactly one of:

```json
{"mimeType":"image/png","dataBase64":"<image, at most 512 KiB decoded>"}
```

```json
{"format":"epub","dataBase64":"<EPUB, at most 25,000,000 bytes decoded>"}
```

The response is HTTP 200 with `{bookId, cover}` metadata, without `dataBase64`.
Either request type also accepts optional `ifAbsent: true` (default `false`). This
checks for an existing cover inside the same write lock as the eventual save: if a
cover already exists, its metadata is returned and its file is left byte-for-byte
unchanged. Use this for one-time cover backfills so later user-selected images are
never replaced. The client should then GET the returned cover instead of assuming
the uploaded image became current.
The image variant supports JPEG, PNG and WebP. Both paths decode and re-encode the
image as a JPEG thumbnail with a maximum edge of 640 pixels and a maximum size
of 512 KiB. The resulting hash is over the normalized image, not the input.

This endpoint only operates on an existing book and writes one atomic `cover.json`
file within its book directory. The manifest, chapter text, chunk IDs, annotations,
marks, collections and reading progress are not rewritten. This is deliberately
separate from normal book import or `overwrite: true`.

EPUB source files exist only in a temporary directory during processing and are
removed after success or failure. New EPUB imports use the same extraction logic
and save an optional `cover.json` alongside their existing manifest and chunks.
EPUB3 `cover-image`, EPUB2 metadata cover IDs and explicit guide cover pages are
supported. Missing covers leave the text readable and the client may use a fallback.

## Bounds and errors

Canonical base64, MIME agreement, actual decoding, pixel dimensions and image size
are checked. Images are decoded at no more than 24 million pixels, metadata is
discarded, and SVG is not accepted as an uploaded image. ZIP member paths,
duplicates, encrypted members, member count and expanded sizes are checked; EPUB
contents are read from ZIP members without extracting filesystem paths. XML entity
declarations and internal DTD subsets are rejected; ordinary XHTML DOCTYPEs do not
load external DTDs. Processing has a 20 second timeout.

Errors are JSON `{error:{code,message}}`:

- 400 `invalid_cover`: invalid body, base64, image, EPUB or unsafe content.
- 400 `cover_not_found`: no supported cover image in the supplied EPUB.
- 413 `too_large`: upload exceeds the corresponding limit.
- 404 `not_found`: target book does not exist.
- 405 `method_not_allowed`: use GET or POST for the cover route.
- 401: existing API authentication failed.

A failed update leaves the previous cover and all reading data unchanged. A
damaged stored cover reports an error from its dedicated read endpoint, while
book-list rendering falls back to `cover: null` and keeps the book visible.

## Verification

`npm test` includes authenticated HTTP tests, unchanged-byte checks for existing
book data, missing/invalid upload behavior, large-base64 handling, automatic new
imports, and Python fixtures for EPUB2/EPUB3/guide covers, normal XHTML DOCTYPEs,
UTF-16 entity declarations, ZIP paths, pixel bounds and metadata removal.
