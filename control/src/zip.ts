// Reads a zip held in memory. Written here because it is small and the only
// thing a zip is needed for is loading a piece.
import { inflateRawSync } from "node:zlib";

const END = 0x06054b50, ENTRY = 0x02014b50, LOCAL = 0x04034b50;

// { path => bytes }, read from the directory at the end of the file, which is
// where a zip says what it holds. Directories are left out.
export function readZip(bytes: Uint8Array, { maxEntryBytes = 20_000_000 } = {}): Map<string, Buffer> {
  const zip = Buffer.from(bytes);
  let end = zip.length - 22;
  while (end >= 0 && zip.readUInt32LE(end) !== END) end--;
  if (end < 0) throw new Error("That file is not a zip");

  const files = new Map<string, Buffer>();
  let at = zip.readUInt32LE(end + 16);
  for (let i = zip.readUInt16LE(end + 10); i > 0; i--) {
    if (zip.readUInt32LE(at) !== ENTRY) throw new Error("That zip is damaged");
    const method = zip.readUInt16LE(at + 10);
    const packed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLength);
    const local = zip.readUInt32LE(at + 42);
    at += 46 + nameLength + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
    if (name.endsWith("/")) continue;
    if (size > maxEntryBytes) throw new Error(`${name} is too large`);

    if (zip.readUInt32LE(local) !== LOCAL) throw new Error("That zip is damaged");
    const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
    const data = zip.subarray(start, start + packed);
    if (method === 0) files.set(name, data);
    else if (method === 8) files.set(name, inflateRawSync(data, { maxOutputLength: maxEntryBytes }));
    else throw new Error(`${name} is packed in a way this cannot read`);
  }
  return files;
}
