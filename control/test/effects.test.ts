import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { answerEffect } from "../src/effects.ts";
import { fakeKernel } from "./support.ts";

// A piece, a web that answers, and an address book that says where hosts live.
function world(over: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  store.addPiece({ id: "pa", name: "Reader", description: "", wants: [] });
  store.addPiece({ id: "pb", name: "Other", description: "", wants: [] });
  store.seal("openrouter", "sk-or-test");
  const asked: Array<{ url: string; init: any }> = [];
  const deps = {
    store,
    kernel: fakeKernel({ "POST rpc/viewX": { status: 200, body: { result: 9 } } }),
    http: async (url: string, init: any) => {
      asked.push({ url, init });
      if (url.includes("openrouter.ai")) return Response.json({ choices: [{ message: { content: "a summary" } }] });
      if (url.includes("/moved")) return new Response(null, { status: 302, headers: { location: "https://evil.test/" } });
      return new Response('{"ok":true}', { status: 200 });
    },
    resolve: async (host: string) => (host === "inside.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]),
    ...over,
  };
  return { store, asked, deps };
}

test("a piece told to use the browser without a Steel key is told the key is missing", async () => {
  const { deps, store, asked } = world();
  store.grant("pa", "web", { hosts: ["example.com"] });
  const shot = await answerEffect(deps, "pa", { kind: "browser_screenshot", url: "https://example.com/" });
  assert.match(String(shot.error), /no Steel key here.*added under Services/);
  assert.equal(asked.length, 0, "nothing was sent anywhere");
});

test("a piece with no grant reaches nothing", async () => {
  const { deps, asked } = world();
  for (const payload of [
    { kind: "fetch", url: "https://example.com/a", method: "GET" },
    { kind: "llm", prompt: "hi", system: null },
    { kind: "cell_link", target: "Other", method: "viewX", args: [], chain: [] },
  ]) {
    const reply = await answerEffect(deps, "pa", payload);
    assert.match(reply.error, /not granted/, payload.kind);
  }
  assert.equal(asked.length, 0);
});

test("fetch reaches a granted host, and only that", async () => {
  const { store, deps, asked } = world();
  store.grant("pa", "web", { hosts: ["example.com", "*.example.org"] });

  const ok = await answerEffect(deps, "pa", { kind: "fetch", url: "https://example.com/a?b=1", method: "GET" });
  assert.deepEqual(ok, { status: 200, body: '{"ok":true}', json: { ok: true } });
  assert.equal(asked[0].init.redirect, "manual");

  assert.equal((await answerEffect(deps, "pa", { kind: "fetch", url: "https://api.example.org/x", method: "GET" })).status, 200);
  for (const url of ["https://other.com/", "https://example.com.evil.test/", "https://notexample.org/"]) {
    assert.match((await answerEffect(deps, "pa", { kind: "fetch", url, method: "GET" })).error, /not granted/, url);
  }
});

test("fetch refuses what could reach inside, or change something", async () => {
  const { store, deps, asked } = world();
  store.grant("pa", "web", { hosts: ["*"] });
  const refused: Array<[Record<string, unknown>, RegExp]> = [
    [{ url: "http://example.com/", method: "GET" }, /https/],
    [{ url: "https://example.com/", method: "POST" }, /GET/],
    [{ url: "https://inside.example.com/", method: "GET" }, /private/],
    [{ url: "https://127.0.0.1/", method: "GET" }, /private/],
    [{ url: "not a url", method: "GET" }, /address/],
  ];
  for (const [fields, message] of refused) {
    assert.match((await answerEffect(deps, "pa", { kind: "fetch", ...fields })).error, message, JSON.stringify(fields));
  }
  assert.equal(asked.length, 0);

  // A redirect is reported, never followed.
  const moved = await answerEffect(deps, "pa", { kind: "fetch", url: "https://example.com/moved", method: "GET" });
  assert.equal(moved.status, 302);
  assert.equal(asked.length, 1);
});

test("the model is asked with the operator's key, which never comes back", async () => {
  const { store, deps, asked } = world();
  store.grant("pa", "llm", {});

  const reply = await answerEffect(deps, "pa", { kind: "llm", prompt: "Summarise this", system: "Be brief" });

  assert.deepEqual(reply, { text: "a summary" });
  assert.equal(asked[0].init.headers.authorization, "Bearer sk-or-test");
  assert.deepEqual(JSON.parse(asked[0].init.body).messages, [{ role: "system", content: "Be brief" }, { role: "user", content: "Summarise this" }]);
  assert.doesNotMatch(JSON.stringify(reply), /sk-or-test/);
});

test("one piece calls another it was granted, by name, and the chain grows", async () => {
  const { store, deps } = world();
  store.grant("pa", "link", { pieces: ["pb"] });

  const reply = await answerEffect(deps, "pa", { kind: "cell_link", target: "other", method: "viewX", args: [1], chain: ["pz"], invoker: "operator" });

  assert.deepEqual(reply, { result: 9 });
  const call = deps.kernel.calls.at(-1)!;
  assert.equal(call.piece, "pb");
  assert.deepEqual(call.body, { args: [1], chain: ["pz", "pa"], user: "operator" });
});

test("a call that would loop, or has gone too deep, is refused", async () => {
  const { store, deps } = world();
  store.grant("pa", "link", { pieces: ["pb"] });

  assert.match((await answerEffect(deps, "pa", { kind: "cell_link", target: "Other", method: "viewX", args: [], chain: ["pb"] })).error, /loop/);
  const deep = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
  assert.match((await answerEffect(deps, "pa", { kind: "cell_link", target: "Other", method: "viewX", args: [], chain: deep })).error, /deep/);
  assert.match((await answerEffect(deps, "pa", { kind: "cell_link", target: "Nobody", method: "viewX", args: [], chain: [] })).error, /not granted/);
  assert.equal(deps.kernel.calls.length, 0);
});

test("what this version does not do yet says so, as an object", async () => {
  const { deps } = world();
  for (const kind of ["save", "preview", "mcp", "browser_session", "browser_goto", "notify", "something_new"]) {
    const reply = await answerEffect(deps, "pa", { kind });
    assert.equal(typeof reply.error, "string", kind);
  }
  assert.match((await answerEffect(deps, "missing", { kind: "llm", prompt: "x" })).error, /unknown piece/);
});

// The outside services, as they answer.
function services(asked: Array<{ url: string; init: any }>) {
  return async (url: string, init: any) => {
    asked.push({ url, init });
    if (url.includes("openrouter.ai")) return Response.json({ choices: [{ message: { content: "", annotations: [
      { type: "url_citation", url_citation: { title: "A page", url: "https://a.example/p", content: "About it. ".repeat(100) } },
    ] } }] });
    if (url === "https://example.com/a") return new Response("<html><head><title>Hello &amp; welcome</title><style>p { color: red }</style></head><body><h1>Hello</h1><p>Tea &amp; <b>toast</b>.</p><script>alert(1)</script></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url === "https://example.com/old") return new Response(null, { status: 301, headers: { location: "/a" } });
    if (url === "https://example.com/a.png") return new Response("PNG", { headers: { "content-type": "image/png" } });
    if (url.includes("steel") && url.endsWith("/v1/scrape")) return Response.json({ content: { markdown: "# From a browser" }, metadata: { title: "Browsed" } });
    if (url.endsWith("/v1/screenshot")) return Response.json({ url: "https://images.steel.test/shot.png" });
    return new Response("nope", { status: 500 });
  };
}

test("search needs its own grant, and goes out through OpenRouter on the model's key", async () => {
  const asked: Array<{ url: string; init: any }> = [];
  const { deps, store } = world({ http: services(asked) });

  assert.match((await answerEffect(deps, "pa", { kind: "search", query: "news" })).error, /not granted/);

  store.grant("pa", "search", {});
  const reply = await answerEffect(deps, "pa", { kind: "search", query: "news", since: "week" });
  assert.deepEqual(reply, { results: [{ title: "A page", url: "https://a.example/p", snippet: "About it. ".repeat(50) }], since: "week" });
  assert.equal(asked[0].init.headers.authorization, "Bearer sk-or-test");
  const sent = JSON.parse(asked[0].init.body);
  assert.deepEqual(sent.plugins, [{ id: "web", engine: "exa", max_results: 8 }]);
  assert.equal(sent.messages[0].content, "news (from the past week)");
  assert.deepEqual(sent.provider, { data_collection: "deny" });

  assert.match((await answerEffect(deps, "pa", { kind: "search", query: "news", since: "century" })).error, /day, week or month/);
});

test("reading a page, in either way, keeps to the granted hosts", async () => {
  const asked: Array<{ url: string; init: any }> = [];
  const { store, deps } = world({ http: services(asked) });
  store.seal("steel", "ste-test");
  store.grant("pa", "web", { hosts: ["example.com"] });

  assert.deepEqual(await answerEffect(deps, "pa", { kind: "extract", url: "https://example.com/a" }), { markdown: "Hello\nTea & toast .", title: "Hello & welcome" });
  assert.equal(asked[0].init.redirect, "manual");
  assert.deepEqual(await answerEffect(deps, "pa", { kind: "extract", url: "https://example.com/old" }), { error: "that page has moved to https://example.com/a" });
  assert.match((await answerEffect(deps, "pa", { kind: "extract", url: "https://example.com/a.png" })).error, /not a page of text/);
  assert.match((await answerEffect(deps, "pa", { kind: "extract", url: "https://example.com/gone" })).error, /failed \(500\)/);

  asked.length = 0;
  assert.deepEqual(await answerEffect(deps, "pa", { kind: "browser_scrape", url: "https://example.com/a", content_format: null }),
    { content: "# From a browser", title: "Browsed", url: "https://example.com/a" });
  assert.equal(asked[0].init.headers["steel-api-key"], "ste-test");
  assert.deepEqual(await answerEffect(deps, "pa", { kind: "browser_screenshot", url: "https://example.com/a", full_page: true }),
    { image_url: "https://images.steel.test/shot.png", url: "https://example.com/a" });

  const before = asked.length;
  for (const kind of ["extract", "browser_scrape", "browser_screenshot"]) {
    assert.match((await answerEffect(deps, "pa", { kind, url: "https://elsewhere.test/" })).error, /not granted/, kind);
    assert.match((await answerEffect(deps, "pa", { kind, url: "https://inside.example.com/" })).error, /not granted|private/, kind);
  }
  assert.equal(asked.length, before, "a refused address is never sent to the service");
});

test("a service that fails says so without giving anything away", async () => {
  const { store, deps } = world({ http: async () => Response.json({ error: "Invalid token sk-or-test" }, { status: 401 }) });
  store.grant("pa", "search", {});

  const reply = await answerEffect(deps, "pa", { kind: "search", query: "news" });
  assert.match(reply.error, /search/);
  assert.doesNotMatch(JSON.stringify(reply), /sk-or-test/);
});
