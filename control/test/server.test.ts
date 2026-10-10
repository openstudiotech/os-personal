import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, APP_KEYS } from "../src/store.ts";
import { createApp, sessionCookie } from "../src/server.ts";
import { COUNTER, fakeKernel, makeZip, manifest } from "./support.ts";

// The services say yes to any key except one starting "bad".
const accepting = async (url: string, init: any) =>
  new Response(url.includes("/v1/sessions/") ? JSON.stringify({ debugUrl: `${url}/player` }) : "{}", { status: /bad/.test(JSON.stringify(init.headers)) ? 401 : 200 });

function app(store = new Store(":memory:"), kernel = fakeKernel()) {
  return { store, kernel, handle: createApp({ store, secret: "let-me-in", kernel, reach: { http: accepting } }) };
}

function ready() {
  const made = app();
  for (const key of APP_KEYS) made.store.seal(key.name, "set");
  return made;
}

function upload(bytes: Uint8Array): Request {
  const form = new FormData();
  form.set("piece", new File([bytes], "counter.zip", { type: "application/zip" }));
  return new Request("http://local/pieces", { method: "POST", headers: signedIn, body: form });
}

const signedIn = { cookie: `session=${sessionCookie("let-me-in")}` };

test("nothing is served without the secret", async () => {
  const { handle } = app();
  const reply = await handle(new Request("http://local/"));
  assert.equal(reply.status, 401);
  assert.match(await reply.text(), /secret/i);
});

test("the page that asks for the secret says where it is", async () => {
  const asked = async (secretAt: any) => {
    const handle = createApp({ store: new Store(":memory:"), secret: "let-me-in", kernel: fakeKernel(), secretAt });
    return (await handle(new Request("http://local/"))).text();
  };
  assert.match(await asked({ file: "data/secret" }), /It is in <code[^>]*>data\/secret<\/code>\./);

  const variable = await asked({ variable: "OPENSTUDIO_SECRET" });
  assert.match(variable, /It is the value of <code[^>]*>OPENSTUDIO_SECRET<\/code>\./);
  assert.doesNotMatch(variable, /Railway/);
  assert.doesNotMatch(variable, /let-me-in/, "it says where the secret is, never what it is");

  const linked = await asked({ variable: "OPENSTUDIO_SECRET", link: "https://railway.com/project/p/service/s/variables?environmentId=e" });
  assert.match(linked, /<a href="https:\/\/railway\.com\/project\/p\/service\/s\/variables\?environmentId=e"[^>]*>this service's variables on Railway<\/a>/);

  assert.doesNotMatch(await asked(undefined), /It is/);
});

test("the secret, once given, is kept as a cookie", async () => {
  const { handle } = app();
  const wrong = await handle(new Request("http://local/enter", { method: "POST", body: new URLSearchParams({ secret: "guess" }) }));
  assert.equal(wrong.status, 401);

  const right = await handle(new Request("http://local/enter", { method: "POST", body: new URLSearchParams({ secret: "let-me-in" }) }));
  assert.equal(right.status, 303);
  const cookie = right.headers.get("set-cookie") ?? "";
  assert.match(cookie, /^session=[0-9a-f]{64}; HttpOnly; SameSite=Strict/);
  assert.doesNotMatch(cookie, /let-me-in/, "the cookie is not the secret");
});

test("with keys missing, every page is the setup page", async () => {
  const { handle } = app();
  const home = await handle(new Request("http://local/", { headers: signedIn }));
  assert.equal(home.status, 303);
  assert.equal(home.headers.get("location"), "/setup");

  const setup = await handle(new Request("http://local/setup", { headers: signedIn }));
  const page = await setup.text();
  for (const key of APP_KEYS) assert.match(page, new RegExp(`name="${key.name}"`));
  for (const key of APP_KEYS) assert.ok(page.includes(`${key.does} <a href="${key.url}"`), `${key.label} says what it is for and where to make one`);
  assert.match(page, /<img src="\/marcel-large\.png"[^>]*>\s*<div[^>]*><p>Hi 👋 I'm Marcel, your personal agent\. I get things done for you\.<\/p>\s*<p>I need at least one key to think with\./, "Marcel says who he is");
  assert.match(page, /<img src="\/mark-black\.svg"[^>]*><\/picture>\s*<h1[^>]*>OpenStudio<\/h1>/);
  assert.match(page, /name="openrouter"[^>]*\srequired/);
  assert.doesNotMatch(page, /name="steel"[^>]*\srequired/);
  assert.doesNotMatch(page, /firecrawl/i);
});

test("setup needs the OpenRouter key and takes the other two or not, and never shows one back", async () => {
  const { store, handle } = app();
  const partial = await handle(new Request("http://local/setup", {
    method: "POST", headers: signedIn, body: new URLSearchParams({ steel: "ste-abc" }),
  }));
  assert.equal(partial.status, 422);
  assert.equal(store.ready(), false);

  const one = app();
  const alone = await one.handle(new Request("http://local/setup", { method: "POST", headers: signedIn, body: new URLSearchParams({ openrouter: "sk-or-abc" }) }));
  assert.equal(alone.status, 303);
  assert.equal(alone.headers.get("location"), "/new", "the first time, straight to Marcel");
  assert.equal(one.store.ready(), true, "the OpenRouter key alone is enough to start");
  const keys = await (await one.handle(new Request("http://local/services", { headers: signedIn }))).text();
  assert.match(keys, /Steel key · optional<\/label>\s*<p[^>]*>Gives Marcel a browser/, "a key not added still says what it is for");
  const later = await one.handle(new Request("http://local/setup", { method: "POST", headers: signedIn, body: new URLSearchParams({ steel: "ste-abc" }) }));
  assert.equal(later.headers.get("location"), "/services", "a key added later stays on the keys page");

  const full = await handle(new Request("http://local/setup", {
    method: "POST", headers: signedIn,
    body: new URLSearchParams({ openrouter: "sk-or-abc", steel: "ste-abc" }),
  }));
  assert.equal(full.status, 303);
  assert.equal(store.ready(), true);

  const home = await handle(new Request("http://local/pieces", { headers: signedIn }));
  assert.equal(home.status, 200);
  const again = await (await handle(new Request("http://local/services", { headers: signedIn }))).text();
  assert.doesNotMatch(again, /sk-or-abc|ste-abc/);
});

test("a loaded piece is listed and opens on its own page", async () => {
  const { handle, store } = ready();
  const loaded = await handle(upload(makeZip({
    "manifest.yml": manifest({ connections: [{ kind: "web", config: {} }, { kind: "llm", config: {} }] }),
    "files/piece.js": COUNTER,
  })));
  assert.equal(loaded.status, 303);
  const [piece] = store.pieces();
  assert.equal(loaded.headers.get("location"), `/pieces/${piece.id}`);

  const home = await (await handle(new Request("http://local/pieces", { headers: signedIn }))).text();
  assert.match(home, new RegExp(`href="/pieces/${piece.id}"[^>]*>Counter<`));

  const page = await (await handle(new Request(`http://local/pieces/${piece.id}`, { headers: signedIn }))).text();
  assert.match(page, new RegExp(`<iframe[^>]*src="http://kernel.test/pieces/${piece.id}/client\\?ticket=ticket"`));
  // The piece sits in one window, under tabs for its three sides.
  assert.match(page, /<section data-window="app"[^>]*><iframe/);
  for (const [label, path] of [["App", ""], ["Code", "/code"], ["Access", "/access"]]) {
    assert.match(page, new RegExp(`href="/pieces/${piece.id}${path}"[^>]*>${label}<`));
  }
  // What it asks for is on Access, and it has none of it yet.
  const access = await (await handle(new Request(`http://local/pieces/${piece.id}/access`, { headers: signedIn }))).text();
  assert.match(access, /Asks for/);
  assert.match(access, /<ul data-wants[^>]*><li[^>]*>web<\/li><li[^>]*>llm<\/li>/);
  assert.match(access, /href="\/pieces\/[a-z0-9]+\/access" aria-current="page"/);
});

test("a file that is not a piece says why, and nothing is listed", async () => {
  const { handle, store } = ready();
  const refused = await handle(upload(makeZip({ "files/piece.js": COUNTER })));
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /no manifest\.yml/);
  assert.equal(store.pieces().length, 0);
});

// As in OpenStudio: a piece's log and raw state are for whoever writes it,
// not a page. An AI client reads them over MCP.
test("a piece's log and raw state are not pages", async () => {
  const { handle, store, kernel } = ready();
  store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });
  for (const view of ["state", "logs", "activity"]) {
    const reply = await handle(new Request(`http://local/pieces/pabc/${view}`, { headers: signedIn }));
    assert.equal(reply.headers.get("location"), "/pieces/pabc", view);
  }
  assert.equal(kernel.calls.filter((call) => call.route === "state" || call.route === "logs").length, 0);
  assert.doesNotMatch(await (await handle(new Request("http://local/pieces/pabc", { headers: signedIn }))).text(), /Activity|Logs|State/);
});

