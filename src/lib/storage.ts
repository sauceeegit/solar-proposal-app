// ── Durable storage that works both locally and on serverless ─────────
// Production (Vercel): Vercel Blob, when BLOB_READ_WRITE_TOKEN is present.
// Local dev: the ./data folder on disk. Same keys either way.
import { put, head } from "@vercel/blob";
import fs from "fs";
import path from "path";

const useBlob = !!process.env.BLOB_READ_WRITE_TOKEN;
const DATA = path.join(process.cwd(), "data");

const localPath = (key: string) => path.join(DATA, key);

export async function saveText(key: string, text: string): Promise<void> {
  if (useBlob) {
    await put(key, text, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType: "application/json" });
    return;
  }
  const f = localPath(key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

export async function saveBinary(key: string, buf: Buffer, contentType: string): Promise<void> {
  if (useBlob) {
    await put(key, buf, { access: "public", addRandomSuffix: false, allowOverwrite: true, contentType });
    return;
  }
  const f = localPath(key);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, buf);
}

export async function readText(key: string): Promise<string | null> {
  if (useBlob) {
    try {
      const { url } = await head(key);
      const res = await fetch(url);
      return res.ok ? await res.text() : null;
    } catch {
      return null; // BlobNotFound
    }
  }
  const f = localPath(key);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
}

export async function readBinary(key: string): Promise<Buffer | null> {
  if (useBlob) {
    try {
      const { url } = await head(key);
      const res = await fetch(url);
      return res.ok ? Buffer.from(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }
  const f = localPath(key);
  return fs.existsSync(f) ? fs.readFileSync(f) : null;
}
