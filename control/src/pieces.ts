// Loading a piece from the zip OpenStudio downloads: its code is deployed to
// the kernel, its data put back, and what it asks for written down. It is
// granted nothing.
import { randomBytes } from "node:crypto";
import { parse } from "yaml";
import { readZip } from "./zip.ts";
import { specFromManifest } from "./schedules.ts";
import type { Store, Piece } from "./store.ts";
import type { Reply } from "./kernel.ts";

const FORMAT = 1;
const MANIFEST = "manifest.yml";
const MAX_ZIP_BYTES = 60_000_000;
const MAX_FILES = 100;
// Held by the kernel as base64 text; in the zip as the real file.
const BINARY = /\.(png|jpe?g|webp|gif|avif|pdf)$/i;
// How a download names a connection. Here it is named by the key alone.
const CONNECTION = /\{\{mcp:([a-z0-9_-]+)\}\}/g;
const WANTED = [/^manifest\.yml$/, /^files\/[^/]+(\/[^/]+)*$/, /^data\/(state\.json|files\.json|files\/[0-9a-f]{32})$/];

interface Kernel {
  request(method: string, piece: string, route: string, body?: unknown): Promise<Reply>;
  putFiles(piece: string, files: Record<string, string>): Promise<Reply>;
}

export async function loadPiece(bytes: Uint8Array, { store, kernel }: { store: Store; kernel: Kernel }): Promise<Piece> {
  if (bytes.length > MAX_ZIP_BYTES) throw new Error("That file is too large to be a piece");
  const entries = within(readZip(bytes));

  const manifest = parse(entries.get(MANIFEST)!.toString("utf8"));
  if (manifest === null || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error(`${MANIFEST} is not a piece's manifest`);
  if (manifest.format !== FORMAT) throw new Error("This piece was saved in a format this version cannot read");
  const name = String(manifest.name ?? "").trim().slice(0, 100);
  if (!name) throw new Error("The piece has no name");

  const code: Record<string, string> = {};
  for (const [path, content] of entries) {
    if (!path.startsWith("files/")) continue;
    const file = path.slice("files/".length);
    code[file] = BINARY.test(file) ? content.toString("base64") : text(file, content).replace(CONNECTION, "$1");
  }
  if (Object.keys(code).length > MAX_FILES) throw new Error(`The piece has more than ${MAX_FILES} files`);
  if (!code["piece.js"]?.trim()) throw new Error("The piece has no piece.js");

  const id = `p${randomBytes(8).toString("hex")}`;
  await asked(kernel.putFiles(id, code));
  if (manifest.state_mode === "personal") await asked(kernel.request("PUT", id, "mode", { mode: "personal", wipe: true }));
  if (entries.has("data/state.json")) {
    await asked(kernel.request("PUT", id, "state", { state: JSON.parse(entries.get("data/state.json")!.toString("utf8")) }));
  }
  for (const file of stored(entries)) await asked(kernel.request("POST", id, "stored-files", file));

  const piece: Piece = {
    id, name,
    description: String(manifest.description ?? "").slice(0, 2_000),
    wants: Array.isArray(manifest.connections) ? manifest.connections.slice(0, 8) : [],
  };
  store.addPiece(piece);
  // Its schedules come with it, switched off: nothing runs by itself until
  // someone here says so.
  for (const want of piece.wants as any[]) {
    if (want?.kind !== "schedule" || !Array.isArray(want.config?.schedules)) continue;
    for (const entry of want.config.schedules.slice(0, 10)) {
      const found = specFromManifest(entry);
      if (found) store.addSchedule({ piece: id, ...found });
    }
  }
  return piece;
}

// The paths the format names, with the one folder a "download zip" wraps
// everything in taken off.
function within(files: Map<string, Buffer>): Map<string, Buffer> {
  const manifest = [...files.keys()].filter((path) => path.split("/").pop() === MANIFEST).sort((a, b) => a.length - b.length)[0];
  if (manifest === undefined) throw new Error(`That zip is not a piece: it has no ${MANIFEST}`);
  const root = manifest.slice(0, -MANIFEST.length);
  const entries = new Map<string, Buffer>();
  for (const [path, content] of files) {
    const inside = path.startsWith(root) ? path.slice(root.length) : null;
    if (inside !== null && WANTED.some((pattern) => pattern.test(inside))) entries.set(inside, content);
  }
  return entries;
}

function stored(entries: Map<string, Buffer>): Array<Record<string, unknown>> {
  if (!entries.has("data/files.json")) return [];
  const index = JSON.parse(entries.get("data/files.json")!.toString("utf8"));
  if (!Array.isArray(index)) return [];
  return index.flatMap((file) => {
    const content = entries.get(`data/files/${file?.id}`);
    if (!content) return [];
    return [{ name: String(file.name ?? file.id), base64: content.toString("base64"), source: file.source, expires: file.expires }];
  });
}

function text(name: string, content: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`${name} is not text`);
  }
}

async function asked(reply: Promise<Reply>): Promise<Reply> {
  const { status, body } = await reply;
  if (status !== 200) throw new Error(body?.error ?? `The kernel answered ${status}`);
  return { status, body };
}