test("Code shows the files one at a time, and every version, with the good ones able to be put back", async () => {
  const made = ready();
  const kernel = fakeKernel({
    "GET files": { status: 200, body: { files: { "tasks.js": "// tasks", "piece.js": "class <Piece> {}", "logo.png": "iVBORw0KGgo=" } } },
    "GET versions": { status: 200, body: { versions: [
      { version: 3, at: 1760000000000, restoredFrom: 1 },
      { version: 2, at: 1759990000000, loadError: "SyntaxError" },
      { version: 1, at: 1759980000000, tests: { total: 4, passed: 4, failed: 0 } },
    ] } },
  });
  const handle = createApp({ store: made.store, secret: "let-me-in", kernel });
  made.store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });

  const code = await (await handle(new Request("http://local/pieces/pabc/code", { headers: signedIn }))).text();
  assert.match(code, /<pre[^>]*>class &#60;Piece&#62; \{\}<\/pre>/, "piece.js opens first, shown as text");
  assert.match(code, /file=piece\.js" aria-current="page"/);
  assert.match(await (await handle(new Request("http://local/pieces/pabc/code?file=logo.png", { headers: signedIn }))).text(), /logo\.png is a picture/);

  assert.match(code, /data-version="3"[\s\S]*?Put back from v1[\s\S]*?Current/);
  assert.match(code, /data-version="2"[\s\S]*?Would not load/);
  assert.match(code, /action="\/pieces\/pabc\/restore\/1"/);
  assert.doesNotMatch(code, /restore\/2"/, "a version that would not load cannot be put back");
  assert.doesNotMatch(code, /restore\/3"/, "nor the one already current");

  const back = await handle(new Request("http://local/pieces/pabc/restore/1", { method: "POST", headers: signedIn }));
  assert.equal(back.headers.get("location"), "/pieces/pabc/code");
  assert.deepEqual(kernel.calls.at(-1), { method: "POST", piece: "pabc", route: "versions/1/restore", body: undefined });
});

test("removing a piece removes it from the kernel and from the list", async () => {
  const { handle, store, kernel } = ready();
  store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });

  const removed = await handle(new Request("http://local/pieces/pabc/remove", { method: "POST", headers: signedIn }));
  assert.equal(removed.status, 303);
  assert.ok(kernel.calls.some((call) => call.method === "DELETE" && call.piece === "pabc"));
  assert.equal(store.piece("pabc"), null);
});

