// A browser a piece can drive: go to a page, read it, click and type, and
// hand the person a live view to sign in themselves. The browser is Steel's,
// on the operator's key. It goes only to hosts the piece was granted, and a
// page that has wandered elsewhere is neither read nor acted on.
import { randomBytes } from "node:crypto";
import { address, hostAllowed, NO_BROWSER, notGranted, type Deps, type Outcome } from "./effects.ts";

const STEEL = "https://api.steel.dev/v1/sessions";
const MINUTES = 10;
const AT_ONCE = 2;
const MAX_CONTENT = 5_000_000;
const ANSWER_WITHIN = 20_000;
const LOAD_WITHIN = 45_000;

// One tab, spoken to in Chrome's own protocol.
export interface Page {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
  wait(event: string, ms: number): Promise<void>;
  close(): void;
}

export async function answerBrowser(deps: Deps, piece: string, payload: Outcome): Promise<Outcome> {
  const grant = deps.store.granted(piece, "web");
  if (!grant) return notGranted("the web");
  if (payload.kind === "browser_session" && !payload.session) return create(deps, piece);

  const session = deps.store.browser(String(payload.session ?? ""));
  if (!session || session.piece !== piece) return { error: "no such browser session" };
  if (session.status !== "live") return { error: "that browser session was already released" };
  if (Date.now() > session.at + MINUTES * 60_000) {
    await release(deps, session);
    return { error: `that browser session expired (${MINUTES} minute limit)` };
  }

  if (payload.kind === "browser_session") {
    await release(deps, session);
    return { session: session.handle, status: "released" };
  }
  if (payload.kind === "browser_live_view") {
    const left = Math.floor((session.at + MINUTES * 60_000 - Date.now()) / 60_000);
    return { session: session.handle, login_url: `${deps.origin ?? ""}/pieces/${piece}/browser/${session.handle}`, expires_in_minutes: Math.max(left, 0) };
  }

  let target: URL | null = null;
  if (payload.kind === "browser_goto") {
    const found = await address(deps, payload.url, grant.hosts);
    if (!(found instanceof URL)) return found;
    target = found;
  }
  const open = deps.browser ?? openPage;
  const page = await open(`wss://connect.steel.dev?apiKey=${encodeURIComponent(deps.store.open("steel") ?? "")}&sessionId=${session.steel}`);
  try {
    if (target) return await goto(page, target);
    const where = await evaluate(page, "({ url: location.href, title: document.title })");
    const host = hostOf(where.url);
    if (!host || !hostAllowed(host, grant.hosts)) return notGranted(`this session is on ${host ?? "an unknown page"}, which`);
    if (payload.kind === "browser_read") return await read(page, where, payload.content_format);
    return await act(page, where.url, payload.browser_action);
  } finally {
    page.close();
  }
}

async function create(deps: Deps, piece: string): Promise<Outcome> {
  if (deps.store.liveBrowsers(piece).filter((each) => Date.now() <= each.at + MINUTES * 60_000).length >= AT_ONCE) {
    return { error: "this piece already has two browser sessions open; release one first" };
  }
  const made = await steel(deps, "POST", "", { timeout: MINUTES * 60_000 });
  const id = made?.id ?? made?.sessionId;
  if (!id) return { error: "the browser did not start" };
  const handle = `b${randomBytes(12).toString("hex")}`;
  deps.store.addBrowser({ handle, piece, steel: String(id) });
  return { session: handle, expires_in_minutes: MINUTES };
}

async function release(deps: Deps, session: { handle: string; steel: string }): Promise<void> {
  await steel(deps, "POST", `/${session.steel}/release`, {}).catch(() => null);
  deps.store.endBrowser(session.handle);
}

// When a piece is removed, its browsers go with it.
export async function releaseAll(deps: Deps, piece: string): Promise<number> {
  const live = deps.store.liveBrowsers(piece);
  for (const session of live) await release(deps, session);
  return live.length;
}

