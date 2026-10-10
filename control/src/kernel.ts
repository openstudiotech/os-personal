// The control plane's side of the kernel contract: it signs every call with
// the secret the two share, and mints the tickets a browser shows the kernel.
// One operator, so one org.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const ORG = "local";

interface Options { url: string; secret: string }
export interface Reply { status: number; body: any }

export class KernelClient {
  private url: string;
  private secret: string;

  constructor(options: Options) {
    this.url = options.url.replace(/\/$/, "");
    this.secret = options.secret;
  }

  async healthy(): Promise<boolean> {
    const reply = await fetch(`${this.url}/.well-known/celld/health`).catch(() => null);
    return reply?.ok ?? false;
  }

  // The signature covers the method, the org-prefixed path and the body, so
  // a call cannot be replayed against another piece or with another body.
  async request(method: string, piece: string, route: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const at = Date.now();
    const signed = `${at}.${method}./${ORG}/pieces/${piece}/${route}.${createHash("sha256").update(text).digest("hex")}`;
    const reply = await fetch(`${this.url}/pieces/${piece}/${route}`, {
      method,
      headers: {
        authorization: `Kernel v1.${at}.${this.sign(signed)}`,
        "x-kernel-org": ORG,
        "content-type": "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : text,
    });
    return { status: reply.status, body: await reply.json().catch(() => null) };
  }

  // Schedules are kept per org, not per piece, so they have their own address.
  async scheduler(method: string, route: string, body?: unknown): Promise<Reply> {
    const text = body === undefined ? "" : JSON.stringify(body);
    const at = Date.now();
    const signed = `${at}.${method}./${ORG}/scheduler/${route}.${createHash("sha256").update(text).digest("hex")}`;
    const reply = await fetch(`${this.url}/scheduler/${ORG}/${route}`, {
      method,
      headers: { authorization: `Kernel v1.${at}.${this.sign(signed)}`, "content-type": "application/json" },
      body: body === undefined ? undefined : text,
    });
    return { status: reply.status, body: await reply.json().catch(() => null) };
  }

  putFiles(piece: string, files: Record<string, string>): Promise<Reply> {
    return this.request("PUT", piece, "files", { files });
  }

  // As the operator, who may call any method: the interface gate is for
  // callers from outside.
  call(piece: string, method: string, args: unknown[] = []): Promise<Reply> {
    return this.request("POST", piece, `rpc/${method}`, { args }, { "x-kernel-scope": "internal" });
  }

  ticket(piece: string, { minutes }: { minutes: number }): string {
    const payload = Buffer.from(JSON.stringify({
      org: ORG, piece, user: "operator", role: "owner", exp: Date.now() + minutes * 60_000,
    })).toString("base64url");
    return `${payload}.${this.sign(payload)}`;
  }

  pageUrl(piece: string, ticket: string): string {
    return `${this.url}/pieces/${piece}/client?${new URLSearchParams({ ticket, org: ORG })}`;
  }

  // Whether a callback really came from the kernel: the same signature the
  // kernel checks on calls to it, over the path it says it signed.
  verifies(header: string | null, method: string, signedPath: string, body: Uint8Array, now = Date.now()): boolean {
    const found = (header ?? "").match(/^Kernel v1\.(\d+)\.([0-9a-f]{64})$/);
    if (!found || Math.abs(now - Number(found[1])) > 60_000) return false;
    const expected = this.sign(`${found[1]}.${method}.${signedPath}.${createHash("sha256").update(body).digest("hex")}`);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(found[2]));
  }

  private sign(message: string): string {
    return createHmac("sha256", this.secret).update(message).digest("hex");
  }
}
