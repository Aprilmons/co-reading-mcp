import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildCardCandidates, findSharedMoments } from "../public/card-logic.js";

test("cards never expose private annotations or revoked copies through shared reads", async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "co-reading-card-privacy-"));
  process.env.READING_MCP_DATA_DIR = fixture;
  const store = await import("../src/store.js");
  const { callTool } = await import("../src/server.js");
  const bookId = "privacy-fixture";
  const quote = "A sentence shared by two readers in this chapter.";
  const secret = "PRIVATE_FIXTURE_NOTE_DO_NOT_EXPOSE";
  const bookDir = path.join(fixture, "books", bookId);
  const writeRows = (name, rows) => writeFile(path.join(fixture, name), rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  let annotations = [
    { id: "private-human", bookId, chunkId: "ch1", author: "Rocky", role: "human", displayName: "Rocky", status: "published", visibility: "private", quote, note: secret, mood: "SECRET_MOOD", kind: "SECRET_KIND" },
    { id: "private-child", bookId, chunkId: "ch1", author: "Sol", role: "assistant", status: "published", parentId: "private-human", quote, note: "PRIVATE_CHILD_COPY" },
    { id: "shared-assistant", bookId, chunkId: "ch1", author: "astra", role: "assistant", displayName: "Astra", status: "published", quote, note: "Public assistant observation", kind: "resonance" },
    { id: "shared-human", bookId, chunkId: "ch2", author: "user", role: "human", displayName: "Rocky", status: "submitted", visibility: "shared", quote, note: "Shared human observation", kind: "resonance" },
  ];
  const base = { bookId, chunkId: "ch1", createdAt: "2026-09-24T00:00:00Z", status: "new", title: "Fixture card", quote, note: "Public card" };
  const cards = [
    { ...base, id: "legacy-section", chunkId: "ch2", note: secret, context: { segmentChunkIds: ["ch1", "ch2"] } },
    { ...base, id: "legacy-book", chunkId: "ch2", note: secret, scope: "book" },
    { ...base, id: "legacy-manual", note: secret, source: "manual" },
    { ...base, id: "legacy-global", bookId: null, chunkId: null, note: secret },
    { ...base, id: "legacy-safe", chunkId: "ch2" },
    { ...base, id: "new-safe", sourceAnnotationIds: ["shared-assistant"] },
    { ...base, id: "new-private", note: secret, sourceAnnotationIds: ["private-human"] },
    { ...base, id: "new-private-child", note: "PRIVATE_CHILD_COPY", sourceAnnotationIds: ["private-child"] },
    { ...base, id: "new-missing-source", sourceAnnotationIds: ["deleted-annotation"] },
    { ...base, id: "explicit-private", visibility: "private", sourceAnnotationIds: [] },
  ];
  try {
    await mkdir(bookDir, { recursive: true });
    await writeFile(path.join(bookDir, "manifest.json"), JSON.stringify({ bookId, title: "Privacy Fixture", chunks: [
      { id: "ch1", index: 0, title: "First Chapter", path: "ch1.txt", sectionTitle: "First Chapter", nextId: "ch2" },
      { id: "ch2", index: 1, title: "Second Chapter", path: "ch2.txt", sectionTitle: "Second Chapter", prevId: "ch1" },
    ] }));
    await writeFile(path.join(bookDir, "ch1.txt"), quote.repeat(8));
    await writeFile(path.join(bookDir, "ch2.txt"), quote.repeat(8));
    await writeRows("annotations.jsonl", annotations);
    await writeRows("cards.jsonl", cards);

    await t.test("legacy spans, source IDs, and private descendants are checked at every read", async () => {
      const visible = await store.listCards({ limit: 100 });
      assert.deepEqual(visible.map((card) => card.id).sort(), ["legacy-safe", "new-safe"]);
      assert.equal((await store.listCards({ includePrivate: true, limit: 100 })).length, cards.length);
      for (const id of cards.map((card) => card.id).filter((id) => !["legacy-safe", "new-safe"].includes(id))) {
        await assert.rejects(store.readCard(id), /Unknown cardId/);
        await assert.rejects(store.dismissCard(id), /Unknown cardId/);
        assert.equal((await store.readCard(id, { includePrivate: true })).id, id);
      }
      const collection = await store.listCardCollection();
      assert.equal(collection.total, 2);
      assert.equal(collection.bookCards.length, 0);
      assert.equal((await store.listCardInbox()).length, 2);
      assert.ok(["legacy-safe", "new-safe"].includes((await store.latestCardNotification()).cardId));
      assert.ok(!JSON.stringify({ visible, collection }).includes(secret));
    });

    await t.test("manual card writes cannot return private source copies to MCP", async () => {
      await assert.rejects(store.collectCard({ ...base, note: secret, sourceAnnotationIds: ["private-human"] }), /not available for sharing/);
      await assert.rejects(store.collectCard({ ...base, note: secret }), /not available for sharing/);
      const humanCard = await store.collectCard({ ...base, note: secret, sourceAnnotationIds: ["private-human"] }, { includePrivate: true });
      await assert.rejects(store.readCard(humanCard.id), /Unknown cardId/);
      assert.equal((await store.readCard(humanCard.id, { includePrivate: true })).note, secret);
    });

    await t.test("MCP card tools cannot opt into the human-private view", async () => {
      for (const name of ["reading_list_cards", "reading_card_inbox", "reading_card_collection"]) {
        const result = JSON.stringify(await callTool(name, { includePrivate: true, limit: 100 }));
        assert.ok(!result.includes(secret));
        assert.ok(!result.includes("legacy-section"));
        assert.ok(!result.includes("new-private"));
      }
      for (const name of ["reading_open_card", "reading_save_card", "reading_dismiss_card"]) {
        await assert.rejects(callTool(name, { cardId: "legacy-section", includePrivate: true }), /Unknown cardId/);
      }
      await assert.rejects(callTool("reading_collect_card", { ...base, sourceAnnotationIds: ["private-human"], includePrivate: true }), /not available for sharing/);
    });

    await t.test("shared to private revokes historical cards and keeps human access", async () => {
      annotations = annotations.map((annotation) => annotation.id === "shared-assistant" ? { ...annotation, visibility: "private" } : annotation);
      await writeRows("annotations.jsonl", annotations);
      await assert.rejects(store.readCard("new-safe"), /Unknown cardId/);
      assert.equal((await store.readCard("new-safe", { includePrivate: true })).id, "new-safe");
      annotations = annotations.map((annotation) => annotation.id === "shared-assistant" ? { ...annotation, visibility: "shared" } : annotation);
      await writeRows("annotations.jsonl", annotations);
    });

    await t.test("automatic cards and completion statistics use only shared notes", async () => {
      await writeRows("cards.jsonl", []);
      await store.markRead(bookId, "ch1");
      const completion = await store.markRead(bookId, "ch2");
      assert.equal(completion.finish.annotationCount, 2);
      assert.equal(completion.finish.kindCounts.SECRET_KIND, undefined);
      assert.equal(completion.finish.moodCounts.SECRET_MOOD, undefined);
      const generated = await store.listCards({ limit: 100 });
      assert.ok(generated.length >= 2);
      for (const card of generated) {
        assert.ok(Array.isArray(card.sourceAnnotationIds));
        assert.ok(!card.sourceAnnotationIds.includes("private-human"));
        assert.ok(!card.sourceAnnotationIds.includes("private-child"));
      }
      const bookCard = generated.find((card) => card.scope === "book");
      assert.ok(bookCard.sourceAnnotationIds.includes("shared-human"));
      assert.ok(!JSON.stringify({ generated, completion }).includes(secret));
      annotations = annotations.map((annotation) => annotation.id === "shared-human" ? { ...annotation, visibility: "private" } : annotation);
      await writeRows("annotations.jsonl", annotations);
      await assert.rejects(store.readCard(bookCard.id), /Unknown cardId/);
      assert.ok((await store.readCard(bookCard.id, { includePrivate: true })).sourceAnnotationIds.includes("shared-human"));
      assert.ok((await readFile(path.join(fixture, "cards.jsonl"), "utf8")).includes(bookCard.id), "revocation must not delete the human's saved card");
    });

    await t.test("card candidate logic respects privacy and actual author labels", () => {
      const assistant = { id: "a", role: "assistant", author: "codex", displayName: "Astra", quote, note: "A shared thought", kind: "resonance" };
      const human = { id: "h", role: "human", author: "Rocky", displayName: "Rocky", quote, note: secret, status: "published", visibility: "private" };
      assert.equal(findSharedMoments([assistant, human]).length, 0);
      const privateCandidates = buildCardCandidates({ annotations: [assistant, human], chunk: { title: "Story", text: quote.repeat(8) } });
      assert.ok(!JSON.stringify(privateCandidates).includes(secret));
      const sharedCandidates = buildCardCandidates({ annotations: [assistant, { ...human, visibility: "shared" }], chunk: { title: "Story", text: quote.repeat(8) } });
      const shared = sharedCandidates.find((candidate) => candidate.source === "shared");
      assert.equal(shared.leftLabel, "Astra");
      assert.equal(shared.rightLabel, "Rocky");
      assert.deepEqual(shared.sourceAnnotationIds, ["h", "a"]);
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
