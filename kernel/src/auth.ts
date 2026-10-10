// Auth for the pieces kernel. Two credential shapes, one shared secret with the control plane
// (KERNEL_SECRET; per-node override via CELLD_VAR_KERNEL_SECRET):
//
// 1. Service auth (the control plane -> kernel HTTP): header
//      Authorization: Kernel v1.<ts>.<sig>
//    sig = HMAC-SHA256(secret, `${ts}.${method}.${path}.${sha256(body)}`), hex.
//    Rejected when |now - ts| > 60s.
//
// 2. Session tickets (browser -> /connect WebSocket): The control plane mints
//      ticket = `${payloadB64}.${sig}`  where payload = JSON {org, piece, user, role, exp}
//    sig = HMAC-SHA256(secret, payloadB64), hex. Short-lived (the control plane sets exp).

const SERVICE_AUTH_WINDOW_MS = 60_000;

export interface Ticket {
  org: string;
  piece?: string;
  cell?: string; // the older name for piece
  user: string;
  role: "owner" | "editor" | "viewer";
  exp: number; // epoch ms
  // Holder is working on the piece (the Studio pane) and runs head rather
  // than the pinned version. Signed with the rest, so a viewer cannot add it.
  preview?: boolean;
}

const enc = new TextEncoder();

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", data as BufferSource);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function serviceAuthHeader(
  secret: string, method: string, path: string, body: Uint8Array, now = Date.now(),
): Promise<string> {
  const bodyHash = await sha256Hex(body);
  const sig = await hmacHex(secret, `${now}.${method}.${path}.${bodyHash}`);
  return `Kernel v1.${now}.${sig}`;
}

// Returns null when valid, else a Response to return to the caller.
// Consumes nothing: pass the already-read body bytes.
export async function verifyServiceAuth(
  request: Request, path: string, body: Uint8Array, secret: string,
): Promise<Response | null> {
  const header = request.headers.get("authorization") ?? "";
  const m = header.match(/^Kernel v1\.(\d+)\.([0-9a-f]{64})$/);
  if (!m) return unauthorized("missing or malformed service auth");
  const ts = Number(m[1]);
  if (Math.abs(Date.now() - ts) > SERVICE_AUTH_WINDOW_MS) {
    return unauthorized("service auth timestamp outside window");
  }
  const bodyHash = await sha256Hex(body);
  const expected = await hmacHex(secret, `${ts}.${request.method}.${path}.${bodyHash}`);
  if (!timingSafeEqualHex(expected, m[2])) return unauthorized("bad service auth signature");
  return null;
}

export async function mintTicket(secret: string, ticket: Ticket): Promise<string> {
  const payload = btoa(JSON.stringify(ticket)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${payload}.${await hmacHex(secret, payload)}`;
}

export async function verifyTicket(
  raw: string | null, secret: string, org: string, cell: string,
): Promise<Ticket | null> {
  if (!raw) return null;
  const m = raw.match(/^([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/);
  if (!m) return null;
  if (!timingSafeEqualHex(await hmacHex(secret, m[1]), m[2])) return null;
  let ticket: Ticket;
  try {
    // Re-pad: tickets are unpadded base64url and celld's atob is strict.
    const b64 = m[1].replaceAll("-", "+").replaceAll("_", "/");
    ticket = JSON.parse(atob(b64.padEnd(b64.length + ((4 - (b64.length % 4)) % 4), "=")));
  } catch {
    return null;
  }
  if (ticket.org !== org || (ticket.piece ?? ticket.cell) !== cell) return null;
  if (typeof ticket.exp !== "number" || Date.now() > ticket.exp) return null;
  if (!["owner", "editor", "viewer"].includes(ticket.role)) return null;
  if (ticket.preview !== undefined && typeof ticket.preview !== "boolean") return null;
  return ticket;
}

export function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: reason }), {
    status: 401, headers: { "content-type": "application/json" },
  });
}