test("a piece that is not there is not found", async () => {
  const { handle } = ready();
  assert.equal((await handle(new Request("http://local/pieces/nope", { headers: signedIn }))).status, 404);
});

function callback(piece: string, body: unknown, signed = true): Request {
  return new Request(`http://local/api/v1/pieces/${piece}/fetch`, {
    method: "POST",
    headers: { authorization: signed ? "Kernel signed" : "Kernel forged", "x-kernel-org": "local", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("the kernel's callback is answered only when it is signed, and needs no cookie", async () => {
  const { handle, store } = ready();
  store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });

  const forged = await handle(callback("pabc", { kind: "llm", prompt: "x" }, false));
  assert.equal(forged.status, 401);

  const refused = await handle(callback("pabc", { kind: "llm", prompt: "x" }));
  assert.equal(refused.status, 200);
  assert.match((await refused.json()).error, /not granted/);

  const wrongOrg = callback("pabc", { kind: "llm", prompt: "x" });
  wrongOrg.headers.set("x-kernel-org", "someone-else");
  assert.equal((await handle(wrongOrg)).status, 401);
});

test("granting on the piece's page is what lets the callback through", async () => {
  const made = ready();
  const handle = createApp({
    store: made.store, secret: "let-me-in", kernel: made.kernel,
    reach: { http: async () => new Response("hello"), resolve: async () => ["93.184.216.34"] },
  });
  made.store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });
  const fetching = { kind: "fetch", url: "https://example.com/", method: "GET" };

  assert.match((await (await handle(callback("pabc", fetching))).json()).error, /not granted/);

  const granted = await handle(new Request("http://local/pieces/pabc/grant", {
    method: "POST", headers: signedIn, body: new URLSearchParams({ kind: "web", hosts: "Example.com, *.example.org" }),
  }));
  assert.equal(granted.status, 303);
  assert.deepEqual(made.store.granted("pabc", "web"), { hosts: ["example.com", "*.example.org"] });
  assert.equal((await (await handle(callback("pabc", fetching))).json()).body, "hello");

  await handle(new Request("http://local/pieces/pabc/revoke", { method: "POST", headers: signedIn, body: new URLSearchParams({ kind: "web" }) }));
  assert.match((await (await handle(callback("pabc", fetching))).json()).error, /not granted/);

  const page = await (await handle(new Request("http://local/pieces/pabc/access", { headers: signedIn }))).text();
  assert.match(page, /Reaches/);
});

test("granting needs the secret, and only known kinds can be granted", async () => {
  const { handle, store } = ready();
  store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });

  const stranger = await handle(new Request("http://local/pieces/pabc/grant", { method: "POST", body: new URLSearchParams({ kind: "llm" }) }));
  assert.equal(stranger.status, 401);
  assert.equal(store.granted("pabc", "llm"), null);

  const odd = await handle(new Request("http://local/pieces/pabc/grant", { method: "POST", headers: signedIn, body: new URLSearchParams({ kind: "everything" }) }));
  assert.equal(odd.status, 422);
});

test("a schedule is added on the piece's page, off, then turned on and run", async () => {
  const made = ready();
  const kernel = fakeKernel({ "GET tasks": { status: 200, body: { tasks: ["refresh"] } } });
  const handle = createApp({ store: made.store, secret: "let-me-in", kernel });
  made.store.addPiece({ id: "pabc", name: "Brief", description: "", wants: [] });

  const added = await handle(new Request("http://local/pieces/pabc/schedules", {
    method: "POST", headers: signedIn,
    body: new URLSearchParams({ task: "refresh", freq: "daily", hour: "8", minute: "0", every: "60", timeZone: "America/Chicago" }),
  }));
  assert.equal(added.status, 303);
  const [schedule] = made.store.schedules("pabc");
  assert.equal(schedule.enabled, false);

  const page = await (await handle(new Request("http://local/pieces/pabc/access", { headers: signedIn }))).text();
  assert.match(page, /Every day at 08:00, America\/Chicago/);
  assert.match(page, /Off/);

  await handle(new Request(`http://local/schedules/${schedule.id}/on`, { method: "POST", headers: signedIn }));
  assert.equal(made.store.schedule(schedule.id)?.enabled, true);
  assert.ok(kernel.calls.some((call) => call.method === "PUT" && call.route === `schedules/${schedule.id}`));

  await handle(new Request(`http://local/schedules/${schedule.id}/run`, { method: "POST", headers: signedIn }));
  assert.equal(kernel.calls.at(-1)?.route, "task/refresh");

  const bad = await handle(new Request("http://local/pieces/pabc/schedules", {
    method: "POST", headers: signedIn, body: new URLSearchParams({ task: "refresh", freq: "daily", hour: "99", minute: "0", timeZone: "UTC" }),
  }));
  assert.equal(bad.status, 422);
});

