// What a piece may reach. A piece has no network: it asks, the kernel passes
// the request here, and this is where it is allowed or refused. The check is
// the grant; the piece's code has no say in it.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Store } from "./store.ts";
import type { Reply } from "./kernel.ts";
import { answerBrowser, type Page } from "./browser.ts";
import { answerService } from "./services.ts";
import { complete } from "./model.ts";

const MAX_BODY = 1_000_000;
const SNIPPET = 500;
const MAX_CHAIN = 6;

interface Kernel {
  request(method: string, piece: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
}

export interface Deps {
  store: Store;
  kernel: Kernel;
  http?: (url: string, init: any) => Promise<Response>;
  resolve?: (host: string) => Promise<string[]>;
  browser?: (address: string) => Promise<Page>;
  // Where this app is, for an address a person is sent to.
  origin?: string;
}

export type Outcome = Record<string, any>;

// Always an object: the kernel fails a piece's call on anything else.
export async function answerEffect(deps: Deps, pieceId: string, payload: Record<string, any>): Promise<Outcome> {
  if (!deps.store.piece(pieceId)) return { error: "unknown piece" };
  try {
    if (payload.kind === "fetch") return await webFetch(deps, pieceId, payload);
    if (payload.kind === "llm") return await model(deps, pieceId, payload);
    if (payload.kind === "cell_link") return await callPiece(deps, pieceId, payload);
    if (payload.kind === "search") return await search(deps, pieceId, payload);
    if (payload.kind === "extract") return await extract(deps, pieceId, payload);
    if (payload.kind === "browser_scrape") return await browserScrape(deps, pieceId, payload);
    if (payload.kind === "browser_screenshot") return await browserScreenshot(deps, pieceId, payload);
    if (payload.kind === "mcp") return await answerService(deps, pieceId, payload);
    if (/^browser_(session|goto|read|act|live_view)$/.test(payload.kind)) return await answerBrowser(deps, pieceId, payload);
    return { error: `${payload.kind} is not available in this version yet` };
  } catch (error) {
    return { error: (error as Error).message };
  }
}

// The address a piece asked for, if this piece may go there: https, a host it
// was granted, and nowhere private. Every way of reading a page comes
// through here, whichever service does the reading.
async function allowed(deps: Deps, piece: string, url: unknown): Promise<URL | Outcome> {
  const grant = deps.store.granted(piece, "web");
  if (!grant) return notGranted("the web");
  return address(deps, url, grant.hosts);
}

// The same check for whoever is asking: a piece with its granted hosts, or
// the agent with any host. Nobody reaches a private address.
export async function address({ resolve = addresses }: Pick<Deps, "resolve">, url: unknown, hosts: unknown): Promise<URL | Outcome> {
  let target: URL;
  try {
    target = new URL(String(url));
  } catch {
    return { error: "that is not an address" };
  }
  if (target.protocol !== "https:") return { error: "only https addresses can be fetched" };
  if (!hostAllowed(target.hostname, hosts)) return notGranted(target.hostname);
  // Where the name points is checked, not what it is called: a public name
  // can point inside.
  const found = isIP(target.hostname) ? [target.hostname] : await resolve(target.hostname);
  if (found.length === 0 || found.some(isPrivate)) return { error: "that address is private" };
  return target;
}

const SINCE = ["day", "week", "month"];

async function search(deps: Deps, piece: string, { query, since }: Outcome): Promise<Outcome> {
  if (!deps.store.granted(piece, "search")) return notGranted("web search");
  return searchWeb(deps, query, since);
}

// Search is OpenRouter's, on the key the model already uses: its web plugin
// searches once and hands back what it found beside the model's answer. Only
// what it found is kept. It has no setting for how recent, so that goes in
// the words of the search.
export async function searchWeb({ store, http = fetch }: Pick<Deps, "store" | "http">, query: unknown, since?: string): Promise<Outcome> {
  if (since !== undefined && !SINCE.includes(since)) return { error: "since must be day, week or month" };
  const reply = await complete(store, http, {
    messages: [{ role: "user", content: since ? `${String(query)} (from the past ${since})` : String(query) }],
    plugins: [{ id: "web", engine: "exa", max_results: 8 }],
    max_tokens: 16,
  });
  const body: any = await reply.json().catch(() => null);
  if (!reply.ok || !body?.choices) return { error: `search failed (${reply.status})` };
  const found: any[] = body.choices[0]?.message?.annotations ?? [];
  const results = found.filter((each) => each?.type === "url_citation").map(({ url_citation: cited }) =>
    ({ title: cited.title, url: cited.url, snippet: String(cited.content ?? "").slice(0, SNIPPET) }));
  return since ? { results, since } : { results };
}

async function extract(deps: Deps, piece: string, { url }: Outcome): Promise<Outcome> {
  const target = await allowed(deps, piece, url);
  if (!(target instanceof URL)) return target;
  return readPage(deps, target);
}

// A page as its words, fetched from here with no key. It is not followed
// when it moves: where it moved to has to pass the same check as any address.
export async function readPage({ http = fetch }: Pick<Deps, "http">, target: URL): Promise<Outcome> {
  const reply = await http(target.href, { redirect: "manual", headers: { accept: "text/html, text/plain" }, signal: AbortSignal.timeout(20_000) });
  const moved = reply.headers.get("location");
  if (reply.status >= 300 && reply.status < 400 && moved) return { error: `that page has moved to ${new URL(moved, target).href}` };
  if (!reply.ok) return { error: `reading that page failed (${reply.status})` };
  if (!/^text\//.test(reply.headers.get("content-type") ?? "text/html")) return { error: "that address is not a page of text" };
  const html = (await reply.text()).slice(0, MAX_BODY);
  const title = html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1];
  const words = html.replace(/<(script|style|noscript|svg|head|title)\b[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|li|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  return { markdown: plain(words).replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim(), title: title ? plain(title).trim() : null };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const plain = (text: string): string => text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, name: string) =>
  name[0] === "#" ? String.fromCodePoint(name[1].toLowerCase() === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1))) : ENTITIES[name.toLowerCase()] ?? whole);

