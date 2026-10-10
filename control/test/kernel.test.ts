// Against a running kernel (see README: `npm run kernel`). The control plane
// signs as the kernel expects, so these are the proof the two agree.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { KernelClient } from "../src/kernel.ts";
import { Store } from "../src/store.ts";
import { loadPiece } from "../src/pieces.ts";
import { makeZip, manifest } from "./support.ts";
import { createApp } from "../src/server.ts";
import { listen } from "../src/listen.ts";

const URL_ = process.env.KERNEL_URL ?? "http://127.0.0.1:28181";
const SECRET = process.env.KERNEL_SECRET ?? "dev-secret-change-me";
const kernel = new KernelClient({ url: URL_, secret: SECRET });
const PIECE = `c${Date.now().toString(36)}`;

const COUNTER = `
import { Piece } from "./costa.js";
export default class extends Piece {
  viewCount(state) { return { result: state?.count ?? 0 }; }
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { ...state, count }, result: count };
  }
}`;

before(async () => {
  assert.ok(await kernel.healthy(), `no kernel at ${URL_}; start it with \`npm run kernel\``);
});

test("a wrong secret is refused", async () => {
  const stranger = new KernelClient({ url: URL_, secret: "not-the-secret" });
  const reply = await stranger.request("GET", PIECE, "state");
  assert.equal(reply.status, 401);
});

test("deploys a piece, calls it, and reads its state back", async () => {
  const deployed = await kernel.putFiles(PIECE, { "piece.js": COUNTER });
  assert.equal(deployed.status, 200);

  const called = await kernel.call(PIECE, "add", [2]);
  assert.equal(called.status, 200);
  assert.equal(called.body.result, 2);

  const state = await kernel.request("GET", PIECE, "state");
  assert.equal(state.body.state.count, 2);
});

test("a ticket it mints opens the piece's page", async () => {
  const ticket = kernel.ticket(PIECE, { minutes: 5 });
  const page = await fetch(kernel.pageUrl(PIECE, ticket));
  assert.equal(page.status, 200);

  const forged = await fetch(kernel.pageUrl(PIECE, ticket.replace(/.$/, (c) => (c === "0" ? "1" : "0"))));
  assert.equal(forged.status, 401);
});

test("removes a piece", async () => {
  const gone = await kernel.request("DELETE", PIECE, "");
  assert.equal(gone.status, 200);
});

test("a piece loaded from a zip runs, with its data put back", async () => {
  const store = new Store(":memory:");
  const piece = await loadPiece(makeZip({
    "manifest.yml": manifest({ data: true }),
    "files/piece.js": COUNTER,
    "data/state.json": JSON.stringify({ count: 40 }),
  }, { deflate: true }), { store, kernel });

  const called = await kernel.call(piece.id, "add", [2]);
  assert.equal(called.body.result, 42);
  assert.equal((await fetch(kernel.pageUrl(piece.id, kernel.ticket(piece.id, { minutes: 5 })))).status, 200);

  await kernel.request("DELETE", piece.id, "");
});

test("a piece the kernel refuses says why", async () => {
  const store = new Store(":memory:");
  await assert.rejects(
    loadPiece(makeZip({ "manifest.yml": manifest(), "files/piece.js": "export default { nope() {} }" }), { store, kernel }),
    /extends Piece/,
  );
  assert.equal(store.pieces().length, 0);
});

// The whole loop: a piece asks, the kernel calls back here, the grant decides,
// and the answer reaches the piece's continuation. Needs port 4010, since
// that is where the kernel is told the control plane lives. When the app
// itself is running there, this is skipped and not failed: GitHub runs it.
test("one piece reaches another through the control plane, once it is granted", async (t) => {
  const store = new Store(":memory:");
  const server = await listen(createApp({ store, secret: "s", kernel }), 4010, "127.0.0.1").catch((error) => {
    if (error.code !== "EADDRINUSE") throw error;
    return null;
  });
  if (!server) return t.skip("port 4010 is taken, most likely by the app itself");
  try {
    const asker = `
import { Piece } from "./costa.js";
export default class extends Piece {
  ask(state) { return { effect: { call: { cell: "Counter", method: "viewCount" }, then: "got" } }; }
  got(state, outcome) { return { state: { ...state, outcome }, result: outcome }; }
}`;
    const counter = await loadPiece(makeZip({
      "manifest.yml": manifest({ data: true }), "files/piece.js": COUNTER, "data/state.json": JSON.stringify({ count: 5 }),
    }), { store, kernel });
    const piece = await loadPiece(makeZip({ "manifest.yml": manifest({ name: "Asker" }), "files/piece.js": asker }), { store, kernel });

    await kernel.call(piece.id, "ask");
    const refused = (await kernel.request("GET", piece.id, "state")).body.state.outcome;
    assert.match(refused.error, /not granted/);

    store.grant(piece.id, "link", { pieces: [counter.id] });
    await kernel.call(piece.id, "ask");
    assert.deepEqual((await kernel.request("GET", piece.id, "state")).body.state.outcome, { result: 5 });

    await kernel.request("DELETE", piece.id, "");
    await kernel.request("DELETE", counter.id, "");
  } finally {
    server.close();
  }
});