test("the kernel can switch a schedule off, and nothing else, and only when signed", async () => {
  const { handle, store } = ready();
  store.addPiece({ id: "pabc", name: "Brief", description: "", wants: [] });
  const id = store.addSchedule({ piece: "pabc", task: "refresh", spec: { freq: "hourly", timeZone: "UTC", minute: 0 } });
  store.setEnabled(id, true);
  const said = (status: string, signed = true) => new Request(`http://local/api/v1/pieces/schedules/${id}/status`, {
    method: "POST", headers: { authorization: signed ? "Kernel signed" : "Kernel forged", "x-kernel-org": "local" },
    body: JSON.stringify({ status, reason: "cell method refresh failed: boom" }),
  });

  assert.equal((await handle(said("paused_failures", false))).status, 401);
  assert.equal(store.schedule(id)?.enabled, true);

  await handle(said("running"));
  assert.equal(store.schedule(id)?.enabled, true, "it cannot be told to start anything");

  assert.equal((await handle(said("paused_failures"))).status, 200);
  assert.equal(store.schedule(id)?.enabled, false);
  assert.match(store.schedule(id)?.stopped ?? "", /boom/);
});

test("removing a piece takes its schedules out of the kernel too", async () => {
  const { handle, store, kernel } = ready();
  store.addPiece({ id: "pabc", name: "Brief", description: "", wants: [] });
  const id = store.addSchedule({ piece: "pabc", task: "refresh", spec: { freq: "hourly", timeZone: "UTC", minute: 0 } });

  await handle(new Request("http://local/pieces/pabc/remove", { method: "POST", headers: signedIn }));

  assert.ok(kernel.calls.some((call) => call.method === "DELETE" && call.route === `schedules/${id}`));
  assert.equal(store.schedules().length, 0);
});

test("a key the service does not accept is named, and the good ones are kept", async () => {
  const { handle, store } = app();
  const reply = await handle(new Request("http://local/setup", {
    method: "POST", headers: signedIn,
    body: new URLSearchParams({ openrouter: "bad-key", steel: "ste-good" }),
  }));

  assert.equal(reply.status, 422);
  const page = await reply.text();
  assert.match(page, /OpenRouter did not accept that key/);
  assert.doesNotMatch(page, /bad-key|ste-good/);
  assert.equal(store.has("openrouter"), false);
  assert.equal(store.has("steel"), true);
  assert.equal(store.ready(), false);

  // Only the wrong one needs typing again.
  const fixed = await handle(new Request("http://local/setup", { method: "POST", headers: signedIn, body: new URLSearchParams({ openrouter: "sk-or-good" }) }));
  assert.equal(fixed.status, 303);
  assert.equal(store.ready(), true);
});

test("a saved key that has stopped working shows on the setup page", async () => {
  const { handle, store } = app();
  store.seal("openrouter", "bad-now");
  store.seal("steel", "ste-good");

  assert.equal((await handle(new Request("http://local/setup", { headers: signedIn }))).headers.get("location"), "/services", "once set up, the keys live under Services");
  const page = await (await handle(new Request("http://local/services", { headers: signedIn }))).text();
  assert.match(page, /OpenRouter did not accept that key/);
  assert.match(page, /Saved, but not working/);
  assert.equal((page.match(/Saved and working/g) ?? []).length, 1);
});

test("a service that cannot be reached is said plainly, and the key is not saved", async () => {
  const store = new Store(":memory:");
  const handle = createApp({ store, secret: "let-me-in", kernel: fakeKernel(), reach: { http: async () => { throw new Error("offline"); } } });
  const reply = await handle(new Request("http://local/setup", {
    method: "POST", headers: signedIn, body: new URLSearchParams({ openrouter: "a", steel: "b" }),
  }));
  assert.equal(reply.status, 422);
  assert.match(await reply.text(), /could not be reached/);
  assert.equal(store.has("openrouter"), false);
});

