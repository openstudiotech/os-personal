// What the control plane keeps: one SQLite file. Keys are sealed with a key
// derived from the operator's secret, so the file alone does not give them up.
import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

// The keys the app itself uses. It will not start working without the
// required one; what the others are for says so when it is asked for.
export const APP_KEYS = [
  { name: "openrouter", label: "OpenRouter key", required: true, does: "The models Marcel thinks with, and web search.", site: "openrouter.ai", url: "https://openrouter.ai/settings/keys" },
  { name: "steel", label: "Steel key", required: false, does: "Gives Marcel a browser, for pages that need one.", site: "steel.dev", url: "https://app.steel.dev/settings/api-keys" },
] as const;

export interface Piece {
  id: string;
  name: string;
  description: string;
  // The connections it asks for, as its download described them. Asking is
  // not having: grants are kept elsewhere.
  wants: unknown[];
}

export interface Spec {
  freq: "hourly" | "daily" | "weekly" | "interval";
  timeZone: string;
  hour?: number;
  minute?: number;
  byDay?: string[];
  intervalSeconds?: number;
}

export interface Schedule {
  id: string;
  piece: string;
  task: string;
  spec: Spec;
  enabled: boolean;
  // Why it is off, when the kernel turned it off and not a person.
  stopped: string | null;
}

export class Store {
  private db: DatabaseSync;
  private key: Buffer;

  constructor(path: string, secret = "in-memory") {
    this.db = new DatabaseSync(path);
    this.db.exec("CREATE TABLE IF NOT EXISTS sealed (name TEXT PRIMARY KEY, value BLOB NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS pieces (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, wants TEXT NOT NULL, loaded_at TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS grants (piece TEXT NOT NULL, kind TEXT NOT NULL, config TEXT NOT NULL, PRIMARY KEY (piece, kind))");
    this.db.exec("CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, piece TEXT NOT NULL, task TEXT NOT NULL, spec TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, stopped TEXT)");
    this.db.exec("CREATE TABLE IF NOT EXISTS memories (id INTEGER PRIMARY KEY, text TEXT NOT NULL UNIQUE, at TEXT NOT NULL)");
    // The agent's one conversation. `role` is who the line is from; `message`
    // is what the model is shown for it, when it is shown anything.
    this.db.exec("CREATE TABLE IF NOT EXISTS conversation (id INTEGER PRIMARY KEY, role TEXT NOT NULL, text TEXT NOT NULL, message TEXT, at TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, at TEXT NOT NULL)");
    this.db.exec("CREATE TABLE IF NOT EXISTS pictures (id TEXT PRIMARY KEY, chat TEXT NOT NULL, type TEXT NOT NULL, bytes BLOB NOT NULL)");
    // There was one conversation before there were chats. Its lines become
    // the first chat.
    if (!(this.db.prepare("PRAGMA table_info(conversation)").all() as any[]).some((column) => column.name === "chat")) {
      this.db.exec("ALTER TABLE conversation ADD COLUMN chat TEXT");
      if (this.db.prepare("SELECT 1 FROM conversation LIMIT 1").get()) {
        this.db.prepare("INSERT INTO chats (id, title, at) VALUES ('c0', 'Earlier', ?)").run(new Date().toISOString());
        this.db.exec("UPDATE conversation SET chat = 'c0'");
      }
    }
    this.db.exec("CREATE TABLE IF NOT EXISTS browsers (handle TEXT PRIMARY KEY, piece TEXT NOT NULL, steel TEXT NOT NULL, at INTEGER NOT NULL, status TEXT NOT NULL)");
    // `header` is where its token goes, when that is not Authorization.
    this.db.exec("CREATE TABLE IF NOT EXISTS services (key TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, header TEXT)");
    try { this.db.exec("ALTER TABLE services ADD COLUMN header TEXT"); } catch { /* already there */ }
    this.db.exec("CREATE TABLE IF NOT EXISTS settings (name TEXT PRIMARY KEY, value TEXT NOT NULL)");
    this.key = scryptSync(secret, "openstudio.sealed", 32);
  }

  addPiece(piece: Piece): void {
    this.db.prepare("INSERT INTO pieces (id, name, description, wants, loaded_at) VALUES (?, ?, ?, ?, ?)")
      .run(piece.id, piece.name, piece.description, JSON.stringify(piece.wants), new Date().toISOString());
  }

  pieces(): Piece[] {
    return (this.db.prepare("SELECT id, name, description, wants FROM pieces ORDER BY loaded_at DESC, rowid DESC").all() as any[]).map(asPiece);
  }

  piece(id: string): Piece | null {
    const row = this.db.prepare("SELECT id, name, description, wants FROM pieces WHERE id = ?").get(id);
    return row ? asPiece(row) : null;
  }

  // A piece's grants go with it.
  removePiece(id: string): void {
    this.db.prepare("DELETE FROM pieces WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM grants WHERE piece = ?").run(id);
    this.db.prepare("DELETE FROM schedules WHERE piece = ?").run(id);
    this.db.prepare("DELETE FROM browsers WHERE piece = ?").run(id);
  }

