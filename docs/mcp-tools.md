# MCP Tools

Version 0.2.0 requires a tool-schema refresh/reconnection after upgrade.
`reading_annotate_passage` and `reading_reply_to_annotation` require the caller's
truthful `author` (for example `codex` or `claude`); `displayName` is optional.
These tools always create shared assistant records, never human notes. Cached old
tools without author return `identity_required`. Existing records are unchanged.
See [Reader Notes v1](reader-notes-contract.md) for human writing and visibility.

## `reading_list_books`

Returns all imported books with progress and annotation counts. Annotation counts are cached by `annotations.jsonl` file signature so repeated calls do not re-parse the JSONL file unless it changes.

## `reading_list_chunks`

Input:

```json
{ "bookId": "anthropic-guidelines" }
```

Returns chunks in reading order, including `prevId`, `nextId`, `read`, and `annotationCount`.

## `reading_read_chunk`

Input:

```json
{ "bookId": "anthropic-guidelines", "chunkId": "ch00" }
```

Returns the chunk text plus neighboring ids and `annotations`, the current shared
notes/replies for that chunk. Private notes and descendants are excluded. This
read does not mark the passage read or consume shared notes.

## `reading_continue`

Input:

```json
{ "bookId": "anthropic-guidelines" }
```

`bookId` is optional. When omitted, the server uses the most recently read book.

Returns the next unread chunk after `lastChunkId`. If `lastChunkId` is missing or stale, it falls back to the first unread chunk. If the book is already complete, it returns `completed: true` and a progress summary instead of chunk text.

## `reading_search_chunks`

Input:

```json
{ "bookId": "anthropic-guidelines", "query": "values", "limit": 10 }
```

Returns matching snippets.

Chunk text is cached by file signature after first read. Search is still a simple substring scan, but repeated searches avoid re-reading every chunk from disk.

## `reading_import_book`

Input:

```json
{
  "filename": "book.epub",
  "dataBase64": "...",
  "bookId": "optional-stable-id",
  "overwrite": false
}
```

Imports one EPUB or TXT/Markdown file from base64 content. Use this when the file fits inside one MCP request. `dataBase64` can be raw base64 or a `data:*;base64,...` URL.

For TXT/Markdown imports, optional fields mirror `scripts/import_text.py`:

```json
{
  "filename": "book.txt",
  "dataBase64": "...",
  "title": "Book Title",
  "author": "Author",
  "headingRegex": "^Chapter\\s+\\w+",
  "minSectionChars": 100,
  "maxChars": 6000
}
```

The server validates the file type, upload size, and `bookId`, writes the book into `data/books`, and returns the imported `bookId`, title, and chunk count.

## `reading_delete_book`

Input:

```json
{ "bookId": "anthropic-guidelines", "confirm": true }
```

Deletes a book from the active library. This is a soft delete: the book folder and removed active records are archived under `data/trash/books/...`.

The active `progress.json`, `annotations.jsonl`, `submissions.jsonl`, `cards.jsonl`, and session context ledger are rewritten without records for that book, so re-importing the same `bookId` starts cleanly. The tool requires `confirm: true` to avoid accidental deletion. Trash is pruned after 30 days by default; set `READING_TRASH_RETENTION_DAYS=0` to keep trash forever.

## Chunked Import

Use chunked import when a file is too large for one JSON-RPC body.

1. Start:

```json
{
  "filename": "large.epub",
  "expectedBytes": 1234567,
  "bookId": "large-book"
}
```

Call `reading_import_begin` and keep the returned `uploadId`.

2. Append base64 parts:

```json
{
  "uploadId": "...",
  "index": 0,
  "dataBase64": "..."
}
```

Call `reading_import_part` once per binary part. Each part should be independently base64-encoded; do not split a single base64 string at arbitrary characters.

3. Finish:

```json
{ "uploadId": "..." }
```

Call `reading_import_finish` to run the importer. Use `reading_import_cancel` to discard an unfinished upload.

## `reading_annotate_passage`

Input:

```json
{
  "bookId": "anthropic-guidelines",
  "chunkId": "ch00",
  "quote": "this line matters",
  "note": "This is a resonance note.",
  "author": "claude",
  "kind": "resonance",
  "mood": "quiet",
  "tags": ["identity"]
}
```

Writes one shared assistant annotation. If the quote is present in the chunk, the
returned object includes a `quoteOffset`. MCP responses omit ordinal counts that
could reveal private notes. Author role and published status are fixed by the
server; do not pass `status`, `role`, or `visibility` to an assistant tool.

For the legacy user-facing HTTP API only, create staged notes with the following
payload. New clients should use the precise [Reader Notes API](reader-notes-contract.md):

```json
{
  "bookId": "anthropic-guidelines",
  "chunkId": "ch00",
  "quote": "this line matters",
  "note": "I want Claude to comment on this.",
  "author": "user",
  "status": "open"
}
```

## `reading_list_annotations`

Input:

```json
{ "bookId": "anthropic-guidelines", "chunkId": "ch00", "kind": "resonance", "status": "published" }
```

All fields are optional except `bookId` in most practical use.