test("an AI client is let in by its token, and by nothing else", async () => {
  const { handle } = ready();
  const { mcpToken } = await import("../src/server.ts");
  const ask = (headers: Record<string, string>, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/list" }) =>
    handle(new Request("http://local/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }));

  assert.equal((await ask({})).status, 401);
  assert.equal((await ask(signedIn)).status, 401, "the browser's cookie is not a token");
  assert.equal((await ask({ authorization: "Bearer let-me-in" })).status, 401, "nor is the secret itself");

  const token = { authorization: `Bearer ${mcpToken("let-me-in")}` };
  const listed = await ask(token);
  assert.equal(listed.status, 200);
  assert.ok((await listed.json()).result.tools.length > 0);

  assert.equal((await ask(token, { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
  assert.equal((await ask({ ...token, origin: "https://evil.test" })).status, 403, "a page on another site cannot use it");
});

test("the connect page shows the token only to someone who gave the secret", async () => {
  const { handle } = ready();
  const { mcpToken } = await import("../src/server.ts");

  const stranger = await handle(new Request("http://local/settings/client"));
  assert.equal(stranger.status, 401);
  assert.doesNotMatch(await stranger.text(), new RegExp(mcpToken("let-me-in")));

  const page = await (await handle(new Request("http://local/settings/client", { headers: signedIn }))).text();
  assert.match(page, /claude mcp add --transport http openstudio-personal http:\/\/local\/mcp/);
  assert.match(page, /codex mcp add openstudio-personal --url http:\/\/local\/mcp --bearer-token-env-var OPENSTUDIO_PERSONAL_TOKEN/);
  assert.match(page, new RegExp(mcpToken("let-me-in")));
});

test("a chat starts at /new, shows what he did and said, and joins the list on the left", async () => {
  const made = ready();
  const replies = [
    { content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "list_pieces", arguments: "{}" } }] },
    { content: "You have one piece, <b>Counter</b>." },
    { content: "Still one." },
  ];
  const http = async () => Response.json({ choices: [{ message: { role: "assistant", ...replies.shift() } }] });
  const handle = createApp({ store: made.store, secret: "let-me-in", kernel: made.kernel, reach: { http } });
  made.store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });

  assert.equal((await handle(new Request("http://local/new", { method: "POST", body: new URLSearchParams({ say: "hi" }) }))).status, 401, "he is not for strangers");
  assert.equal((await handle(new Request("http://local/", { headers: signedIn }))).headers.get("location"), "/new", "talking to him is the front door");
  const start = await (await handle(new Request("http://local/new", { headers: signedIn }))).text();
  assert.match(start, /action="\/new"/);
  assert.match(start, /<textarea[^>]*onkeydown="[^"]*event\.key === 'Enter'[^"]*!event\.shiftKey[^"]*requestSubmit/, "Enter sends, Shift and Enter does not");
  assert.match(start, /What are we doing today\?/);
  assert.match(start, /<button disabled aria-label="Send"/, "the button waits for something to send");

  const sent = await handle(new Request("http://local/new", { method: "POST", headers: signedIn, body: new URLSearchParams({ say: "what do I have?", zone: "Europe/Paris" }) }));
  assert.equal(made.store.setting("zone"), "Europe/Paris", "where the browser is, for telling him the time");
  assert.equal(sent.status, 303);
  const [chat] = made.store.chats();
  assert.equal(sent.headers.get("location"), `/chats/${chat.id}#latest`);
  assert.equal(chat.title, "what do I have?");

  // He answers after the page is sent. Until he has, the page says he is
  // working, shows what you said, and takes nothing more.
  const during = await (await handle(new Request(`http://local/chats/${chat.id}`, { headers: signedIn }))).text();
  assert.match(during, /<div data-transcript data-working[^>]*>[\s\S]*what do I have\?[\s\S]*Marcel is working/);
  assert.match(during, /<form data-say data-working /, "nothing more is sent until he is done");
  assert.doesNotMatch(during, /<textarea name="say"[^>]* disabled/, "but the box can be typed in meanwhile");
  await handle.idle();

  const page = await (await handle(new Request(`http://local/chats/${chat.id}`, { headers: signedIn }))).text();
  assert.match(page, /<p data-did[^>]*>Looked at your pieces/);
  assert.match(page, /<div data-line="you"[^>]*class="flex flex-col items-end gap-2">/, "what you said sits on the right");
  assert.doesNotMatch(page, /<div data-transcript data-working|<form data-say data-working|Marcel is working/);
  assert.match(page, /<div class="sticky bottom-0[^"]*"><form data-say/, "and the box stays at the foot");
  assert.match(page, /You have one piece, &#60;b&#62;Counter/, "what the model says is shown as text");
  assert.match(page, new RegExp(`<aside data-side[\\s\\S]*href="/chats/${chat.id}" aria-current="page"[^>]*>[\\s\\S]*?<span[^>]*>what do I have\\?<`), "it is in the menu, marked as where you are");

  await handle(new Request(`http://local/chats/${chat.id}`, { method: "POST", headers: signedIn, body: new URLSearchParams({ say: "and now?", zone: "Not/AZone" }) }));
  assert.equal(made.store.setting("zone"), "Europe/Paris", "a timezone that is not one is not kept");
  await handle.idle();
  assert.deepEqual(made.store.conversation(chat.id).map((line) => line.role), ["you", "did", "marcel", "you", "marcel"]);

  await handle(new Request(`http://local/chats/${chat.id}/remove`, { method: "POST", headers: signedIn }));
  assert.equal(made.store.chats().length, 0);
  assert.equal((await handle(new Request(`http://local/chats/${chat.id}`, { headers: signedIn }))).status, 404);
});

test("the menu is on every page once you are in, and on none before", async () => {
  const { handle } = ready();
  for (const path of ["/new", "/pieces", "/services", "/settings/memory", "/settings/client"]) {
    const page = await (await handle(new Request(`http://local${path}`, { headers: signedIn }))).text();
    assert.match(page, /<aside data-side/, path);
    assert.match(page, /<input id="menu" type="checkbox"[^>]*class="peer sr-only">[\s\S]*<label for="menu"[\s\S]*<nav class="hidden [^"]*peer-checked:flex md:flex"/, "on a phone the menu opens from a button");
    assert.match(page, /<span>New chat<\/span>/, path);
    assert.match(page, /href="\/new"[^>]*>[^]*?<svg[^]*?<span[^>]*>Marcel<\/span>/, path);
    assert.match(page, /href="\/pieces"[^>]*>[^]*?<svg[^]*?<span[^>]*>Pieces<\/span>/, path);
    assert.match(page, /href="\/services"[^>]*>[^]*?<svg[^]*?<span[^>]*>Services<\/span>/, path);
    assert.match(page, /href="\/settings\/memory"[^>]*>[^]*?<svg[^]*?<span[^>]*>Settings<\/span>/, path);
    assert.match(page, /<link rel="stylesheet" href="\/app\.css">/, path);
    assert.match(page, /Recent chats/, path);
  }
  assert.match(await (await handle(new Request("http://local/pieces", { headers: signedIn }))).text(), /href="\/pieces" aria-current="page"/);

  assert.doesNotMatch(await (await handle(new Request("http://local/new"))).text(), /data-side/, "a stranger sees no menu");
  const unready = app();
  assert.doesNotMatch(await (await unready.handle(new Request("http://local/setup", { headers: signedIn }))).text(), /data-side/, "nor does setup before the keys are in");
});

test("notes can be added, loaded from a file, and deleted, and a key is refused", async () => {
  const { handle, store } = ready();
  await handle(new Request("http://local/notes", { method: "POST", headers: signedIn, body: new URLSearchParams({ note: "Flies aisle" }) }));

  const form = new FormData();
  form.set("file", new File([JSON.stringify([{ detail: "Nothing before seven" }])], "finn.json", { type: "application/json" }));
  const loaded = await handle(new Request("http://local/notes", { method: "POST", headers: signedIn, body: form }));
  assert.match(await loaded.text(), /1 note loaded/);
  assert.equal(store.memories().length, 2);

  const refused = await handle(new Request("http://local/notes", { method: "POST", headers: signedIn, body: new URLSearchParams({ note: "password: hunter2" }) }));
  assert.equal(refused.status, 422);
  assert.match(await refused.text(), /key or a password/);

  const [first] = store.memories();
  await handle(new Request(`http://local/notes/${first.id}/forget`, { method: "POST", headers: signedIn }));
  assert.equal(store.memories().length, 1);
});

test("Marcel is home, and nothing says who he is unless he is asked", async () => {
  const { handle } = ready();
  assert.equal((await handle(new Request("http://local/marcel", { headers: signedIn }))).headers.get("location"), "/new");
  for (const path of ["/new", "/settings/memory"]) {
    const page = await (await handle(new Request(`http://local${path}`, { headers: signedIn }))).text();
    assert.doesNotMatch(page, /raccoon|Oakland|Breuer/i, path);
  }
  const { systemPrompt } = await import("../src/marcel.ts");
  const { Store: Fresh } = await import("../src/store.ts");
  assert.match(systemPrompt(new Fresh(":memory:")), /Do not bring up being a raccoon/);
});

// On your own machine there is nothing to type. What is refused is anything
// that did not come from this app's own pages.
function atHome() {
  const store = new Store(":memory:");
  for (const key of APP_KEYS) store.seal(key.name, "set");
  const kernel = fakeKernel();
  const handle = createApp({ store, secret: "let-me-in", kernel, local: true, reach: { http: accepting } });
  const ask = (path: string, init: RequestInit & { headers?: Record<string, string> } = {}) =>
    handle(new Request(`http://127.0.0.1:4010${path}`, { ...init, headers: { host: "127.0.0.1:4010", ...init.headers } }));
  return { store, kernel, ask };
}

test("on this machine alone, the app opens with nothing to type", async () => {
  const { ask, store } = atHome();
  const home = await ask("/new");
  assert.equal(home.status, 200);
  assert.match(await home.text(), /<aside data-side/);
  assert.equal((await ask("/pieces")).status, 200);

  const noted = await ask("/notes", { method: "POST", headers: { origin: "http://127.0.0.1:4010" }, body: new URLSearchParams({ note: "Flies aisle" }) });
  assert.equal(noted.status, 303);
  assert.equal(store.memories().length, 1);
});

test("a page on another website cannot make it do anything", async () => {
  const { ask, store } = atHome();
  store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });

  for (const headers of [{ origin: "https://evil.test" }, { "sec-fetch-site": "cross-site" }, { origin: "http://localhost:9999" }]) {
    const granted = await ask("/pieces/pabc/grant", { method: "POST", headers, body: new URLSearchParams({ kind: "web", hosts: "*" }) });
    assert.equal(granted.status, 403, JSON.stringify(headers));
    const said = await ask("/new", { method: "POST", headers, body: new URLSearchParams({ say: "do something" }) });
    assert.equal(said.status, 403, JSON.stringify(headers));
  }
  assert.equal(store.granted("pabc", "web"), null);
  assert.equal(store.chats().length, 0);
});