  // A service pieces may be granted, known by its key. Its token, if it has
  // one, is sealed beside the other keys.
  addService({ key, name, url, header = null }: { key: string; name: string; url: string; header?: string | null }): void {
    this.db.prepare("INSERT OR REPLACE INTO services (key, name, url, header) VALUES (?, ?, ?, ?)").run(key, name, url, header);
  }

  services(): Array<{ key: string; name: string; url: string; header: string | null }> {
    return this.db.prepare("SELECT key, name, url, header FROM services ORDER BY name").all() as any[];
  }

  service(key: string): { key: string; name: string; url: string; header: string | null } | null {
    return (this.db.prepare("SELECT key, name, url, header FROM services WHERE key = ?").get(key) as any) ?? null;
  }

  // Its token goes, and so does every piece's grant of it.
  removeService(key: string): void {
    this.db.prepare("DELETE FROM services WHERE key = ?").run(key);
    this.db.prepare("DELETE FROM sealed WHERE name IN (?, ?)").run(`service:${key}`, `oauth:${key}`);
    for (const row of this.db.prepare("SELECT piece, config FROM grants WHERE kind = 'mcp'").all() as any[]) {
      const left = (JSON.parse(row.config).services ?? []).filter((each: string) => each !== key);
      this.grant(row.piece, "mcp", { services: left });
    }
  }

  // The pieces granted this service.
  usedBy(key: string): Piece[] {
    return this.pieces().filter((piece) => (this.granted(piece.id, "mcp")?.services ?? []).includes(key));
  }

  // A browser a piece has open. The piece knows it by `handle`, never by the
  // service's own id.
  addBrowser({ handle, piece, steel }: { handle: string; piece: string; steel: string }): void {
    this.db.prepare("INSERT INTO browsers (handle, piece, steel, at, status) VALUES (?, ?, ?, ?, 'live')").run(handle, piece, steel, Date.now());
  }

  browser(handle: string): { handle: string; piece: string; steel: string; at: number; status: string } | null {
    return (this.db.prepare("SELECT * FROM browsers WHERE handle = ?").get(handle) as any) ?? null;
  }

  liveBrowsers(piece: string): Array<{ handle: string; piece: string; steel: string; at: number }> {
    return this.db.prepare("SELECT * FROM browsers WHERE piece = ? AND status = 'live'").all(piece) as any[];
  }

  endBrowser(handle: string): void {
    this.db.prepare("UPDATE browsers SET status = 'released' WHERE handle = ?").run(handle);
  }

  // A schedule starts switched off, wherever it came from.
  addSchedule({ piece, task, spec }: { piece: string; task: string; spec: Spec }): string {
    const id = `s${randomBytes(8).toString("hex")}`;
    this.db.prepare("INSERT INTO schedules (id, piece, task, spec) VALUES (?, ?, ?, ?)").run(id, piece, task, JSON.stringify(spec));
    return id;
  }

  schedules(piece?: string): Schedule[] {
    const rows = piece
      ? this.db.prepare("SELECT * FROM schedules WHERE piece = ? ORDER BY rowid").all(piece)
      : this.db.prepare("SELECT * FROM schedules ORDER BY rowid").all();
    return (rows as any[]).map(asSchedule);
  }

