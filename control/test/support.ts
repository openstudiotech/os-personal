// A zip made in memory, for tests: the shape OpenStudio's download has.
import { crc32, deflateRawSync } from "node:zlib";

export function makeZip(entries: Record<string, string | Uint8Array>, { deflate = false } = {}): Uint8Array {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const raw = Buffer.from(content);
    const data = deflate ? deflateRawSync(raw) : raw;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc32(raw), 14);
    header.writeUInt32LE(data.length, 18);
    header.writeUInt32LE(raw.length, 22);
    header.writeUInt16LE(Buffer.byteLength(name), 26);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    header.copy(entry, 10, 8, 30); // method, time, date, crc, sizes, name length, extra length
    entry.writeUInt32LE(offset, 42);
    local.push(header, Buffer.from(name), data);
    central.push(entry, Buffer.from(name));
    offset += 30 + Buffer.byteLength(name) + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(central.length / 2, 8);
  end.writeUInt16LE(central.length / 2, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

export const COUNTER = `
import { Piece } from "./costa.js";
export default class extends Piece {
  viewCount(state) { return { result: state?.count ?? 0 }; }
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { ...state, count }, result: count };
  }
}`;

export function manifest(over: Record<string, unknown> = {}): string {
  const fields = { format: 1, name: "Counter", description: "Counts things", state_mode: "shared", data: false, ...over };
  return Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join("\n") + "\n";
}

// Stands in for the kernel: records what it was asked and says yes.
export function fakeKernel(replies: Record<string, { status: number; body: unknown }> = {}) {
  const calls: Array<{ method: string; piece: string; route: string; body: any }> = [];
  return {
    calls,
    async request(method: string, piece: string, route: string, body?: unknown) {
      calls.push({ method, piece, route, body });
      return replies[`${method} ${route}`] ?? { status: 200, body: {} };
    },
    // Schedule calls are recorded as if made to a piece called "scheduler".
    async scheduler(method: string, route: string, body?: unknown) {
      calls.push({ method, piece: "scheduler", route, body });
      return replies[`${method} ${route}`] ?? replies[`${method} ${route.split("/")[0]}`] ?? { status: 200, body: { ok: true } };
    },
    putFiles(piece: string, files: Record<string, string>) { return this.request("PUT", piece, "files", { files }); },
    ticket() { return "ticket"; },
    verifies(header: string | null) { return header === "Kernel signed"; },
    pageUrl(piece: string, ticket: string) { return `http://kernel.test/pieces/${piece}/client?ticket=${ticket}`; },
  };
}