By default this tool hides human notes with `status: "open"`, `"private"`, or `"draft"` and hides replies under those private notes. This lets a reader save notes and leave without exposing them to Claude. A trusted local UI can pass `includePrivate: true`; Claude-facing MCP clients should not.

## `reading_submit_user_notes`

Input:

```json
{
  "bookId": "anthropic-guidelines",
  "sessionId": "claude-session-2026-05-22",
  "contextMode": "chunk-once-per-session"
}
```

Finds all user annotations with `status: "open"`, `"private"`, or `"draft"`, returns them as one batch for Claude, and rewrites them to `status: "submitted"` so the same notes are not sent again.

This is the tool a companion app or Claude-facing integration should call when the user taps “Send notes to Claude”. In the built-in browser reader, this action publishes the private notes so Claude can retrieve them through MCP and returns the context package to the HTTP caller; it is not a push notification into claude.ai by itself.

By default, `contextMode` is `chunk-once-per-session`: the first submitted user note for a chunk includes that chunk's full text in `context.chunks`. Later notes for the same chunk and `sessionId` only send the new notes, with the repeated chunk listed in `context.omittedChunks`. A new `sessionId` starts fresh and includes the chunk again.

Supported context modes:

- `chunk-once-per-session`: default; send each chunk once per Claude session
- `chunk-always`: include full chunk text every time
- `notes-only`: send only the submitted notes and quote anchors

Set `forceChunkContext: true` to re-send chunk text inside the same session.

Each successful submit also writes a submission batch. Use `reading_list_submissions` to find recent shared batches and `reading_read_submission` to read one batch with notes and context.

## `reading_list_submissions`

Input:

```json
{ "bookId": "anthropic-guidelines", "limit": 10 }
```

Returns recent human note submission summaries. The summary includes `id`, `submittedAt`, note ids, chunk ids, and a compact context summary.

## `reading_read_submission`

Input:

```json
{ "submissionId": "sub_..." }
```

Returns one submitted batch with its notes and context package.

## `reading_reply_to_annotation`

Input:

```json
{
  "parentId": "ann_guidelines_user_001",
  "author": "claude",
  "note": "Claude's reply under this user note.",
  "kind": "reply"
}
```

Creates an explicitly signed assistant annotation with `parentId` pointing to a
currently shared note. If `bookId`, `chunkId`, or `quote` are omitted, they are
inherited from the parent, including its exact selected occurrence. Private
parents are unavailable to this tool.

## `reading_mark_read`

Input:

```json
{ "bookId": "anthropic-guidelines", "chunkId": "ch00" }
```

Marks a chunk as read and updates `lastChunkId`. The response includes `chunksRead`, `chunkCount`, `complete`, and a human-readable `message`.

When the marked chunk completes the book, the response also includes:

```json
{
  "finish": {
    "annotationCount": 32,
    "moodCounts": { "quiet": 4 },
    "kindCounts": { "resonance": 12, "feeling": 5 },
    "celebration": {
      "title": "Book finished, margins preserved.",
      "line": "The reading is done; the conversation can keep unfolding from any note.",
      "prompt": "Write a short closing note that feels like placing a bookmark after the final page."
    },
    "message": "Congratulations, Book Title is complete: 43/43 chunks, 32 annotations."
  }
}
```

`finish.celebration` is intentionally small and variable. Claude can use it as a closing ritual, or a frontend can ignore it and keep only the stable counts.

## `reading_collect_card`

Input:

```json
{
  "bookId": "anthropic-guidelines",
  "chunkId": "ch00",
  "kicker": "收获了一枚回声书签",
  "title": "Book Title",
  "quote": "a sentence worth carrying forward",
  "note": "Why this passage became a card.",
  "art": "fold"
}
```

Collects a small ritual reading card/bookmark for later. `art` can be `fold`, `ripple`, or `stardust`. Use this for completed sections, shared-margin moments, or quiet passages worth carrying forward.

## `reading_card_inbox`

Input:

```json
{ "bookId": "anthropic-guidelines", "limit": 10 }
```

Returns only unread card prompts, such as “收获了一枚回声书签”, with the `cardId` needed to open or dismiss them. This is the reader-facing flow Claude should use instead of reading raw card data.

## `reading_open_card`

Input:

```json
{ "cardId": "card_..." }
```

Returns the selected card as image content so Claude can view it directly. If Playwright Chromium is installed, the card is rendered as a polished PNG from the same HTML/CSS card template used by the reader; otherwise the server falls back to an SVG image. The text part is only a short caption.

## `reading_save_card`

Input:

```json
{ "cardId": "card_..." }
```

Renders the selected card to a local image file and returns its absolute path plus `mimeType`. Use this when the host client can send local files after MCP returns a path.

## `reading_dismiss_card`

Input:

```json
{ "cardId": "card_..." }
```

Marks a card as dismissed so it no longer appears in `reading_card_inbox`. The card remains in `cards.jsonl` and can still be found with `reading_list_cards`.

## `reading_list_cards`

Input:

```json
{ "bookId": "anthropic-guidelines", "limit": 10 }
```

Lists collected cards, newest first. Cards are stored separately from annotations in `cards.jsonl`, so they can act like lightweight bookmarks instead of new margin notes.

## `reading_get_progress`

Input:

```json
{ "bookId": "anthropic-guidelines" }
```
