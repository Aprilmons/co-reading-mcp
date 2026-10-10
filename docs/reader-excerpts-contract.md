# Reader excerpts and explanations v1 (server 0.3.0)

These authenticated human-reader routes extend [Reader Notes v1](reader-notes-contract.md).
They use the same serialized store lock and strict source selections. The server
stores completed answers; it does not call model APIs or hold their API keys.
Provider calls, response validation, and the decision to save a completed response
belong to Home's trusted native process.

## Capabilities and compatibility

`GET /api/reader/capabilities` retains `readerAnnotations.version: 1` and adds:

```json
{
  "readerExplanations": {"version":1,"write":true,"maxQuestionLength":8000,"maxNoteLength":20000},
  "readerCollections": {"version":1,"write":true,"kinds":["word","term","knowledge"]},
  "readerMarks": {"version":1,"write":true,"styles":["highlight","ink","underline","sideline"],"colors":["yellow","green","blue","pink","purple"],"anchorEncoding":"utf16"}
}
```

Reader annotations also advertise `kinds: ["annotation","word","term","knowledge"]`
and `tags: true`. Clients must check each relevant capability before writing. Old
read routes, human notes, MCP author attribution, and privacy rules are unchanged.
No new MCP tool is needed: shared explanations are ordinary annotations returned by
existing annotation/read/continue tools. Collections and marks are human-reader
management surfaces, not separate copies of shared notes.

## Human vocabulary, terms, and knowledge notes

`POST /api/reader/annotations` additionally accepts optional `kind` and `tags`.
`PATCH /api/reader/annotations/:id` accepts those fields with the existing
`expectedRevision` and `clientRequestId` requirements. Supported kinds are
`annotation`, `word`, `term`, and `knowledge`. Tags are at most 20 nonempty strings,
each at most 80 UTF-16 units. Duplicate tags are collapsed.

Human `word`, `term`, and `knowledge` annotations may have `note: ""`: collecting
a quotation does not require inventing an understanding. Ordinary annotations and
all model explanations still require non-whitespace notes. Changing an empty
excerpt back to an ordinary annotation requires supplying a note in the same
update. Quote and anchor always remain separate and immutable. Replies without
an explicit kind retain the existing `reply` kind.

## Completed model explanations

`POST /api/reader/explanations` accepts exactly:

```json
{
  "bookId":"demo", "chunkId":"c1", "quote":"A selected term",
  "anchor":{"start":0,"end":15},
  "question":"Explain this term in this passage.",
  "note":"The completed model answer.",
  "provider":"openrouter", "model":"provider/model-id",
  "visibility":"private", "clientRequestId":"explain-unique-001"
}
```

Offsets are illustrative; `text.slice(start,end)` must exactly equal `quote`.
The existing source bounds are retained: quote 1–12000 UTF-16 units and answer
1–20000 units. Question is 1–8000 units. `provider` is `openrouter` or `deepseek`;
`model` is a provider model identifier of at most 240 ASCII units (letters, digits,
period, underscore, colon, slash, at-sign, plus, or hyphen). Home supplies the
model identifier reported by the successful API response, not a UI persona label.

`parentId` is optional. A follow-up must retain its parent's book, chunk, exact
quote, and UTF-16 anchor. Sharing a reply requires every ancestor to be shared.
Private remains the default when `visibility` is omitted.

The response is `{ "annotation": { ... } }`, with `replayed: true` on retry. The
server sets `role: "assistant"`, `kind: "explanation"`, and derives `author` as
`provider:model`. The display name includes the provider and model. Metadata is
`explanation: { provider, model, question }`. Caller-supplied author, display name,
role, kind, or timestamps are rejected. Provider/model provenance is an assertion
by the authenticated native client, not independent cryptographic attestation by
COREADING. The reader cannot edit the model's text as their own; personal
understandings are human replies under it.

The exact completed request and stable request ID are retried after an uncertain
save. Replays survive process restarts and do not generate another annotation.
Changed content under the same ID returns `409 idempotency_conflict`.

## One note, multiple views

`GET /api/reader/collections?bookId=...&kind=...` returns an array. Both filters
are optional. `POST /api/reader/collections` accepts:

```json
{"annotationId":"ann_...","kind":"term","title":"An operational definition","clientRequestId":"collect-unique-001"}
```

`kind` is `word`, `term`, or `knowledge`; title is 1–240 UTF-16 units. It returns
`{ "collection": { ... } }`, with `replayed: true` on retry. A collection contains
`id`, `annotationId`, `bookId`, `chunkId`, `kind`, `title`, `revision`, `createdAt`,
and `updatedAt`. Responses also include the current `annotation` and `thread`
(root, ancestors and descendants in source order), assembled at read time. No
copy of the annotation, answer, or thread text is persisted in the collection.

There is one active reference per annotation. Posting a new request ID for an
already-collected annotation updates its kind/title and increments collection
revision. This never mutates the note's author, content, or visibility. Revision
is returned for refresh/display; POST is a personal collection upsert, not a
revision-preconditioned note edit. Changing the original human note is immediately
reflected in collection reads. A private original or ancestor remains private to
assistant consumers, including descendants and existing cards/submissions. The
authenticated human reader can see their private records.

`DELETE /api/reader/collections/:id` removes only the reference, returning
`{ "deleted": true, "id": "collection_..." }`. Original annotation and replies
remain. Repeating DELETE succeeds. Removed items retain a minimal stored tombstone
with request history so an old POST retry returns `409 item_removed` rather than
resurrecting a removed item. A deliberate new collection uses a new request ID
and gets a new collection ID.

## Persistent mark styles

`GET /api/reader/marks?bookId=...&chunkId=...` returns an array with optional
source filters. `POST /api/reader/marks` accepts exactly `bookId`, `chunkId`,
`quote`, `anchor`, `style`, `color`, and `clientRequestId`. Source selections use
the same exact UTF-16 validation as annotations. Styles and colors are the
capability values above. The result is `{ "mark": { ... } }` plus `replayed: true`
on retry; a mark retains source selection, visual style, timestamps, and revision.

Posting a new request for the same exact range changes the existing mark's style
and color; overlapping but different selections remain distinct. Marks are
reader-owned visual records and never enter annotation counts, MCP notes, cards,
or submissions. They neither overwrite nor erase a note on the same text.

`DELETE /api/reader/marks/:id` removes only that mark. It uses the same tombstone
and replay behavior as collections. Removing several overlapping marks requires
explicitly deleting each selected ID; no broad source-range deletion is implied.

## Data and errors

New data files are `reader-collections.jsonl` and `reader-marks.jsonl`. Existing
books and annotations need no migration. Deleting a book archives these records
with the other book data before removing them from the active store.

Request JSON is limited to 160000 bytes and uses the existing structured errors.
Unknown fields are rejected. All identity and source errors occur before a write.
Public responses never include the internal `_readerRequests` history. The existing
single-process store transaction model remains unchanged.
