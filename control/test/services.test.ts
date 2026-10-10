import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { answerEffect } from "../src/effects.ts";
import { serviceAddress } from "../src/services.ts";
import { fakeKernel } from "./support.ts";

// A piece, a calendar service, and an MCP server that answers as one does.
function world({ stream = false, refuse = 0 } = {}) {
  const store = new Store(":memory:");
  store.addPiece({ id: "pa", name: "Week", description: "", wants: [] });
  store.addService({ key: "google_calendar", name: "Calendar", url: "https://mcp.example.com/mcp" });
  store.seal("service:google_calendar", "tok-123");
  const asked: Array<{ url: string; init: any; body: any }> = [];
  const deps = {
    store, kernel: fakeKernel(),
    http: async (url: string, init: any) => {
      const body = JSON.parse(init.body);
      asked.push({ url, init, body });
      if (refuse) return new Response("your token tok-123 is bad", { status: refuse });
      const result = body.method === "initialize" ? { protocolVersion: "2025-03-26" }
        : body.method === "tools/list" ? { tools: [{ name: "list_events", description: "Events", inputSchema: { type: "object" } }] }
          : body.params?.name === "broken" ? { isError: true, content: [{ type: "text", text: "no such calendar" }] }
            : { content: [{ type: "text", text: '{"events":2}' }] };
      if (body.id === undefined) return new Response(null, { status: 202 });
      const message = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      return stream
        ? new Response(`event: message\ndata: ${message}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } })
        : new Response(message, { headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
    },
  };
  const call = (tool: string, args?: unknown, server = "google_calendar") => answerEffect(deps, "pa", { kind: "mcp", server, tool, args });
  return { store, asked, deps, call };
}

test("a piece uses a service only once it is granted, by its key", async () => {
  const { store, asked, call } = world();
  assert.match((await call("list_events")).error, /google_calendar is not granted/);
  assert.equal(asked.length, 0);

  store.grant("pa", "mcp", { services: ["google_calendar"] });
  assert.deepEqual(await call("list_events", { week: 1 }), { result: '{"events":2}' });
  assert.deepEqual(asked.map((each) => each.body.method), ["initialize", "notifications/initialized", "tools/call"]);
  const called = asked.at(-1)!;
  assert.equal(called.init.headers.authorization, "Bearer tok-123");
  assert.equal(called.init.headers["mcp-session-id"], "s1");
  assert.deepEqual(called.body.params, { name: "list_events", arguments: { week: 1 } });

  assert.match((await call("list_events", {}, "notion")).error, /notion is not granted/);
});

test("it can ask what a service does, and a tool that fails says so", async () => {
  const { store, call } = world({ stream: true });
  store.grant("pa", "mcp", { services: ["google_calendar"] });
  assert.deepEqual(await call("__describe"), { result: { server: "google_calendar", tools: [{ name: "list_events", description: "Events", inputSchema: { type: "object" } }] } });
  assert.deepEqual(await call("broken"), { error: "no such calendar" });
});

test("what a service says when it refuses is not passed on", async () => {
  const { store, call } = world({ refuse: 401 });
  store.grant("pa", "mcp", { services: ["google_calendar"] });
  const reply = await call("list_events");
  assert.equal(reply.error, "google_calendar did not accept its token");
});

test("a service that has been removed is gone for the piece too", async () => {
  const { store, call } = world();
  store.grant("pa", "mcp", { services: ["google_calendar"] });
  store.removeService("google_calendar");
  assert.match((await call("list_events")).error, /not granted/);
  assert.equal(store.has("service:google_calendar"), false, "and its token is not kept");
});

test("a service lives at an https address, or on this machine", () => {
  assert.ok(serviceAddress("https://mcp.example.com/mcp"));
  assert.ok(serviceAddress("http://127.0.0.1:9000/mcp"));
  assert.ok(serviceAddress("http://localhost:9000/mcp"));
  assert.equal(serviceAddress("http://mcp.example.com/mcp"), null);
  assert.equal(serviceAddress("file:///etc/passwd"), null);
  assert.equal(serviceAddress("nonsense"), null);
});
