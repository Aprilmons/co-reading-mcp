import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/book_cover.py", import.meta.url));
const cache = new Map();
export const bookCoverCapabilities = Object.freeze({ version: 1, get: true, write: true, epub: true, ifAbsent: true,
  maxBytes: 524288, maxEpubBytes: 25000000, mimeTypes: ["image/jpeg", "image/png", "image/webp"] });

export class BookCoverError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new BookCoverError(status, code, message); }
function canonicalBase64(value) {
  // V8 can overflow its regex stack on a grouped repetition over a large EPUB.
  // Buffer's native decoder and canonical round-trip stay linear and bounded.
  if (!value || value.length % 4) fail(400, "invalid_cover", "The cover upload must contain valid base64 data");
  const bytes = Buffer.from(value, "base64");
  if (bytes.toString("base64") !== value) fail(400, "invalid_cover", "The cover upload must contain valid base64 data");
  return bytes;
}

export function coverMetadata(cover) {
  if (!cover) return null;
  const { mimeType, sha256, width, height } = cover;
  return { mimeType, sha256, width, height };
}

function validateNormalized(cover) {
  if (!cover || cover.mimeType !== "image/jpeg" || !/^[a-f0-9]{64}$/.test(cover.sha256 || "") ||
      !Number.isSafeInteger(cover.width) || !Number.isSafeInteger(cover.height) ||
      cover.width < 1 || cover.height < 1 || cover.width > 640 || cover.height > 640 ||
      typeof cover.dataBase64 !== "string" || cover.dataBase64.length > Math.ceil(bookCoverCapabilities.maxBytes / 3) * 4) {
    fail(400, "invalid_cover", "The saved cover is invalid");
  }
  const bytes = canonicalBase64(cover.dataBase64);
  if (!bytes.length || bytes.length > bookCoverCapabilities.maxBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      crypto.createHash("sha256").update(bytes).digest("hex") !== cover.sha256) {
    fail(400, "invalid_cover", "The saved cover is invalid");
  }
  return { ...coverMetadata(cover), dataBase64: cover.dataBase64 };
}

export async function readCoverFile(bookDir) {
  const filename = path.join(bookDir, "cover.json");
  try {
    const info = await stat(filename);
    if (info.size > 710000 || !info.isFile()) fail(400, "invalid_cover", "The saved cover is invalid");
    const signature = `${info.mtimeMs}:${info.ctimeMs}:${info.size}`;
    if (cache.get(filename)?.signature === signature) return cache.get(filename).cover;
    const cover = validateNormalized(JSON.parse(await readFile(filename, "utf8")));
    if (cache.size >= 128) cache.delete(cache.keys().next().value);
    cache.set(filename, { signature, cover });
    return cover;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof BookCoverError) throw error;
    fail(400, "invalid_cover", "The saved cover is unavailable");
  }
}

export async function writeCoverFile(bookDir, cover) {
  const clean = validateNormalized(cover);
  const filename = path.join(bookDir, "cover.json");
  const temporary = `${filename}.${crypto.randomBytes(12).toString("hex")}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(clean) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, filename);
    cache.delete(filename);
  } finally { await rm(temporary, { force: true }); }
  return clean;
}

export async function normalizeBookCover(input) {
  const epub = input?.format === "epub";
  const fields = epub ? ["format", "dataBase64", "ifAbsent"] : ["mimeType", "dataBase64", "ifAbsent"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some((key) => !fields.includes(key)) ||
      (!epub && !bookCoverCapabilities.mimeTypes.includes(input.mimeType)) || typeof input.dataBase64 !== "string" ||
      (input.ifAbsent !== undefined && typeof input.ifAbsent !== "boolean")) {
    fail(400, "invalid_cover", "Supply a JPEG, PNG, WebP image or an EPUB file");
  }
  const maxBytes = epub ? bookCoverCapabilities.maxEpubBytes : bookCoverCapabilities.maxBytes;
  if (input.dataBase64.length > Math.ceil(maxBytes / 3) * 4) fail(413, "too_large", "The cover upload is too large");
  const bytes = canonicalBase64(input.dataBase64);
  if (bytes.length > maxBytes) fail(413, "too_large", "The cover upload is too large");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "co-reading-cover-"));
  try {
    const filename = path.join(temporary, epub ? "source.epub" : "source.image");
    await writeFile(filename, bytes, { mode: 0o600 });
    let output;
    try {
      output = await execute("python3", [script, filename, ...(epub ? ["--epub"] : ["--mime-type", input.mimeType])],
        { timeout: 20000, maxBuffer: 900000, windowsHide: true });
    } catch { fail(400, "invalid_cover", "This file does not contain a safe, supported cover image"); }
    let result;
    try { result = JSON.parse(output.stdout); }
    catch { fail(400, "invalid_cover", "The cover could not be decoded"); }
    if (!result.cover) fail(400, "cover_not_found", "No supported cover image was found in this EPUB");
    return validateNormalized(result.cover);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