test("it answers only to this machine's own name", async () => {
  const { ask } = atHome();
  for (const host of ["evil.test", "evil.test:4010", "127.0.0.1.evil.test:4010", "192.168.1.20:4010"]) {
    assert.equal((await ask("/pieces", { headers: { host } })).status, 403, host);
  }
  for (const host of ["localhost:4010", "127.0.0.1:4010", "[::1]:4010"]) {
    assert.equal((await ask("/pieces", { headers: { host } })).status, 200, host);
  }
});

test("even at home, an AI client needs its token and the kernel its signature", async () => {
  const { ask } = atHome();
  const { mcpToken } = await import("../src/server.ts");
  const mcp = (headers: Record<string, string>) => ask("/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  assert.equal((await mcp({})).status, 401);
  assert.equal((await mcp({ authorization: `Bearer ${mcpToken("let-me-in")}` })).status, 200);

  const forged = await ask("/api/v1/pieces/pabc/fetch", { method: "POST", headers: { authorization: "Kernel forged", "x-kernel-org": "local" }, body: "{}" });
  assert.equal(forged.status, 401);
});

test("the front page says what is left to set up, from what is actually so", async () => {
  const { handle, store } = ready();
  const page = async () => (await (await handle(new Request("http://local/new", { headers: signedIn }))).text());

  const first = await page();
  assert.match(first, /Getting started · 1 of 6/);
  assert.match(first, /<details data-steps[^>]* open>/, "open while there is much left");
  assert.match(first, /<li data-done[^>]*>[\s\S]*?<span[^>]*>Add your keys<\/span>/);
  assert.match(first, /<a href="\/pieces"[^>]*>Load a piece<\/a>/);
  assert.match(first, /<a href="\/settings\/client"[^>]*>Connect your AI client<\/a>/);

  store.addPiece({ id: "pabc", name: "Counter", description: "", wants: [] });
  store.grant("pabc", "llm", {});
  store.addMemory("Flies aisle");
  const later = await page();
  assert.match(later, /Getting started · 4 of 6/);
  assert.match(later, /<details data-steps class="[^"]*">/, "folded once most is done");

  store.setEnabled(store.addSchedule({ piece: "pabc", task: "tick", spec: { freq: "hourly", timeZone: "UTC", minute: 0 } }), true);
  assert.match(await page(), /Getting started · 5 of 6/, "an AI client has yet to call");
  const { mcpToken } = await import("../src/server.ts");
  await handle(new Request("http://local/mcp", { method: "POST", headers: { authorization: `Bearer ${mcpToken("let-me-in")}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }));
  assert.doesNotMatch(await page(), /Getting started/, "gone when it is all done");
});

// The stylesheet is built from the pages' classes and committed, so running
// the app needs no build. If a class is used that the built file lacks, the
// page would quietly lose that style.
test("the built stylesheet is not behind the pages", async () => {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const out = join(mkdtempSync(join(tmpdir(), "css-")), "app.css");
  execFileSync("npx", ["tailwindcss", "-i", "src/app.css", "-o", out, "--minify"], { cwd: join(import.meta.dirname, ".."), stdio: "pipe" });
  assert.equal(readFileSync(join(import.meta.dirname, "../assets/app.css"), "utf8"), readFileSync(out, "utf8"), "run `npm run css`");
});

test("the stylesheet and pictures are served to anyone, since the sign-in page needs them", async () => {
  const { handle } = app();
  const css = await handle(new Request("http://local/app.css"));
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type") ?? "", /text\/css/);
  assert.equal((await handle(new Request("http://local/mark-black.svg"))).status, 200);
});

// The menu's chat list scrolls by itself, so Settings stays at the foot, and
// holds only the recent ones. The rest are a click away.
test("the menu keeps the recent chats, and All lists every one", async () => {
  const { handle, store } = ready();
  for (let i = 1; i <= 35; i++) store.addChat(`chat number ${i}`);
  const menu = await (await handle(new Request("http://local/pieces", { headers: signedIn }))).text();
  assert.equal(menu.match(/href="\/chats\/c/g)?.length, 30);
  assert.match(menu, /<a href="\/chats"[^>]*>All<\/a>/);
  assert.match(menu, /<ul role="list" data-chats class="[^"]*overflow-y-auto/);

  const all = await (await handle(new Request("http://local/chats", { headers: signedIn }))).text();
  assert.match(all, />chat number 1</);
  assert.match(all, />chat number 35</);
});

// A piece that needs someone signed in sends them here. The page frames the
// browser; a session that is not this piece's, or has ended, is not shown.
test("the browser a piece opened is shown on its own page, to sign in", async () => {
  const { handle, store } = ready();
  store.seal("steel", "steel-key");
  store.addPiece({ id: "pa", name: "Bank", description: "", wants: [] });
  store.addPiece({ id: "pb", name: "Other", description: "", wants: [] });
  store.addBrowser({ handle: "babc123", piece: "pa", steel: "steel-1" });
  const seen = async (path: string) => handle(new Request(`http://local${path}`, { headers: signedIn }));

  const shown = await seen("/pieces/pa/browser/babc123");
  assert.equal(shown.status, 200);
  const html = await shown.text();
  assert.match(html, /<iframe title="Browser" src="https:\/\/api\.steel\.dev\/v1\/sessions\/steel-1\/player\?interactive=true&#38;showControls=true"/);
  assert.doesNotMatch(html, /steel-key/);

  assert.equal((await seen("/pieces/pb/browser/babc123")).status, 404);
  store.endBrowser("babc123");
  assert.equal((await seen("/pieces/pa/browser/babc123")).status, 404);
  assert.equal((await handle(new Request("http://local/pieces/pa/browser/babc123"))).status, 401, "and not to a stranger");
});

// Click the title, type, press Enter. Escape or clicking away leaves it be.
test("a chat's title can be changed from its page", async () => {
  const { handle, store } = ready();
  const chat = store.addChat("first words");
  const page = await (await handle(new Request(`http://local/chats/${chat}`, { headers: signedIn }))).text();
  assert.match(page, new RegExp(`<form method="post" action="/chats/${chat}/rename"[^>]*><h1>\\s*<input name="title" value="first words"`));

  const rename = (title: string) => handle(new Request(`http://local/chats/${chat}/rename`, { method: "POST", headers: signedIn, body: new URLSearchParams({ title }) }));
  assert.equal((await rename("  Monday   summary ")).status, 303);
  assert.equal(store.chat(chat)?.title, "Monday summary");
  await rename("   ");
  assert.equal(store.chat(chat)?.title, "Monday summary", "an empty title changes nothing");
  await rename("x".repeat(200));
  assert.equal(store.chat(chat)?.title.length, 60);
});

// An MCP server is added by address and token, asked what it can do before it
// is kept, and granted to a piece by ticking it. Its token is never shown.
test("a service is added, granted to a piece, and removed", async () => {
  const mcp = async (url: string, init: any) => {
    if (!url.includes("mcp.example.com")) return accepting(url, init);
    if (init.headers.authorization !== "Bearer tok-123") return new Response("no", { status: 401 });
    const body = JSON.parse(init.body);
    return Response.json({ jsonrpc: "2.0", id: body.id ?? 0, result: { tools: [] } });
  };
  const store = new Store(":memory:");
  for (const key of APP_KEYS) store.seal(key.name, "set");
  const handle = createApp({ store, secret: "let-me-in", kernel: fakeKernel(), reach: { http: mcp } });
  store.addPiece({ id: "pa", name: "Week", description: "", wants: [{ kind: "mcp", config: { catalog_keys: ["google_calendar"] } }] });
  const post = (path: string, fields: Record<string, string>) => handle(new Request(`http://local${path}`, { method: "POST", headers: signedIn, body: new URLSearchParams(fields) }));
  const fields = { name: "Calendar", key: "google_calendar", url: "https://mcp.example.com/mcp", token: "tok-123" };

  const bad = await post("/services", { ...fields, token: "wrong" });
  assert.equal(bad.status, 422);
  assert.match(await bad.text(), /did not accept its token/);
  assert.equal(store.services().length, 0, "one that does not answer is not kept");
  assert.equal((await post("/services", { ...fields, key: "Google Calendar" })).status, 422);
  assert.equal((await post("/services", { ...fields, url: "http://mcp.example.com/mcp" })).status, 422);

  assert.equal((await post("/services", fields)).headers.get("location"), "/services");
  assert.equal((await post("/services", fields)).status, 422, "a key is used once");

  const access = await (await handle(new Request("http://local/pieces/pa/access", { headers: signedIn }))).text();
  assert.match(access, /<ul data-wants[^>]*><li[^>]*>google_calendar<\/li>/, "the piece asks for it by key");
  assert.match(access, /name="service" value="google_calendar"\s*> Calendar/);
  await post("/pieces/pa/grant", { kind: "mcp", service: "google_calendar" });
  assert.deepEqual(store.granted("pa", "mcp"), { services: ["google_calendar"] });

  const listed = await (await handle(new Request("http://local/services", { headers: signedIn }))).text();
  assert.match(listed, /<li data-service="google_calendar"[\s\S]*?mcp\.example\.com[\s\S]*?>Week<\/a>/);
  assert.doesNotMatch(listed, /tok-123/);

  await post("/services/google_calendar/remove", {});
  assert.equal(store.services().length, 0);
  assert.deepEqual(store.granted("pa", "mcp"), { services: [] });
});

// Linear is in the list of what is ready: one click sends you there to sign
// in, and coming back with its code connects it. A callback nobody started
// connects nothing.
test("a service from the list is connected by signing in to it", async () => {
  const http = async (url: string, init: any = {}) => {
    if (url === "https://mcp.linear.app/mcp") {
      if (init.headers?.authorization !== "Bearer access-1") return new Response("no", { status: 401 });
      return Response.json({ jsonrpc: "2.0", id: JSON.parse(init.body).id ?? 0, result: { tools: [] } });
    }
    if (url.includes("oauth-protected-resource")) return Response.json({ authorization_servers: ["https://mcp.linear.app"] });
    if (url.endsWith("/.well-known/oauth-authorization-server")) return Response.json({ authorization_endpoint: "https://mcp.linear.app/authorize", token_endpoint: "https://mcp.linear.app/token", registration_endpoint: "https://mcp.linear.app/register" });
    if (url.endsWith("/register")) return Response.json({ client_id: "made" });
    if (url.endsWith("/token")) return new URLSearchParams(init.body).get("code") === "good" ? Response.json({ access_token: "access-1", refresh_token: "r" }) : new Response("{}", { status: 400 });
    return accepting(url, init);
  };
  const store = new Store(":memory:");
  for (const key of APP_KEYS) store.seal(key.name, "set");
  const handle = createApp({ store, secret: "let-me-in", kernel: fakeKernel(), origin: "http://127.0.0.1:4010", reach: { http, resolve: async () => ["93.184.216.34"] } });
  const get = (path: string) => handle(new Request(`http://local${path}`, { headers: signedIn }));

  const listed = await (await get("/services")).text();
  assert.match(listed, /<li data-ready="linear"[\s\S]*?<button[^>]*>Connect<\/button>/);
  assert.match(listed, /<li data-ready="github"[\s\S]*?placeholder="Personal access token"/);

  const sent = await handle(new Request("http://local/services/connect", { method: "POST", headers: signedIn, body: new URLSearchParams({ catalog: "linear" }) }));
  assert.equal(sent.status, 303);
  const to = new URL(sent.headers.get("location")!);
  assert.equal(to.origin, "https://mcp.linear.app");
  assert.equal(to.searchParams.get("redirect_uri"), "http://127.0.0.1:4010/services/callback");

  assert.equal((await get("/services/callback?code=good&state=made-up")).status, 422);
  assert.equal(store.services().length, 0);

  const back = await get(`/services/callback?code=good&state=${to.searchParams.get("state")}`);
  assert.equal(back.headers.get("location"), "/services");
  assert.equal(store.service("linear")?.url, "https://mcp.linear.app/mcp");
  assert.equal((await get(`/services/callback?code=good&state=${to.searchParams.get("state")}`)).status, 422, "a state is good once");
  assert.doesNotMatch(await (await get("/services")).text(), /data-ready="linear"|access-1/);
});

// Which key is saved can be told at a glance; the key itself cannot be read.
test("a saved key shows its first six and last four, and never the middle", async () => {
  const { handle, store } = app();
  store.seal("openrouter", "sk-or-v1-0123456789abcdefSECRETMIDDLE9f2c");
  store.seal("steel", "ste-short");
  const page = await (await handle(new Request("http://local/services", { headers: signedIn }))).text();
  assert.match(page, /placeholder="sk-or-…9f2c · Saved and working"/);
  assert.match(page, /placeholder="Saved and working"/, "a short key shows nothing of itself");
  assert.doesNotMatch(page, /SECRETMIDDLE|ste-short/);
});