test("a schedule is timed by the kernel once it is on, runs when asked, and is forgotten when off", async () => {
  const { setSchedule, runNow, timings, reconcile } = await import("../src/schedules.ts");
  const store = new Store(":memory:");
  const tasks = `
import { Piece } from "./costa.js";
export default class extends Piece {
  tick(state) { return { state: { ...state, ticks: (state?.ticks ?? 0) + 1 } }; }
}`;
  const piece = await loadPiece(makeZip({
    "manifest.yml": manifest({ name: "Ticker", connections: [{ kind: "schedule", config: { schedules: [
      { task: "tick", freq: "daily", hour: 8, minute: 0, time_zone: "America/Chicago" },
    ] } }] }),
    "files/piece.js": COUNTER, "files/tasks.js": tasks,
  }), { store, kernel });
  const [schedule] = store.schedules(piece.id);

  assert.equal((await timings({ kernel })).has(schedule.id), false, "off means the kernel has never heard of it");

  await setSchedule({ store, kernel }, schedule.id, true);
  const held = (await timings({ kernel })).get(schedule.id);
  assert.equal(held.task, "tick");
  assert.ok(held.nextAt > Date.now());

  const ran = await runNow({ store, kernel }, schedule.id);
  assert.equal(ran.status, 200);
  assert.equal((await kernel.request("GET", piece.id, "state")).body.state.ticks, 1);

  await reconcile({ store, kernel });
  assert.equal(store.schedule(schedule.id)?.enabled, true, "one the kernel holds is left on");

  await setSchedule({ store, kernel }, schedule.id, false);
  assert.equal((await timings({ kernel })).has(schedule.id), false);
  await kernel.request("DELETE", piece.id, "");
});

test("an AI client makes a piece, calls it, changes it, and is told when a change will not load", async () => {
  const { answerMcp } = await import("../src/mcp.ts");
  const store = new Store(":memory:");
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply: any = await answerMcp({ store, kernel }, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
    return { failed: reply.result.isError === true, text: reply.result.content[0].text };
  };

  const made = await tool("create_piece", { name: "Tally", files: { "piece.js": COUNTER } });
  assert.equal(made.failed, false);
  assert.match((await tool("call_piece", { piece: "Tally", method: "add", args: [2] })).text, /"result": 2/);

  const changed = await tool("write_piece_files", { piece: "Tally", files: {
    "piece.js": COUNTER.replace("viewCount(state)", "double(state) { const count = (state?.count ?? 0) * 2; return { state: { ...state, count }, result: count }; }\n  viewCount(state)"),
  } });
  assert.equal(changed.failed, false);
  assert.match((await tool("call_piece", { piece: "Tally", method: "double" })).text, /"result": 4/);
  assert.match((await tool("read_piece", { piece: "Tally" })).text, /double/);
  assert.match((await tool("read_logs", { piece: "Tally" })).text, /info deployed codeVersion=2/, "the kernel's log lines reach the client");
  const paged = await tool("write_piece_files", { piece: "Tally", files: { "client.js": "document.body.textContent = 'hi';" } });
  assert.match(paged.text, /client\.js has not been run[\s\S]*read_logs/);

  const broken = await tool("write_piece_files", { piece: "Tally", files: { "piece.js": "export default class { syntax error" } });
  assert.equal(broken.failed, true);
  assert.match(broken.text, /put back/);
  assert.match((await tool("call_piece", { piece: "Tally", method: "double" })).text, /"result": 8/, "it still works, with its data");

  await kernel.request("DELETE", store.pieces()[0].id, "");
});
