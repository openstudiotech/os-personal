import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { answerEffect } from "../src/effects.ts";
import { liveView, releaseAll, type Page } from "../src/browser.ts";
import { fakeKernel } from "./support.ts";

// A piece, a Steel that answers, and a page that records what it was told and
// says it is wherever `at` says.
function world({ hosts = ["bank.example.com"] as string[] | null, at = "https://bank.example.com/home" } = {}) {
  const store = new Store(":memory:");
  store.addPiece({ id: "pa", name: "Reader", description: "", wants: [] });
  store.addPiece({ id: "pb", name: "Other", description: "", wants: [] });
  store.seal("steel", "steel-key");
  if (hosts) store.grant("pa", "web", { hosts });
  const asked: Array<{ url: string; init: any }> = [];
  const told: Array<{ method: string; params: any }> = [];
  const opened: string[] = [];
  const here = { at, html: "<html><title>Home</title><body><script>x()</script><p>Balance 42</p></body></html>", missing: false };
  const page: Page = {
    async send(method, params: any = {}) {
      told.push({ method, params });
      if (method === "Page.navigate") { here.at = params.url; return {}; }
      if (method !== "Runtime.evaluate") return {};
      const code = String(params.expression);
      if (code.includes("location.href")) return { result: { value: { url: here.at, title: "Home" } } };
      if (code.includes("outerHTML")) return { result: { value: here.html } };
      return { result: { value: here.missing ? null : { x: 10, y: 20 } } };
    },
    wait: async () => {},
    close() {},
  };
  const deps = {
    store,
    kernel: fakeKernel(),
    http: async (url: string, init: any) => {
      asked.push({ url, init });
      if (url.endsWith("/v1/sessions") && init.method === "POST") return Response.json({ id: "steel-1" });
      if (url.endsWith("/release")) return Response.json({ ok: true });
      return Response.json({ id: "steel-1", debugUrl: "https://api.steel.dev/v1/sessions/steel-1/player" });
    },
    resolve: async () => ["93.184.216.34"],
    browser: async (address: string) => { opened.push(address); return page; },
    origin: "http://127.0.0.1:4010",
  };
  const start = async () => (await answerEffect(deps, "pa", { kind: "browser_session" })).session as string;
  return { store, asked, told, opened, here, deps, start };
}

test("a session needs the web granted, and is the piece's own", async () => {
  const none = world({ hosts: null });
  assert.match((await answerEffect(none.deps, "pa", { kind: "browser_session" })).error, /not granted/);
  assert.equal(none.asked.length, 0);

  const { deps, asked, start } = world();
  const session = await start();
  assert.match(session, /^b[a-f0-9]{16,}$/);
  assert.equal(asked[0].init.headers["steel-api-key"], "steel-key");
  assert.notEqual(session, "steel-1", "the piece never sees the service's own id");

  deps.store.grant("pb", "web", { hosts: ["*"] });
  assert.match((await answerEffect(deps, "pb", { kind: "browser_read", session })).error, /no such browser session/);
});

test("it goes only where the piece may go, and says where it landed", async () => {
  const { deps, told, opened, start } = world();
  const session = await start();
  assert.match((await answerEffect(deps, "pa", { kind: "browser_goto", session, url: "https://elsewhere.example.org/" })).error, /not granted/);
  assert.match((await answerEffect(deps, "pa", { kind: "browser_goto", session, url: "http://bank.example.com/" })).error, /https/);
  assert.equal(told.length, 0);

  const landed = await answerEffect(deps, "pa", { kind: "browser_goto", session, url: "https://bank.example.com/login" });
  assert.deepEqual(landed, { url: "https://bank.example.com/login", title: "Home" });
  assert.match(opened[0], /sessionId=steel-1/);
});

test("a page that has wandered off the granted hosts is neither read nor acted on", async () => {
  const { deps, here, start } = world();
  const session = await start();
  here.at = "https://evil.example.net/phish";
  assert.match((await answerEffect(deps, "pa", { kind: "browser_read", session })).error, /evil\.example\.net.*not granted/);
  assert.match((await answerEffect(deps, "pa", { kind: "browser_act", session, browser_action: { type: "click", selector: "a" } })).error, /not granted/);
});

