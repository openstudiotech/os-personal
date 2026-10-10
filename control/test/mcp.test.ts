import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { answerMcp, TOOLS } from "../src/mcp.ts";
import { COUNTER, fakeKernel } from "./support.ts";

function world(replies: Record<string, { status: number; body: unknown }> = {}) {
  const store = new Store(":memory:");
  store.addPiece({ id: "pa", name: "Counter", description: "Counts", wants: [] });
  const kernel = fakeKernel(replies);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const reply: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return { failed: reply.result?.isError === true, said: JSON.parse(reply.result.content[0].text), text: reply.result.content[0].text };
  };
  return { store, kernel, call };
}

test("it introduces itself and lists what it can do", async () => {
  const { store, kernel } = world();
  const hello: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  assert.equal(hello.result.protocolVersion, "2025-06-18");
  assert.ok(hello.result.capabilities.tools);

  assert.equal(await answerMcp({ store, kernel }, { jsonrpc: "2.0", method: "notifications/initialized" }), null);

  const listed: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 2, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((tool: any) => tool.name).sort(),
    ["call_piece", "create_piece", "list_pieces", "list_services", "read_guide", "read_logs", "read_piece", "read_state", "run_tests", "write_piece_files"]);
});

// What a piece may reach is the owner's to decide, in the browser. A client
// that writes code must not be able to hand that code its own permissions.
test("nothing here grants reach, shows a key, or runs on a timer", () => {
  for (const tool of TOOLS) assert.doesNotMatch(tool.name + " " + JSON.stringify(tool.inputSchema), /grant|revoke|key|secret|schedule/i, tool.name);
});

test("pieces are listed, and found by name or id", async () => {
  const { call } = world({ "GET files": { status: 200, body: { files: { "piece.js": COUNTER, "logo.png": "iVBORw0KGgo=" }, version: 3 } } });
  assert.deepEqual((await call("list_pieces")).said, [{ id: "pa", name: "Counter", description: "Counts" }]);

  const byName = await call("read_piece", { piece: "counter" });
  assert.match(byName.said.files["piece.js"], /viewCount/);
  assert.equal(byName.said.files["logo.png"], "(a picture; not shown)");
  assert.equal((await call("read_piece", { piece: "pa" })).said.id, "pa");
  assert.equal((await call("read_piece", { piece: "nope" })).failed, true);
});

test("a change is merged onto what is there, and can delete", async () => {
  const { call, kernel } = world({ "PUT files": { status: 200, body: { ok: true, codeVersion: 4, tests: null } } });

  const done = await call("write_piece_files", { piece: "Counter", files: { "piece.js": COUNTER }, delete: ["old.js"] });

  assert.equal(done.said.codeVersion, 4);
  assert.deepEqual(kernel.calls.at(-1)!.body, { files: { "piece.js": COUNTER }, mode: "merge", delete: ["old.js"] });
});

test("a change that will not load says so, and that the old version is back", async () => {
  const { call } = world({ "PUT files": { status: 422, body: { ok: false, codeVersion: 5, loadError: "SyntaxError: nope", reverted: { codeVersion: 6, restoredFrom: 4 } } } });

  const done = await call("write_piece_files", { piece: "Counter", files: { "piece.js": "broken" } });

  assert.equal(done.failed, true);
  assert.match(done.text, /SyntaxError: nope/);
  assert.match(done.text, /send your whole change again/);
});

test("a new piece is made with nothing granted, and not kept if it will not deploy", async () => {
  const made = world({ "PUT files": { status: 200, body: { ok: true, codeVersion: 1 } } });
  const done = await made.call("create_piece", { name: "Tally", description: "Counts things", files: { "piece.js": COUNTER } });
  const kept = made.store.pieces().find((piece) => piece.name === "Tally")!;
  assert.equal(done.said.id, kept.id);
  assert.deepEqual(made.kernel.calls.find((c) => c.route === "files")!.body, { files: { "piece.js": COUNTER } });
  for (const kind of ["web", "search", "llm", "link"]) assert.equal(made.store.granted(kept.id, kind), null);
  assert.match(done.text, /granted nothing/);

  const refused = world({ "PUT files": { status: 422, body: { error: "piece.js must `export default class extends Piece`" } } });
  assert.equal((await refused.call("create_piece", { name: "Bad", files: { "piece.js": "x" } })).failed, true);
  assert.equal(refused.store.pieces().length, 1);
  assert.ok(refused.kernel.calls.some((c) => c.method === "DELETE"));
});

test("a piece can be called, tested, and its state and logs read", async () => {
  const { call, kernel } = world({
    "POST rpc/add": { status: 200, body: { result: 3 } },
    "POST tests": { status: 200, body: { tests: { total: 1, passed: 1, failed: 0, results: [] } } },
    "GET state": { status: 200, body: { state: { count: 3 } } },
    "GET logs": { status: 200, body: { lines: [
      "2026-10-10T16:40:41.122Z page error: An old one (client.js:5)",
      "2026-10-10T16:41:03.115Z info deployed codeVersion=2 (5 files, merge)",
      "2026-10-10T16:41:46.085Z info connect user=operator role=owner",
      "2026-10-10T16:41:46.122Z page error: Uncaught TypeError: Cannot set properties of null (setting 'textContent') (client.js:5)",
    ] } },
  });
  assert.deepEqual((await call("call_piece", { piece: "Counter", method: "add", args: [3] })).said, { result: 3 });
  assert.deepEqual(kernel.calls.at(-1)!.body, { args: [3] });
  assert.equal((await call("run_tests", { piece: "Counter" })).said.tests.passed, 1);
  assert.deepEqual((await call("read_state", { piece: "Counter" })).said, { count: 3 });
  assert.equal((await call("read_logs", { piece: "Counter" })).said.length, 4);
  assert.deepEqual((await call("read_piece", { piece: "Counter" })).said.page_errors,
    ["2026-10-10T16:41:46.122Z page error: Uncaught TypeError: Cannot set properties of null (setting 'textContent') (client.js:5)"], "what went wrong in its page since the last deploy comes with the piece");
});

test("the guide comes back, and an unknown tool or method is an error, not a crash", async () => {
  const { call, store, kernel } = world();
  const guide: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_guide", arguments: {} } });
  assert.match(guide.result.content[0].text, /Writing a piece/);

  const unknownTool: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "grant_everything", arguments: {} } });
  assert.equal(unknownTool.result.isError, true);
  const unknownMethod: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 3, method: "resources/list" });
  assert.equal(unknownMethod.error.code, -32601);
});