// The address this app's own page frames so the person can sign in. Null
// unless the session is this piece's and still open. Steel's address is
// refused if it would carry the key.
export async function liveView(deps: Deps, piece: string, handle: string): Promise<string | null> {
  const session = deps.store.browser(handle);
  if (!session || session.piece !== piece || session.status !== "live" || Date.now() > session.at + MINUTES * 60_000) return null;
  const url = String((await steel(deps, "GET", `/${session.steel}`))?.debugUrl ?? "");
  if (!url.startsWith("https://") || url.includes(deps.store.open("steel") ?? "\0")) return null;
  return `${url}${url.includes("?") ? "&" : "?"}interactive=true&showControls=true`;
}

// What the service said when it failed is not passed on: it may repeat the key.
async function steel({ store, http = fetch }: Deps, method: string, path: string, body?: unknown): Promise<any> {
  if (!store.has("steel")) throw new Error(NO_BROWSER);
  const reply = await http(`${STEEL}${path}`, {
    method,
    headers: { "content-type": "application/json", "steel-api-key": store.open("steel") ?? "" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!reply.ok) throw new Error(`the browser failed (${reply.status})`);
  return reply.json().catch(() => null);
}

async function goto(page: Page, target: URL): Promise<Outcome> {
  await page.send("Page.enable");
  const loaded = page.wait("Page.loadEventFired", LOAD_WITHIN);
  const went = await page.send("Page.navigate", { url: target.href });
  if (went?.errorText) return { error: `that page would not load: ${String(went.errorText).slice(0, 120)}` };
  await loaded;
  return evaluate(page, "({ url: location.href, title: document.title })");
}

async function read(page: Page, where: { url: string; title: string }, format: unknown): Promise<Outcome> {
  const html = String(await evaluate(page, "document.documentElement.outerHTML"));
  const content = format === "html" ? html : words(html);
  return { url: where.url, title: where.title, truncated: content.length > MAX_CONTENT, content: content.slice(0, MAX_CONTENT) };
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: "Enter", keyCode: 13, text: "\r" }, Tab: { code: "Tab", keyCode: 9 }, Escape: { code: "Escape", keyCode: 27 },
  Backspace: { code: "Backspace", keyCode: 8 }, Delete: { code: "Delete", keyCode: 46 }, Space: { code: "Space", keyCode: 32, text: " " },
  ArrowUp: { code: "ArrowUp", keyCode: 38 }, ArrowDown: { code: "ArrowDown", keyCode: 40 },
  ArrowLeft: { code: "ArrowLeft", keyCode: 37 }, ArrowRight: { code: "ArrowRight", keyCode: 39 },
};
const ACTIONS = ["click", "type", "fill", "press", "select"];

async function act(page: Page, before: string, action: any): Promise<Outcome> {
  const type = String(action?.type ?? "");
  if (!ACTIONS.includes(type)) return { error: `unknown action ${type || "(none)"} (${ACTIONS.join(", ")})` };
  const selector = String(action.selector ?? "");
  if (!selector && type !== "press") return { error: "act requires a selector" };
  const chosen = JSON.stringify(selector);
  const missing = { error: `no element matches ${selector}` };

  if (type === "click") {
    const at = await evaluate(page, `(() => { const el = document.querySelector(${chosen}); if (!el) return null;
      el.scrollIntoView({ block: "center" }); const box = el.getBoundingClientRect(); return { x: box.x + box.width / 2, y: box.y + box.height / 2 }; })()`);
    if (!at) return missing;
    for (const kind of ["mousePressed", "mouseReleased"]) await page.send("Input.dispatchMouseEvent", { type: kind, x: at.x, y: at.y, button: "left", clickCount: 1 });
  } else if (type === "type" || type === "fill") {
    const text = String(action.text ?? "");
    if (!text) return { error: `${type} requires text` };
    const found = await evaluate(page, `(() => { const el = document.querySelector(${chosen}); if (!el) return null; el.focus();
      ${type === "fill" ? 'el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true }));' : ""} return { x: 0, y: 0 }; })()`);
    if (!found) return missing;
    await page.send("Input.insertText", { text });
  } else if (type === "press") {
    const key = KEYS[String(action.key ?? "")];
    if (!key) return { error: `press knows ${Object.keys(KEYS).join(", ")}` };
    if (selector && !(await evaluate(page, `(() => { const el = document.querySelector(${chosen}); if (!el) return null; el.focus(); return { x: 0, y: 0 }; })()`))) return missing;
    const params = { key: String(action.key), code: key.code, windowsVirtualKeyCode: key.keyCode, ...(key.text ? { text: key.text } : {}) };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
  } else {
    const value = String(action.value ?? "");
    if (!value) return { error: "select requires a value" };
    const found = await evaluate(page, `(() => { const el = document.querySelector(${chosen}); if (!el) return null;
      const want = ${JSON.stringify(value)}; const option = [...el.options ?? []].find((each) => each.value === want || each.label === want);
      if (!option) return null; el.value = option.value;
      for (const name of ["input", "change"]) el.dispatchEvent(new Event(name, { bubbles: true })); return { x: 0, y: 0 }; })()`);
    if (!found) return { error: `no element matches ${selector}, or it has no option ${value}` };
  }
  const after = await evaluate(page, "({ url: location.href, title: document.title })");
  return { acted: type, url_before: before, url: after.url };
}

async function evaluate(page: Page, expression: string): Promise<any> {
  const reply = await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (reply?.exceptionDetails) throw new Error("the page would not answer that");
  return reply?.result?.value ?? null;
}

function hostOf(url: unknown): string | null {
  try { return new URL(String(url)).hostname || null; } catch { return null; }
}

// The words on a page: scripts and styles dropped, labels kept, tags gone.
function words(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]*?\baria-label=("|')(.*?)\1[^>]*>/gi, " $2 ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// The real thing: a socket to the browser, attached to its first tab.
export async function openPage(where: string): Promise<Page> {
  const socket = new WebSocket(where);
  await new Promise<void>((ok, fail) => {
    socket.onopen = () => ok();
    socket.onerror = () => fail(new Error("the browser did not answer"));
  });
  let last = 0;
  const waiting = new Map<number, { ok: (value: any) => void; fail: (error: Error) => void }>();
  const heard = new Set<(method: string) => void>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    const asked = waiting.get(message.id);
    if (!asked) return heard.forEach((each) => each(message.method));
    waiting.delete(message.id);
    if (message.error) asked.fail(new Error(`the browser refused: ${String(message.error.message).slice(0, 120)}`));
    else asked.ok(message.result);
  };
  socket.onclose = () => waiting.forEach((asked) => asked.fail(new Error("the browser session ended")));
  const raw = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((ok, fail) => {
    const id = ++last;
    const timer = setTimeout(() => { waiting.delete(id); fail(new Error(`the browser took longer than ${ANSWER_WITHIN / 1000}s`)); }, method === "Page.navigate" ? LOAD_WITHIN : ANSWER_WITHIN);
    waiting.set(id, { ok: (value) => { clearTimeout(timer); ok(value); }, fail: (error) => { clearTimeout(timer); fail(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  try {
    const { targetInfos = [] } = await raw("Target.getTargets");
    const tab = targetInfos.find((each: any) => each.type === "page") ?? await raw("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await raw("Target.attachToTarget", { targetId: tab.targetId, flatten: true });
    return {
      send: (method, params) => raw(method, params, sessionId),
      wait: (event, ms) => new Promise<void>((ok, fail) => {
        const timer = setTimeout(() => { heard.delete(hear); fail(new Error(`that page took longer than ${ms / 1000}s to load`)); }, ms);
        const hear = (method: string) => { if (method === event) { clearTimeout(timer); heard.delete(hear); ok(); } };
        heard.add(hear);
      }),
      close: () => socket.close(),
    };
  } catch (error) {
    socket.close();
    throw error;
  }
}