test("reading gives the words on the page, or its HTML when asked", async () => {
  const { deps, start } = world();
  const session = await start();
  const read = await answerEffect(deps, "pa", { kind: "browser_read", session });
  assert.equal(read.url, "https://bank.example.com/home");
  assert.match(read.content, /Balance 42/);
  assert.doesNotMatch(read.content, /x\(\)|<p>/);
  assert.match((await answerEffect(deps, "pa", { kind: "browser_read", session, content_format: "html" })).content, /<p>Balance 42<\/p>/);
});

test("it clicks, types, presses and selects, and refuses what it does not know", async () => {
  const { deps, told, here, start } = world();
  const session = await start();
  const act = (browser_action: unknown) => answerEffect(deps, "pa", { kind: "browser_act", session, browser_action });

  assert.deepEqual(await act({ type: "click", selector: "#go" }), { acted: "click", url_before: "https://bank.example.com/home", url: "https://bank.example.com/home" });
  assert.deepEqual(told.filter((each) => each.method === "Input.dispatchMouseEvent").map((each) => [each.params.type, each.params.x, each.params.y]),
    [["mousePressed", 10, 20], ["mouseReleased", 10, 20]]);

  await act({ type: "fill", selector: "#name", text: "Ada" });
  assert.deepEqual(told.find((each) => each.method === "Input.insertText")?.params, { text: "Ada" });

  await act({ type: "press", key: "Enter" });
  assert.deepEqual(told.filter((each) => each.method === "Input.dispatchKeyEvent").map((each) => [each.params.type, each.params.key]), [["keyDown", "Enter"], ["keyUp", "Enter"]]);

  assert.equal((await act({ type: "select", selector: "#month", value: "May" })).acted, "select");

  assert.match((await act({ type: "hover", selector: "a" })).error, /unknown action hover/);
  assert.match((await act({ type: "click" })).error, /selector/);
  assert.match((await act({ type: "type", selector: "#name" })).error, /text/);
  assert.match((await act({ type: "press", key: "F13" })).error, /press knows/);
  here.missing = true;
  assert.match((await act({ type: "click", selector: "#gone" })).error, /no element matches #gone/);
});

test("the live view is a page of this app, and never carries the key", async () => {
  const { deps, start } = world();
  const session = await start();
  const view = await answerEffect(deps, "pa", { kind: "browser_live_view", session });
  assert.equal(view.login_url, `http://127.0.0.1:4010/pieces/pa/browser/${session}`);
  assert.ok(view.expires_in_minutes <= 10 && view.expires_in_minutes >= 9);

  const frame = await liveView(deps, "pa", session);
  assert.equal(frame, "https://api.steel.dev/v1/sessions/steel-1/player?interactive=true&showControls=true");
  assert.equal(await liveView(deps, "pb", session), null, "another piece's page cannot show it");
});

test("a session ends when released, after ten minutes, and when its piece goes", async () => {
  const { deps, asked, store, start } = world();
  const first = await start();
  assert.deepEqual(await answerEffect(deps, "pa", { kind: "browser_session", session: first, release: true }), { session: first, status: "released" });
  assert.match(asked.at(-1)!.url, /steel-1\/release$/);
  assert.match((await answerEffect(deps, "pa", { kind: "browser_read", session: first })).error, /already released/);

  const second = await start();
  (store as any).db.prepare("UPDATE browsers SET at = ? WHERE handle = ?").run(Date.now() - 11 * 60_000, second);
  assert.match((await answerEffect(deps, "pa", { kind: "browser_read", session: second })).error, /expired/);

  await start(); await start();
  assert.match((await answerEffect(deps, "pa", { kind: "browser_session" })).error, /two browser sessions/);
  assert.equal(await releaseAll(deps, "pa"), 2);
  assert.equal(store.liveBrowsers("pa").length, 0);
});