async function browserScrape(deps: Deps, piece: string, { url, content_format }: Outcome): Promise<Outcome> {
  const target = await allowed(deps, piece, url);
  if (!(target instanceof URL)) return target;
  return browsePage(deps, target, content_format);
}

export async function browsePage(deps: Pick<Deps, "store" | "http">, target: URL, content_format?: string): Promise<Outcome> {
  const format = ["markdown", "html", "readability"].includes(content_format ?? "") ? content_format! : "markdown";
  const body = await steel(deps, "https://api.steel.dev/v1/scrape", { url: target.href, format: [format] });
  if (body.error) return body;
  const content = typeof body.content === "string" ? body.content : String(body.content?.[format] ?? "");
  return { content: content.slice(0, MAX_BODY), title: body.metadata?.title ?? null, url: target.href };
}

async function browserScreenshot(deps: Deps, piece: string, { url, full_page }: Outcome): Promise<Outcome> {
  const target = await allowed(deps, piece, url);
  if (!(target instanceof URL)) return target;
  const body = await steel(deps, "https://api.steel.dev/v1/screenshot", { url: target.href, fullPage: full_page === true });
  if (body.error) return body;
  return { image_url: body.url ?? body.data?.url ?? null, url: target.href };
}

// What a piece, or Marcel, is told when the browser's key was never added.
export const NO_BROWSER = "there is no Steel key here, so the browser cannot be used; one is added under Services";

// One call to the browser's service on the operator's key. What it said when
// it failed is not passed on: it may repeat the key.
async function steel({ store, http = fetch }: Pick<Deps, "store" | "http">, url: string, body: unknown): Promise<Outcome> {
  const secret = store.open("steel");
  if (!secret) return { error: NO_BROWSER };
  const reply = await http(url, {
    method: "POST",
    headers: { "content-type": "application/json", "steel-api-key": secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(70_000),
  });
  const answer: any = await reply.json().catch(() => null);
  if (!reply.ok || answer === null || typeof answer !== "object") return { error: `the browser failed (${reply.status})` };
  return answer.error ? { ...answer, error: undefined } : answer;
}

async function webFetch(deps: Deps, piece: string, { url, method = "GET" }: Outcome): Promise<Outcome> {
  const { http = fetch } = deps;
  if (method !== "GET" && method !== "HEAD") return { error: "only GET and HEAD are allowed" };
  const target = await allowed(deps, piece, url);
  if (!(target instanceof URL)) return target;

  const reply = await http(target.href, { method, redirect: "manual", signal: AbortSignal.timeout(20_000) });
  const body = method === "HEAD" ? "" : (await reply.text()).slice(0, MAX_BODY);
  let json = null;
  try {
    json = JSON.parse(body);
  } catch { /* not JSON */ }
  return { status: reply.status, body, json };
}

async function model({ store, http = fetch }: Deps, piece: string, { prompt, system }: Outcome): Promise<Outcome> {
  if (!store.granted(piece, "llm")) return notGranted("the model");
  const messages = [...(system ? [{ role: "system", content: String(system) }] : []), { role: "user", content: String(prompt) }];
  const reply = await complete(store, http, { messages });
  const body: any = await reply.json().catch(() => null);
  const text = body?.choices?.[0]?.message?.content;
  if (!reply.ok || typeof text !== "string") return { error: body?.error?.message ?? `the model answered ${reply.status}` };
  return { text };
}

// The target is named as its owner named it. Its interface decides what may
// be called: no scope header is sent, so the gate applies.
async function callPiece({ store, kernel }: Deps, piece: string, { target, method, args = [], chain = [], invoker }: Outcome): Promise<Outcome> {
  const grant = store.granted(piece, "link");
  const wanted = String(target).toLowerCase();
  const found = store.pieces().find((other) => grant?.pieces?.includes(other.id) && (other.id === target || other.name.toLowerCase() === wanted));
  if (!found) return notGranted(String(target));
  if (chain.includes(found.id) || found.id === piece) return { error: "that call would loop" };
  if (chain.length >= MAX_CHAIN) return { error: "that chain of calls is too deep" };
  const { status, body } = await kernel.request("POST", found.id, `rpc/${method}`, { args, chain: [...chain, piece], user: invoker });
  return status === 200 ? { result: body?.result ?? null } : { error: body?.error ?? `the piece answered ${status}` };
}

export function notGranted(what: string): Outcome {
  return { error: `${what} is not granted to this piece` };
}

// "example.com" is that host; "*.example.com" is any host under it; "*" is
// any host at all, which someone has to have typed.
export function hostAllowed(host: string, hosts: unknown): boolean {
  if (!Array.isArray(hosts)) return false;
  const name = host.toLowerCase();
  return hosts.some((pattern) => {
    const allowed = String(pattern).toLowerCase();
    if (allowed === "*") return true;
    if (allowed.startsWith("*.")) return name.endsWith(allowed.slice(1));
    return name === allowed;
  });
}

async function addresses(host: string): Promise<string[]> {
  return (await lookup(host, { all: true })).map((found) => found.address);
}

function isPrivate(address: string): boolean {
  if (isIP(address) === 6) {
    const a = address.toLowerCase();
    return a === "::1" || a === "::" || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80") || a.startsWith("::ffff:");
  }
  const [a, b] = address.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