  schedule(id: string): Schedule | null {
    const row = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id);
    return row ? asSchedule(row) : null;
  }

  setEnabled(id: string, on: boolean): void {
    this.db.prepare("UPDATE schedules SET enabled = ?, stopped = NULL WHERE id = ?").run(on ? 1 : 0, id);
  }

  stop(id: string, reason: string): void {
    this.db.prepare("UPDATE schedules SET enabled = 0, stopped = ? WHERE id = ?").run(reason.slice(0, 500), id);
  }

  removeSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }

  grant(piece: string, kind: string, config: Record<string, unknown>): void {
    this.db.prepare("INSERT INTO grants (piece, kind, config) VALUES (?, ?, ?) ON CONFLICT (piece, kind) DO UPDATE SET config = excluded.config")
      .run(piece, kind, JSON.stringify(config));
  }

  revoke(piece: string, kind: string): void {
    this.db.prepare("DELETE FROM grants WHERE piece = ? AND kind = ?").run(piece, kind);
  }

  anyGrant(): boolean {
    return this.db.prepare("SELECT 1 FROM grants LIMIT 1").get() !== undefined;
  }

  // What this piece was given of this kind, or null. No row, no reach.
  granted(piece: string, kind: string): Record<string, any> | null {
    const row = this.db.prepare("SELECT config FROM grants WHERE piece = ? AND kind = ?").get(piece, kind) as { config: string } | undefined;
    return row ? JSON.parse(row.config) : null;
  }

  // Saying the same thing twice keeps one note.
  addMemory(text: string): void {
    this.db.prepare("INSERT OR IGNORE INTO memories (text, at) VALUES (?, ?)").run(text, new Date().toISOString());
  }

  memories(): Array<{ id: number; text: string }> {
    return this.db.prepare("SELECT id, text FROM memories ORDER BY id DESC").all() as any[];
  }

  forget(id: number): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  // A chat is named for what was first said in it.
  addChat(first: string): string {
    const id = `c${randomBytes(8).toString("hex")}`;
    const title = first.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
    this.db.prepare("INSERT INTO chats (id, title, at) VALUES (?, ?, ?)").run(id, title, new Date().toISOString());
    return id;
  }

  // Newest first, by when something was last said.
  chats(limit = 30): Array<{ id: string; title: string }> {
    return this.db.prepare(
      "SELECT id, title FROM chats ORDER BY COALESCE((SELECT MAX(conversation.id) FROM conversation WHERE conversation.chat = chats.id), 0) DESC, chats.rowid DESC LIMIT ?",
    ).all(limit) as any[];
  }

  chat(id: string): { id: string; title: string } | null {
    return (this.db.prepare("SELECT id, title FROM chats WHERE id = ?").get(id) as any) ?? null;
  }

  renameChat(id: string, title: string): void {
    const named = title.replace(/\s+/g, " ").trim().slice(0, 60);
    if (named) this.db.prepare("UPDATE chats SET title = ? WHERE id = ?").run(named, id);
  }

  removeChat(id: string): void {
    this.db.prepare("DELETE FROM conversation WHERE chat = ?").run(id);
    this.db.prepare("DELETE FROM pictures WHERE chat = ?").run(id);
    this.db.prepare("DELETE FROM chats WHERE id = ?").run(id);
  }

  addLine(chat: string, role: "you" | "marcel" | "did" | "tool", text: string, message?: unknown): void {
    const at = new Date().toISOString();
    this.db.prepare("INSERT INTO conversation (chat, role, text, message, at) VALUES (?, ?, ?, ?, ?)")
      .run(chat, role, text, message === undefined ? null : JSON.stringify(message), at);
    this.db.prepare("UPDATE chats SET at = ? WHERE id = ?").run(at, chat);
  }

  // What a person reads: their words and pictures, his words, and what he
  // did. Not the raw results he was handed.
  conversation(chat: string): Array<{ role: string; text: string; pictures: string[] }> {
    const rows = this.db.prepare("SELECT role, text, message FROM conversation WHERE chat = ? AND role != 'tool' ORDER BY id").all(chat) as any[];
    return rows.map(({ role, text, message }) => ({ role, text, pictures: (message && JSON.parse(message).pictures) || [] }));
  }

  addPicture(chat: string, type: string, bytes: Uint8Array): string {
    const id = `p${randomBytes(6).toString("hex")}`;
    this.db.prepare("INSERT INTO pictures (id, chat, type, bytes) VALUES (?, ?, ?, ?)").run(id, chat, type, bytes);
    return id;
  }

  // A picture, only from the chat it was sent in.
  picture(chat: string, id: string): { type: string; bytes: Uint8Array } | null {
    return (this.db.prepare("SELECT type, bytes FROM pictures WHERE chat = ? AND id = ?").get(chat, id) as any) ?? null;
  }

  // What the model is shown: the last of the exchange, as it happened.
  modelMessages(chat: string, limit = 60): unknown[] {
    const rows = this.db.prepare("SELECT message FROM conversation WHERE chat = ? AND message IS NOT NULL ORDER BY id DESC LIMIT ?").all(chat, limit) as Array<{ message: string }>;
    // Which pictures came with a message is ours to know, not the model's.
    const messages = rows.reverse().map((row) => {
      const { pictures, ...message } = JSON.parse(row.message);
      return message;
    });
    // A tool result with no call before it is not something a model accepts.
    while (messages.length && messages[0].role === "tool") messages.shift();
    return messages;
  }

  setSetting(name: string, value: string): void {
    this.db.prepare("INSERT INTO settings (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value").run(name, value);
  }

  setting(name: string): string | null {
    const row = this.db.prepare("SELECT value FROM settings WHERE name = ?").get(name) as { value: string } | undefined;
    return row?.value ?? null;
  }

  ready(): boolean {
    return APP_KEYS.every((key) => !key.required || this.has(key.name));
  }

  has(name: string): boolean {
    return this.db.prepare("SELECT 1 FROM sealed WHERE name = ?").get(name) !== undefined;
  }

  seal(name: string, value: string): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const sealed = Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final(), cipher.getAuthTag()]);
    this.db.prepare("INSERT INTO sealed (name, value) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET value = excluded.value")
      .run(name, sealed);
  }

  open(name: string): string | null {
    const row = this.db.prepare("SELECT value FROM sealed WHERE name = ?").get(name) as { value: Uint8Array } | undefined;
    if (!row) return null;
    const sealed = Buffer.from(row.value);
    const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.subarray(0, 12));
    decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    return Buffer.concat([decipher.update(sealed.subarray(12, sealed.length - 16)), decipher.final()]).toString("utf8");
  }
}

function asSchedule(row: any): Schedule {
  return { id: row.id, piece: row.piece, task: row.task, spec: JSON.parse(row.spec), enabled: row.enabled === 1, stopped: row.stopped };
}

function asPiece(row: any): Piece {
  return { id: row.id, name: row.name, description: row.description, wants: JSON.parse(row.wants) };
}
