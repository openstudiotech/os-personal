// Integration test against the local dev fleet (./dev.sh up first).
// Covers: service auth (accept + reject), org isolation, deploy validation,
// role enforcement, capnweb WebSocket sessions, logs, delete.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { newWebSocketRpcSession } from "capnweb";

const BASE = process.env.CELLS_KERNEL_TEST_URL ?? "http://127.0.0.1:18080";
const WS = BASE.replace(/^http/, "ws");
const SECRET = "dev-secret-change-me";
const enc = new TextEncoder();

async function hmacHex(message) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Mirrors the control plane's kernel client. extra: headers beyond the signed
// set (x-kernel-scope), which the signature does not cover.
async function kernel(method, org, cell, route, body, extra = {}) {
  const bytes = enc.encode(body === undefined ? "" : JSON.stringify(body));
  const path = `/${org}/pieces/${cell}/${route}`;
  const ts = Date.now();
  const sig = await hmacHex(`${ts}.${method}.${path}.${await sha256Hex(bytes)}`);
  const res = await fetch(`${BASE}/pieces/${cell}/${route}`, {
    method,
    headers: {
      "authorization": `Kernel v1.${ts}.${sig}`,
      "x-kernel-org": org,
      "content-type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function mintTicket(ticket) {
  const payload = btoa(JSON.stringify(ticket))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${payload}.${await hmacHex(payload)}`;
}

const CELL_JS = `
import { Piece } from "./costa.js";
export default class extends Piece {
  viewCount(state) { return { result: state?.count ?? 0 }; }
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { ...state, count }, result: count };
  }
  boom() { throw new Error("kaboom"); }
  stamp(state, at = Date.now(), label = "seen") {
    return { state: { ...state, at, label } };
  }
  async tryEgress(state) {
    try { await fetch("https://example.com"); return { result: "EGRESS ALLOWED" }; }
    catch { return { result: "egress denied" }; }
  }
}`;

const CELL = `t${Date.now().toString(36)}`;

before(async () => {
  const health = await fetch(`${BASE}/.well-known/celld/health`).catch(() => null);
  assert.ok(health?.ok, `no kernel at ${BASE}; start it first (see the README)`);
});

test("service auth: rejects missing/garbage/expired signatures", async () => {
  const bare = await fetch(`${BASE}/pieces/${CELL}/state`, { headers: { "x-kernel-org": "org1" } });
  assert.equal(bare.status, 401);
  const ts = Date.now() - 120_000; // outside window
  const stale = await fetch(`${BASE}/pieces/${CELL}/state`, {
    headers: {
      "authorization": `Kernel v1.${ts}.${"0".repeat(64)}`,
      "x-kernel-org": "org1",
    },
  });
  assert.equal(stale.status, 401);
});

test("deploy: validates the template contract", async () => {
  const bad = await kernel("PUT", "org1", CELL, "files", { files: { "piece.js": "export default { a(){} }" } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /extends Piece/);

  const broken = await kernel("PUT", "org1", CELL, "files", { files: { "piece.js": "export default class { syntax error" } });
  assert.equal(broken.status, 422);

  const good = await kernel("PUT", "org1", CELL, "files", { files: { "piece.js": CELL_JS } });
  assert.equal(good.status, 200);
  assert.ok(good.body.codeVersion >= 1);
});

test("deploy: piece.js imports the other files it ships", async () => {
  const cell = `${CELL}-modules`;
  const piece = `
import { Piece } from "./costa.js";
import { double } from "./math.js";
export default class extends Piece {
  twice(state, n) { return { result: double(n) }; }
}`;
  const missing = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": piece } });
  assert.equal(missing.status, 422);

  const good = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": piece, "math.js": "export function double(n) { return n * 2; }" },
  });
  assert.equal(good.status, 200);
  const twice = await kernel("POST", "org1", cell, "rpc/twice", { args: [21] });
  assert.equal(twice.body.result, 42);
  await kernel("DELETE", "org1", cell, "");
});

test("deploy merge: writes only the files sent, keeps the rest", async () => {
  const cell = `m${Date.now().toString(36)}`;
  const first = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}", "helper.js": "export const x = 1;" },
  });
  assert.equal(first.status, 200);

  const merged = await kernel("PUT", "org1", cell, "files", {
    files: { "client.js": "export function mount() { /* v2 */ }" },
    mode: "merge",
  });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.codeVersion, first.body.codeVersion + 1);

  const files = await kernel("GET", "org1", cell, "files");
  assert.deepEqual(Object.keys(files.body.files).sort(), ["client.js", "helper.js", "piece.js"]);
  assert.match(files.body.files["client.js"], /v2/);
  assert.equal(files.body.files["piece.js"], CELL_JS, "un-sent files are untouched");

  // The merged code is live, not just stored.
  const added = await kernel("POST", "org1", cell, "rpc/add", { args: [2] });
  assert.equal(added.body.result, 2);

  await kernel("DELETE", "org1", cell, "");
});

test("deploy merge: delete list removes files; unknown names no-op", async () => {
  const cell = `md${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}", "stale.js": "export const gone = 1;" },
  });

  const dropped = await kernel("PUT", "org1", cell, "files", {
    files: {}, mode: "merge", delete: ["stale.js", "never-existed.js"],
  });
  assert.equal(dropped.status, 200);

  const files = await kernel("GET", "org1", cell, "files");
  assert.deepEqual(Object.keys(files.body.files).sort(), ["client.js", "piece.js"]);

  await kernel("DELETE", "org1", cell, "");
});

test("deploy merge: validates the merged set, not just what was sent", async () => {
  const cell = `mv${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  // piece.js already stored, so a merge that omits it is fine...
  const ok = await kernel("PUT", "org1", cell, "files", {
    files: { "client.js": "export function mount() {}" }, mode: "merge",
  });
  assert.equal(ok.status, 200);

  // ...but deleting it out of the merged set is not.
  const orphaned = await kernel("PUT", "org1", cell, "files", {
    files: {}, mode: "merge", delete: ["piece.js"],
  });
  assert.equal(orphaned.status, 400);
  assert.match(orphaned.body.error, /piece\.js/);

  // A merge that replaces piece.js with a non-conforming one still fails the
  // template contract.
  const bad = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": "export default { a(){} }" }, mode: "merge",
  });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /extends Piece/);

  await kernel("DELETE", "org1", cell, "");
});

test("deploy merge: delete requires merge mode; merge on an empty cell creates", async () => {
  const cell = `me${Date.now().toString(36)}`;

  const misplaced = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS }, delete: ["x.js"],
  });
  assert.equal(misplaced.status, 400);
  assert.match(misplaced.body.error, /merge/);

  const badMode = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS }, mode: "patch" });
  assert.equal(badMode.status, 400);

  // No stored files yet: merge behaves as a create.
  const created = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS }, mode: "merge" });
  assert.equal(created.status, 200);
  assert.equal(created.body.codeVersion, 1);

  await kernel("DELETE", "org1", cell, "");
});

// DEPRECATED (cell.js -> piece.js, Cell -> Piece): the only place either old
// name is written. Drop it when the shim and the alias go.
// Every deploy leaves a manifest; a restore is a NEW version pointing back at
// an old one. The versions rolled past stay readable and restorable, so a
// rollback never loses a branch.
test("versions: every deploy is kept; restore is a new version, data untouched", async () => {
  const cell = `v${Date.now().toString(36)}`;
  const v1 = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}" },
  });
  assert.equal(v1.body.codeVersion, 1);
  const v2 = await kernel("PUT", "org1", cell, "files", {
    files: { "client.js": "// v2", "extra.js": "export const x = 2;" }, mode: "merge",
  });
  assert.equal(v2.body.codeVersion, 2);
  await kernel("POST", "org1", cell, "rpc/add", { args: [5] });

  const list = await kernel("GET", "org1", cell, "versions");
  assert.equal(list.status, 200);
  const [two, one] = list.body.versions;
  assert.deepEqual([two.version, one.version], [2, 1], "newest first");
  assert.deepEqual([one.parent, two.parent], [0, 1]);
  assert.equal(list.body.meta.codeVersion, 2);
  assert.equal(one.files["piece.js"].length, 64, "manifests carry digests, not content");
  assert.equal(two.files["piece.js"], one.files["piece.js"], "unchanged content is shared");
  assert.notEqual(two.files["client.js"], one.files["client.js"]);

  const shown = await kernel("GET", "org1", cell, "versions/1");
  assert.equal(shown.status, 200);
  assert.deepEqual(Object.keys(shown.body.files).sort(), ["client.js", "piece.js"]);
  assert.equal(shown.body.files["piece.js"], CELL_JS);

  const restored = await kernel("POST", "org1", cell, "versions/1/restore");
  assert.equal(restored.status, 200);
  assert.deepEqual([restored.body.codeVersion, restored.body.restoredFrom], [3, 1]);

  const head = await kernel("GET", "org1", cell, "files");
  assert.equal(head.body.meta.codeVersion, 3);
  assert.deepEqual(Object.keys(head.body.files).sort(), ["client.js", "piece.js"], "files added after v1 leave head");
  assert.equal(head.body.files["client.js"], "export function mount() {}");

  // v2 is still there: the branch the restore stepped off.
  const after = await kernel("GET", "org1", cell, "versions");
  assert.deepEqual(
    after.body.versions.map((v) => [v.version, v.parent, v.restoredFrom ?? null]),
    [[3, 2, 1], [2, 1, null], [1, 0, null]],
  );
  const branch = await kernel("GET", "org1", cell, "versions/2");
  assert.equal(branch.body.files["extra.js"], "export const x = 2;");

  // Code moved; data did not.
  const state = await kernel("GET", "org1", cell, "state");
  assert.equal(state.body.state.count, 5);
  const added = await kernel("POST", "org1", cell, "rpc/add", { args: [1] });
  assert.equal(added.body.result, 6, "the restored code is live");

  assert.equal((await kernel("GET", "org1", cell, "versions/9")).status, 404);
  assert.equal((await kernel("POST", "org1", cell, "versions/9/restore")).status, 404);
  await kernel("DELETE", "org1", cell, "");
});

// A deploy that will not load must not take a working piece down. It is kept
// in the history with why it failed, and the last version that loaded is put
// back as a new version, so head is always the newest and always runs.
test("versions: a deploy that fails to load is kept, and the last good version is put back", async () => {
  const cell = `w${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });
  await kernel("POST", "org1", cell, "rpc/add", { args: [1] });
  const broken = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": "export default class { syntax error" },
  });
  assert.equal(broken.status, 422);
  assert.equal(broken.body.codeVersion, 2, "the version that failed");
  assert.ok(broken.body.loadError);
  assert.deepEqual(broken.body.reverted, { codeVersion: 3, restoredFrom: 1 });

  // The piece never stopped working, and its data is as it was.
  const added = await kernel("POST", "org1", cell, "rpc/add", { args: [1] });
  assert.equal(added.status, 200);
  assert.equal(added.body.result, 2);
  assert.match((await kernel("GET", "org1", cell, "files")).body.files["piece.js"], /viewCount/);

  const list = await kernel("GET", "org1", cell, "versions");
  assert.deepEqual(list.body.versions.map((v) => v.version), [3, 2, 1]);
  assert.equal(list.body.versions[0].restoredFrom, 1);
  assert.equal(list.body.versions[0].loadError, undefined);
  assert.ok(list.body.versions[1].loadError, "v2 records why it failed");

  // A version that failed cannot be brought back, and trying changes nothing.
  const again = await kernel("POST", "org1", cell, "versions/2/restore");
  assert.equal(again.status, 422);
  assert.match(again.body.error, /failed to load/);
  assert.equal((await kernel("GET", "org1", cell, "versions")).body.versions.length, 3);

  const good = await kernel("POST", "org1", cell, "versions/1/restore");
  assert.equal(good.status, 200);
  assert.equal(good.body.codeVersion, 4);
  await kernel("DELETE", "org1", cell, "");
});

test("versions: a first deploy that fails has nothing to go back to", async () => {
  const cell = `x${Date.now().toString(36)}`;
  const broken = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": "export default class { syntax error" },
  });
  assert.equal(broken.status, 422);
  assert.equal(broken.body.reverted, undefined);
  assert.equal((await kernel("GET", "org1", cell, "versions")).body.versions.length, 1);
  await kernel("DELETE", "org1", cell, "");
});

// A pin freezes what people see while the builder keeps working on head.
// Viewer tickets, external rpc (links, the concierge) and assets get the
// pinned version; preview tickets and internal rpc get head. State is one.
const pieceSaying = (label) => `
import { Piece } from "./costa.js";
export default class extends Piece {
  which() { return { result: "${label}" }; }
  add(state, n) { const count = (state?.count ?? 0) + n; return { state: { ...state, count }, result: count }; }
}`;

test("pin: people run the pinned version, previewers and internal calls run head", async () => {
  const cell = `p${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": pieceSaying("v1"), "client.js": "// ui v1" } });
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": pieceSaying("v2") }, mode: "merge" });

  const pinned = await kernel("PUT", "org1", cell, "pin", { version: 1 });
  assert.equal(pinned.status, 200);
  assert.equal(pinned.body.pinnedVersion, 1);
  const head = await kernel("GET", "org1", cell, "files");
  assert.equal(head.body.meta.pinnedVersion, 1);
  assert.equal(head.body.meta.codeVersion, 2, "head is still head");
  assert.match(head.body.files["piece.js"], /"v2"/, "GET files is the builder's view: head");

  // A deploy under a pin moves head and nothing else.
  const v3 = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": pieceSaying("v3"), "client.js": "// ui v3" }, mode: "merge" });
  assert.equal(v3.status, 200);
  assert.equal((await kernel("GET", "org1", cell, "files")).body.meta.pinnedVersion, 1, "a deploy never touches the pin");

  const external = await kernel("POST", "org1", cell, "rpc/which", { args: [] });
  assert.equal(external.body.result, "v1");
  const internal = await kernel("POST", "org1", cell, "rpc/which", { args: [] }, { "x-kernel-scope": "internal" });
  assert.equal(internal.body.result, "v3");

  const now = Date.now();
  const viewerTicket = await mintTicket({ org: "org1", piece: cell, user: "u2", role: "viewer", exp: now + 60_000 });
  const previewTicket = await mintTicket({ org: "org1", piece: cell, user: "u1", role: "editor", exp: now + 60_000, preview: true });
  const asset = (ticket) => fetch(`${BASE}/pieces/${cell}/client.js?org=org1&ticket=${ticket}`).then((r) => r.text());
  assert.equal(await asset(viewerTicket), "// ui v1");
  assert.equal(await asset(previewTicket), "// ui v3");

  const viewer = newWebSocketRpcSession(`${WS}/pieces/${cell}/connect?org=org1&ticket=${viewerTicket}`);
  const previewer = newWebSocketRpcSession(`${WS}/pieces/${cell}/connect?org=org1&ticket=${previewTicket}`);
  assert.equal(await viewer.call("which"), "v1");
  assert.equal(await previewer.call("which"), "v3");
  // One state under both: the pinned code and head read the same data.
  assert.equal(await viewer.call("add", [2]), 2);
  assert.equal(await previewer.call("add", [3]), 5);

  const unpinned = await kernel("PUT", "org1", cell, "pin", { version: null });
  assert.equal(unpinned.body.pinnedVersion, null);
  assert.equal((await kernel("POST", "org1", cell, "rpc/which", { args: [] })).body.result, "v3");
  assert.equal(await viewer.call("which"), "v3");
  assert.equal(await asset(viewerTicket), "// ui v3");
  await kernel("DELETE", "org1", cell, "");
});

test("pin: refuses a version that does not exist or never loaded", async () => {
  const cell = `q${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": pieceSaying("v1") } });
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": "export default class { syntax error" } });

  assert.equal((await kernel("PUT", "org1", cell, "pin", { version: 9 })).status, 404);
  assert.equal((await kernel("PUT", "org1", cell, "pin", { version: 2 })).status, 422);
  assert.equal((await kernel("PUT", "org1", cell, "pin", { version: "1" })).status, 400);
  assert.equal((await kernel("GET", "org1", cell, "files")).body.meta.pinnedVersion, undefined);
  // A restore of the pinned version is a new version; the pin still names the old number.
  assert.equal((await kernel("PUT", "org1", cell, "pin", { version: 1 })).status, 200);
  await kernel("POST", "org1", cell, "versions/1/restore");
  assert.equal((await kernel("GET", "org1", cell, "files")).body.meta.pinnedVersion, 1);
  await kernel("DELETE", "org1", cell, "");
});

test("pin: the interface gate is the pinned version's", async () => {
  const cell = `r${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: {
    "piece.js": pieceSaying("v1"),
    "interface.js": `export default { "which": { "description": "says which" } }`,
  } });
  await kernel("PUT", "org1", cell, "files", { files: { "interface.js": `export default { "add": { "description": "adds" } }` }, mode: "merge" });
  assert.equal((await kernel("POST", "org1", cell, "rpc/which", { args: [] })).status, 403, "head's interface hides which");

  await kernel("PUT", "org1", cell, "pin", { version: 1 });
  assert.equal((await kernel("POST", "org1", cell, "rpc/which", { args: [] })).body.result, "v1");
  assert.equal((await kernel("POST", "org1", cell, "rpc/add", { args: [1] })).status, 403, "v1's interface hides add");
  const described = await kernel("GET", "org1", cell, "describe");
  assert.deepEqual(described.body.methods.map((m) => m.name), ["which"]);
  await kernel("DELETE", "org1", cell, "");
});

const LEGACY_JS = `
import { Cell } from "./costa.js";
export default class extends Cell {
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { ...state, count }, result: count };
  }
}
`;

test("deploy: a legacy cell.js on the Cell alias is stored and served as piece.js", async () => {
  const cell = `lg${Date.now().toString(36)}`;
  const deployed = await kernel("PUT", "org1", cell, "files", { files: { "cell.js": LEGACY_JS } });
  assert.equal(deployed.status, 200);

  const files = await kernel("GET", "org1", cell, "files");
  assert.deepEqual(Object.keys(files.body.files), ["piece.js"]);

  // The renamed module is the live entry module, not just a stored name.
  const added = await kernel("POST", "org1", cell, "rpc/add", { args: [4] });
  assert.equal(added.body.result, 4);

  // ...and a merge that omits it keeps it, rather than failing the "required"
  // check against the old name.
  const merged = await kernel("PUT", "org1", cell, "files", {
    files: { "client.js": "export function mount() {}" }, mode: "merge",
  });
  assert.equal(merged.status, 200);

  await kernel("DELETE", "org1", cell, "");
});

test("rpc: reducer state persists; errors surface; egress blocked", async () => {
  const r1 = await kernel("POST", "org1", CELL, "rpc/add", { args: [5] });
  assert.equal(r1.body.result, 5);
  const r2 = await kernel("POST", "org1", CELL, "rpc/add", { args: [3] });
  assert.equal(r2.body.result, 8);
  const boom = await kernel("POST", "org1", CELL, "rpc/boom", {});
  assert.equal(boom.status, 422);
  assert.match(boom.body.error, /kaboom/);
  const egress = await kernel("POST", "org1", CELL, "rpc/tryEgress", {});
  assert.equal(egress.body.result, "egress denied");
});

test("org isolation: same cell id, different org = different DO", async () => {
  const other = await kernel("GET", "org2", CELL, "state");
  assert.equal(other.status, 200);
  assert.equal(other.body.state, null);
  assert.equal(other.body.meta.codeVersion, 0);
});

test("websocket: ticket auth, role enforcement, push updates", async () => {
  const now = Date.now();
  const viewerTicket = await mintTicket({ org: "org1", piece: CELL, user: "u2", role: "viewer", exp: now + 60_000 });
  const editorTicket = await mintTicket({ org: "org1", piece: CELL, user: "u1", role: "editor", exp: now + 60_000 });

  // Bad ticket rejected before upgrade
  const bad = await fetch(`${BASE}/pieces/${CELL}/connect?org=org1&ticket=garbage`);
  assert.equal(bad.status, 401);
  // Ticket for another piece rejected
  // Regression: uuid-length piece ids make the base64url payload require
  // padding, which celld's strict atob rejects unless the kernel re-pads.
  const uuidCell = "01a01325-0ca3-79bb-b43b-a9db6060ffff";
  const uuidTicket = await mintTicket({ org: "org1", piece: uuidCell, user: "u1", role: "editor", exp: now + 60_000 });
  const uuidRes = await fetch(`${BASE}/pieces/${uuidCell}/connect?org=org1&ticket=${uuidTicket}`);
  assert.equal(uuidRes.status, 426, "padded-payload ticket must verify (426 = wants upgrade)");

  const cross = await mintTicket({ org: "org1", piece: "other", user: "u1", role: "editor", exp: now + 60_000 });
  const crossRes = await fetch(`${BASE}/pieces/${CELL}/connect?org=org1&ticket=${cross}`);
  assert.equal(crossRes.status, 401);

  const editor = newWebSocketRpcSession(`${WS}/pieces/${CELL}/connect?org=org1&ticket=${editorTicket}`);
  const viewer = newWebSocketRpcSession(`${WS}/pieces/${CELL}/connect?org=org1&ticket=${viewerTicket}`);

  assert.deepEqual(await editor.whoami(), { user: "u1", role: "editor" });

  const pushes = [];
  const initial = await viewer.subscribe((s) => { pushes.push(s); });
  assert.equal(initial.count, 8);

  assert.equal(await editor.call("add", [2]), 10);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(pushes.at(-1)?.count, 10);

  // Viewer means "may use the app": reads AND mutations both work. Editor
  // gates modifying the piece (deploy/connections/sharing), enforced in the control plane.
  assert.equal(await viewer.call("viewCount"), 10);
  assert.equal(await viewer.call("add", [1]), 11);

  // A call whose argument is another call's unresolved result (11 + 1, then + 12).
  assert.equal(await viewer.call("add", [viewer.call("add", [1])]), 24);
});

test("fetch effect: reducer effect chains through continuation", async () => {
  // CONTROL_URL is unset for the plain dev node started by this suite's fleet
  // unless compose provides it; either way the continuation must run with
  // {error} or {status}. Use a piece whose reducer returns an effect.
  const cell = `fx${Date.now().toString(36)}`;
  const code = `
// legacy import path — old pieces must keep loading
import { WorkerEntrypoint } from "cloudflare:workers";
export default class extends WorkerEntrypoint {
  go(state) {
    return { state: { ...state, loading: true },
             effect: { fetch: "https://api.example.com/x", then: "done" } };
  }
  done(state, outcome) {
    return { state: { ...state, loading: false, outcome }, result: outcome };
  }
}`;
  const deployed = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": code } });
  assert.equal(deployed.status, 200);
  const r = await kernel("POST", "org1", cell, "rpc/go", {});
  assert.equal(r.status, 200);
  // Continuation ran: outcome is either a denial from the control plane or an unreachable
  // error — never a hung/blank result.
  assert.ok(r.body.result.error || r.body.result.status, JSON.stringify(r.body));
  const state = await kernel("GET", "org1", cell, "state");
  assert.equal(state.body.state.loading, false);
  await kernel("DELETE", "org1", cell, "");
});

test("linked rpc: chain rides along; oversized chains rejected", async () => {
  const cell = `ln${Date.now().toString(36)}`;
  const code = `
import { Piece } from "./costa.js";
export default class extends Piece {
  hop(state) {
    return { effect: { call: { cell: "another", method: "viewX" }, then: "done" } };
  }
  done(state, outcome) { return { state: { ...state, outcome }, result: outcome }; }
}`;
  const deployed = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": code } });
  assert.equal(deployed.status, 200);

  // A chained invocation forwards the call: effect (the control plane enforces cycles/
  // depth; unreachable or denied here — either way the continuation runs
  // with an outcome, never a hang or throw).
  const chained = await kernel("POST", "org1", cell, "rpc/hop", { chain: ["a", "b"] });
  assert.equal(chained.status, 200);
  assert.ok(chained.body.result.error || chained.body.result.result !== undefined);

  // Kernel-side sanity cap on chain length (the control plane caps tighter).
  const long = await kernel("POST", "org1", cell, "rpc/hop", { chain: Array.from({ length: 20 }, (_, i) => `c${i}`) });
  assert.equal(long.status, 422);
  assert.match(long.body.error, /chain too long/);
  await kernel("DELETE", "org1", cell, "");
});

// Cell duplication imports the source's shared state into the copy.
test("state import: round-trips shared state, refused on personal cells", async () => {
  const cell = `d${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  const imported = await kernel("PUT", "org1", cell, "state", { state: { count: 42 } });
  assert.equal(imported.status, 200);
  const read = await kernel("GET", "org1", cell, "state");
  assert.deepEqual(read.body.state, { count: 42 });
  // The imported state is live, not just stored: the reducer builds on it.
  const added = await kernel("POST", "org1", cell, "rpc/add", { args: [1] });
  assert.equal(added.body.result, 43);

  const missing = await kernel("PUT", "org1", cell, "state", {});
  assert.equal(missing.status, 400);

  await kernel("PUT", "org1", cell, "mode", { mode: "personal", wipe: true });
  const refused = await kernel("PUT", "org1", cell, "state", { state: { count: 1 } });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error, /personal state/);

  await kernel("DELETE", "org1", cell, "");
});

test("logs and delete", async () => {
  const logs = await kernel("GET", "org1", CELL, "logs");
  assert.ok(logs.body.lines.some((l) => l.includes("deployed codeVersion")));
  const del = await kernel("DELETE", "org1", CELL, "");
  assert.equal(del.status, 200);
  const after = await kernel("GET", "org1", CELL, "state");
  assert.equal(after.body.state, null);
  assert.equal(after.body.meta.codeVersion, 0);
});

// The browser effect shapes the kernel owns: it validates the request and
// hands it to the control plane, which is where every policy check actually lives. What
// matters here is that a malformed session effect is refused by name, and
// that liveView (handing the browser to a person) is a recognized shape.
test("browser session effects: liveView is valid, nonsense is refused by name", async () => {
  const cell = `bw${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: {
      "piece.js": `
import { Piece } from "./costa.js";
export default class extends Piece {
  askForLogin(state) {
    return { effect: { browser: { session: "s-1", liveView: true }, then: "onLogin" } };
  }
  nonsense(state) {
    return { effect: { browser: { session: "s-1" }, then: "onLogin" } };
  }
  onLogin(state, outcome) { return { state: { outcome } }; }
}`,
    },
  });

  // liveView is a known shape, so it reaches the the control plane effect path — which is
  // unreachable from the test fleet, and says so rather than rejecting the
  // shape. The distinction is the point: a shape error would be 422 here.
  const live = await kernel("POST", "org1", cell, "rpc/askForLogin", { args: [] });
  assert.equal(live.status, 200, "liveView should be a recognized browser effect");

  // A session with no verb names every verb it could have had.
  const bad = await kernel("POST", "org1", cell, "rpc/nonsense", { args: [] });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /liveView/);

  await kernel("DELETE", "org1", cell, "");
});

// --- UI kit: theme + scheme on the generated client page ---

// Fetch the generated wrapper page for a piece, with whatever query the caller
// wants appended to the required org+ticket pair.
async function clientPage(cell, extra = "") {
  const ticket = await mintTicket({
    org: "org1", cell, user: "u1", role: "editor", exp: Date.now() + 60_000,
  });
  const res = await fetch(`${BASE}/pieces/${cell}/client?org=org1&ticket=${ticket}${extra}`, {
    redirect: "manual",
  });
  return { status: res.status, headers: res.headers, html: await res.text() };
}

test("client page: links theme then kit then the cell's own styles.css", async () => {
  const cell = `ui${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: {
      "piece.js": CELL_JS,
      "client.js": "export function mount() {}",
      "styles.css": "body { color: red }",
    },
  });

  const { status, html } = await clientPage(cell);
  assert.equal(status, 200);

  // Cascade order is the contract: platform CSS first, piece CSS last, so a
  // piece's own rules always win over the kit's.
  const theme = html.indexOf("/ui/themes/openstudio.css");
  const kit = html.indexOf("/ui/kit.css");
  const own = html.indexOf('href="styles.css');
  assert.ok(theme > 0 && kit > theme && own > kit,
    `expected theme < kit < styles.css, got ${theme}/${kit}/${own}`);

  await kernel("DELETE", "org1", cell, "");
});

test("client page: theme param picks a theme; unknown names fall back", async () => {
  const cell = `ut${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}" },
  });

  const swiss = await clientPage(cell, "&theme=swiss");
  assert.match(swiss.html, /\/ui\/themes\/swiss\.css/);

  // An unknown theme must not become a 404 stylesheet link (or a path escape).
  const bogus = await clientPage(cell, "&theme=../../etc/passwd");
  assert.match(bogus.html, /\/ui\/themes\/openstudio\.css/);
  assert.doesNotMatch(bogus.html, /passwd/);

  await kernel("DELETE", "org1", cell, "");
});

test("client page: scheme param sets data-theme; auto leaves it to boot.js", async () => {
  const cell = `us${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}" },
  });

  const dark = await clientPage(cell, "&scheme=dark");
  assert.match(dark.html, /<html[^>]*data-theme="dark"/);

  const light = await clientPage(cell, "&scheme=light");
  assert.match(light.html, /<html[^>]*data-theme="light"/);

  // auto (the default) ships no attribute — boot.js resolves it from the OS
  // so the page can also follow a live OS change.
  const auto = await clientPage(cell);
  assert.doesNotMatch(auto.html, /data-theme=/);

  await kernel("DELETE", "org1", cell, "");
});

test("client page: CSP still forbids anything off the kernel origin", async () => {
  const cell = `uc${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}" },
  });

  const { headers } = await clientPage(cell);
  const csp = headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /connect-src 'self'/);

  await kernel("DELETE", "org1", cell, "");
});

test("client page: legacy client.html is served whole, unthemed", async () => {
  const cell = `ul${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.html": "<!doctype html><title>legacy</title><p>hi" },
  });

  const { status, html } = await clientPage(cell, "&theme=swiss");
  assert.equal(status, 200);
  assert.match(html, /legacy/);
  // We do not rewrite a page we did not generate.
  assert.doesNotMatch(html, /ui\/kit\.css/);

  await kernel("DELETE", "org1", cell, "");
});

test("ui assets: kit and themes are served from the kernel origin", async () => {
  for (const path of ["/ui/kit.css", "/ui/themes/openstudio.css", "/ui/themes/swiss.css", "/ui/themes/mono.css"]) {
    const res = await fetch(`${BASE}${path}`);
    assert.equal(res.status, 200, `${path} should be served`);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/, `${path} content-type`);
    const body = await res.text();
    assert.ok(body.length > 100, `${path} should have content`);
  }

  // The themes define the variables the kit consumes; spot-check the contract.
  const kit = await (await fetch(`${BASE}/ui/kit.css`)).text();
  assert.match(kit, /var\(--cell-bg-surface\)/);
  const openstudio = await (await fetch(`${BASE}/ui/themes/openstudio.css`)).text();
  assert.match(openstudio, /--cell-bg-surface:/);
  assert.match(openstudio, /\[data-theme="dark"\]/);
  assert.match(openstudio, /prefers-color-scheme: dark/);
});

test("vendor: Chart.js is bundled and importable from the kernel origin", async () => {
  const res = await fetch(`${BASE}/vendor/chart.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /javascript/);
  // The iframe is an opaque origin, so a module import is a CORS fetch.
  assert.equal(res.headers.get("access-control-allow-origin"), "*");

  const body = await res.text();
  // The auto bundle registers every controller, so `new Chart(...)` works
  // without the caller importing and registering pieces.
  assert.match(body, /export\s*\{/, "should be an ES module");
  assert.ok(body.length > 50_000, "expected the real library, not a stub");
});

test("client page: a cell with no client.js gets the themed console", async () => {
  const cell = `cn${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  const { status, html } = await clientPage(cell, "&theme=mono");
  assert.equal(status, 200, "should render, not redirect to the old debug page");
  assert.match(html, /console\.js/);
  // The whole point: the fallback is themed like any other cell.
  assert.match(html, /\/ui\/themes\/mono\.css/);
  assert.match(html, /\/ui\/kit\.css/);

  await kernel("DELETE", "org1", cell, "");
});

test("describe: names the cell's methods and their params, minus state", async () => {
  const cell = `dc${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  const ticket = await mintTicket({
    org: "org1", cell, user: "u1", role: "viewer", exp: Date.now() + 60_000,
  });
  const api = newWebSocketRpcSession(
    `${WS}/pieces/${cell}/connect?org=org1&ticket=${ticket}`);

  const methods = await api.describe();
  const byName = Object.fromEntries(methods.map((m) => [m.name, m.params]));

  // State is every reducer's first argument and is supplied by the platform,
  // so a caller never passes it — it must not show up as a form field.
  assert.deepEqual(byName.viewCount, []);
  assert.deepEqual(byName.add, ["n"]);
  assert.ok("boom" in byName);

  // A default value may contain parens of its own. Reading the parameter list
  // by regex stops at the first `)` and fails to match the method at all, so
  // the whole thing disappears from describe rather than merely losing an
  // argument — and an agent then cannot tell the method exists.
  assert.deepEqual(byName.stamp, ["at", "label"]);

  await kernel("DELETE", "org1", cell, "");
});

const INTERFACE_JS = `// what outsiders may call
export default {
  "add": {
    "description": "Add to the running count",
    "params": { "n": "how much to add" }
  },
  "viewCount": { "description": "The running count" }
}`;

test("interface: deploy parses the declared surface, refuses a malformed one", async () => {
  const cell = `if${Date.now().toString(36)}`;

  // JS object syntax rather than JSON is the expected miss; the error has to
  // say which file and why, or the builder agent cannot fix it.
  const jsSyntax = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "interface.js": `export default { add: { description: "x" } }` },
  });
  assert.equal(jsSyntax.status, 422);
  assert.match(jsSyntax.body.error, /interface\.js must be plain JSON/);

  const notAnObject = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "interface.js": `export default ["add"]` },
  });
  assert.equal(notAnObject.status, 422);

  const noDescription = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "interface.js": `export default { "add": {} }` },
  });
  assert.equal(noDescription.status, 422);
  assert.match(noDescription.body.error, /needs a non-empty description/);

  const good = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "interface.js": INTERFACE_JS },
  });
  assert.equal(good.status, 200);

  await kernel("DELETE", "org1", cell, "");
});

test("interface: gates the rpc route, and only for external callers", async () => {
  const cell = `ig${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "interface.js": INTERFACE_JS },
  });

  const declared = await kernel("POST", "org1", cell, "rpc/add", { args: [4] });
  assert.equal(declared.status, 200);
  assert.equal(declared.body.result, 4);

  // boom exists in piece.js but is not declared: an outside caller may not
  // reach it, and the refusal names what it CAN call so the agent recovers
  // in one turn instead of probing.
  const undeclared = await kernel("POST", "org1", cell, "rpc/boom", {});
  assert.equal(undeclared.status, 403);
  assert.match(undeclared.body.error, /not in this cell's interface/);
  assert.match(undeclared.body.error, /add/);

  // The control plane marks its own dev tooling internal; the gate steps aside for it.
  const internal = await kernel("POST", "org1", cell, "rpc/boom", {}, { "x-kernel-scope": "internal" });
  assert.equal(internal.status, 422, "internal scope reaches the method (which throws)");
  assert.match(internal.body.error, /kaboom/);

  await kernel("DELETE", "org1", cell, "");
});

test("interface: absent means ungated, and deleting it reopens the surface", async () => {
  const cell = `iu${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  // Every piece written before interface.js existed keeps working.
  const ungated = await kernel("POST", "org1", cell, "rpc/viewCount", {});
  assert.equal(ungated.status, 200);

  await kernel("PUT", "org1", cell, "files", {
    files: { "interface.js": INTERFACE_JS }, mode: "merge",
  });
  assert.equal((await kernel("POST", "org1", cell, "rpc/boom", {})).status, 403);

  // A stale spec left behind would keep gating against a file that is gone.
  const removed = await kernel("PUT", "org1", cell, "files", {
    files: {}, mode: "merge", delete: ["interface.js"],
  });
  assert.equal(removed.status, 200);
  const reopened = await kernel("POST", "org1", cell, "rpc/boom", {});
  assert.equal(reopened.status, 422, "boom is reachable again, and throws on its own terms");

  await kernel("DELETE", "org1", cell, "");
});

test("describe route: declared entries with descriptions, else scanned names", async () => {
  const cell = `dr${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  const scanned = await kernel("GET", "org1", cell, "describe");
  assert.equal(scanned.status, 200);
  assert.equal(scanned.body.declared, false);
  assert.ok(scanned.body.methods.some((m) => m.name === "boom"));

  await kernel("PUT", "org1", cell, "files", {
    files: { "interface.js": INTERFACE_JS }, mode: "merge",
  });
  const described = await kernel("GET", "org1", cell, "describe");
  assert.equal(described.body.declared, true);
  const byName = Object.fromEntries(described.body.methods.map((m) => [m.name, m]));
  assert.deepEqual(Object.keys(byName).sort(), ["add", "viewCount"]);
  assert.equal(byName.add.description, "Add to the running count");
  assert.deepEqual(byName.add.params, { n: "how much to add" });
  assert.equal(byName.viewCount.params, undefined);

  await kernel("DELETE", "org1", cell, "");
});

test("interface: the scope waiver cannot arrive from a browser", async () => {
  const cell = `is${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "interface.js": INTERFACE_JS },
  });

  // The signature covers path and body, not headers. What makes the waiver
  // trustworthy is that the router drops it unless the request is
  // service-authed — so an unauthenticated one is refused at the door.
  const forged = await fetch(`${BASE}/pieces/${cell}/rpc/boom`, {
    method: "POST",
    headers: { "x-kernel-org": "org1", "x-kernel-scope": "internal", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(forged.status, 401);

  await kernel("DELETE", "org1", cell, "");
});

test("boot.js: cancels form submits the sandbox would refuse", async () => {
  const res = await fetch(`${BASE}/pieces/anything/boot.js?org=org1&ticket=x`);
  // Router gates this route on a ticket; a bad one must not serve the script.
  assert.equal(res.status, 401);

  const cell = `fb${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "client.js": "export function mount() {}" },
  });
  const ticket = await mintTicket({
    org: "org1", cell, user: "u1", role: "editor", exp: Date.now() + 60_000,
  });
  const boot = await fetch(`${BASE}/pieces/${cell}/boot.js?org=org1&ticket=${ticket}`);
  assert.equal(boot.status, 200);
  const body = await boot.text();

  // The iframe is sandboxed without allow-forms, so a submit that reaches the
  // browser's default action is refused with a console error even though the
  // piece's own handler already ran. Capture phase, so it lands before any
  // listener a piece registered.
  assert.match(body, /addEventListener\("submit"/);
  assert.match(body, /preventDefault/);
  assert.match(body, /\}, true\)/, "must be capture phase");

  await kernel("DELETE", "org1", cell, "");
});

// Usage: every call to the piece's own code is counted and timed against
// whoever made it, waiting in storage for the once-a-minute report to the control plane.
test("usage: calls are counted and timed per caller until reported", async () => {
  const cell = `u${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "client.js": "export function mount() {}" } });

  await kernel("POST", "org1", cell, "rpc/add", { args: [1], user: "u7" });
  await kernel("POST", "org1", cell, "rpc/add", { args: [1], user: "u7" });
  await kernel("POST", "org1", cell, "rpc/viewCount", { args: [] });

  const usage = await kernel("GET", "org1", cell, "usage");
  assert.equal(usage.status, 200);
  const byInvoker = Object.fromEntries(usage.body.pending.map((e) => [e.invoker ?? "owner", e]));
  assert.equal(byInvoker.u7?.calls, 2, "two calls by u7");
  assert.equal(byInvoker.u7?.task, false);
  assert.ok(byInvoker.u7?.ms >= 0);
  assert.equal(byInvoker.owner?.calls, 1, "a call with no user is the owner's");

  await kernel("DELETE", "org1", cell, "");
});

// A task run by hand runs as the person who ran it: The control plane names them, and the
// kernel carries them like an rpc's user — the slice of a personal piece, and
// who its effects are for. A schedule names no one.
test("task: a hand run carries its invoker", async () => {
  const cell = `t${Date.now().toString(36)}`;
  const tasks = `
import { Piece } from "./costa.js";
export default class extends Piece {
  tick(state) { const ticks = (state?.ticks ?? 0) + 1; return { state: { ticks }, result: ticks }; }
}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": tasks } });
  await kernel("PUT", "org1", cell, "mode", { mode: "personal", wipe: true });

  const unnamed = await kernel("POST", "org1", cell, "task/tick", {});
  assert.equal(unnamed.status, 422, "a personal piece needs someone to run as");

  const named = await kernel("POST", "org1", cell, "task/tick", { invoker: "u9" });
  assert.equal(named.status, 200, JSON.stringify(named.body));
  assert.equal(named.body.result, 1);
  assert.equal((await kernel("POST", "org1", cell, "task/tick", { invoker: "u9" })).body.result, 2);
  // Someone else's run is on their own slice.
  assert.equal((await kernel("POST", "org1", cell, "task/tick", { invoker: "u8" })).body.result, 1);

  await kernel("DELETE", "org1", cell, "");
});

// --- files ----------------------------------------

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const PNG = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));

const FILES_JS = `
import { Piece } from "./costa.js";
export default class extends Piece {
  attach(state, ref) { return { state: { ...state, photo: ref }, result: ref.id }; }
  load(state, id) { return { effect: { read: id, then: "onText" } }; }
  onText(state, outcome) { return { result: outcome }; }
  drop(state, ids) { return { effect: { remove: ids, then: "onRemoved" } }; }
  onRemoved(state, outcome) { return { result: outcome }; }
  grab(state, urls) { return { effect: { save: urls, then: "onSaved" } }; }
  onSaved(state, outcome) { return { result: outcome }; }
}`;

async function filesCell() {
  const cell = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const deployed = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": FILES_JS } });
  assert.equal(deployed.status, 200);
  const ticket = await mintTicket({ org: "org1", piece: cell, user: "u2", role: "viewer", exp: Date.now() + 60_000 });
  const session = newWebSocketRpcSession(`${WS}/pieces/${cell}/connect?org=org1&ticket=${ticket}`);
  return { cell, ticket, session };
}

test("stored files: an upload is served back from the piece's own address, locked down", async () => {
  const { cell, ticket, session } = await filesCell();
  const ref = await session.upload("my photo.png", PNG);
  assert.deepEqual(ref, { id: ref.id, name: "my_photo.png", type: "image/png", bytes: PNG.length });
  assert.match(ref.id, /^[0-9a-f]{32}$/);
  // The ref is JSON: a reducer keeps it like any other state.
  assert.equal(await session.call("attach", [ref]), ref.id);

  const res = await fetch(`${BASE}/pieces/${cell}/files/${ref.id}?org=org1&ticket=${ticket}`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "image/png");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.match(res.headers.get("content-security-policy"), /sandbox/);
  assert.match(res.headers.get("content-disposition"), /^inline/);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG);

  assert.equal((await fetch(`${BASE}/pieces/${cell}/files/${ref.id}?org=org1&ticket=garbage`)).status, 401);
  assert.equal((await fetch(`${BASE}/pieces/${cell}/files/${"0".repeat(32)}?org=org1&ticket=${ticket}`)).status, 404);
  // Same bytes, one copy.
  assert.equal((await session.upload("again.png", PNG)).id, ref.id);
  assert.equal((await kernel("GET", "org1", cell, "stored-files")).body.files.length, 1);
});

test("stored files: the type comes from the bytes, and size is capped", async () => {
  const { session } = await filesCell();
  // A PNG called .txt is still a PNG.
  assert.equal((await session.upload("sneaky.txt", PNG)).type, "image/png");
  // Bytes that are nothing we keep, whatever they are called.
  await assert.rejects(async () => await session.upload("tool.png", new Uint8Array([0x4d, 0x5a, 0x90, 0x00])), /unsupported file type/);
  await assert.rejects(async () => await session.upload("page.html", enc.encode("<html></html>")), /unsupported file type/);
  await assert.rejects(async () => await session.upload("fake.svg", enc.encode("<html></html>")), /unsupported file type/);
  await assert.rejects(async () => await session.upload("big.txt", new Uint8Array(1_000_001).fill(65)), /too large/);
  const csv = await session.upload("data.csv", enc.encode("a,b\n1,2\n"));
  assert.equal(csv.type, "text/csv");
});

test("stored files: a reducer reads text and removes files through effects", async () => {
  const { cell, ticket, session } = await filesCell();
  const csv = await session.upload("data.csv", enc.encode("a,b\n1,2\n"));
  const png = await session.upload("p.png", PNG);
  assert.deepEqual(await session.call("load", [csv.id]), { text: "a,b\n1,2\n", type: "text/csv" });
  assert.match((await session.call("load", [png.id])).error, /cannot be read as text/);
  assert.match((await session.call("load", ["nope"])).error, /no such file/);

  // A document downloads rather than opening in the page.
  const res = await fetch(`${BASE}/pieces/${cell}/files/${csv.id}?org=org1&ticket=${ticket}`);
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="data.csv"/);

  assert.deepEqual(await session.call("drop", [[csv.id, "nope"]]), { removed: 1 });
  assert.equal((await fetch(`${BASE}/pieces/${cell}/files/${csv.id}?org=org1&ticket=${ticket}`)).status, 404);
});

test("stored files: The control plane imports and exports; an expired file goes on the next write", async () => {
  const { cell } = await filesCell();
  const brief = await kernel("POST", "org1", cell, "stored-files", { name: "old.txt", base64: btoa("old"), expires: 0.000001 });
  assert.equal(brief.status, 200);
  const exported = await kernel("GET", "org1", cell, `stored-files/${brief.body.file.id}`);
  assert.equal(atob(exported.body.base64), "old");
  await new Promise((r) => setTimeout(r, 300));
  const kept = await kernel("POST", "org1", cell, "stored-files", { name: "new.txt", base64: btoa("new"), source: "https://example.com/new.txt" });
  const listed = (await kernel("GET", "org1", cell, "stored-files")).body.files;
  assert.deepEqual(listed.map((f) => f.name), ["new.txt"]);
  assert.equal(listed[0].source, "https://example.com/new.txt");
  assert.equal((await kernel("GET", "org1", cell, `stored-files/${brief.body.file.id}`)).status, 404);
  assert.equal(kept.body.file.type, "text/plain");
});

test("save effect: takes 1 to 12 URLs and always reaches the continuation", async () => {
  const { session } = await filesCell();
  await assert.rejects(async () => await session.call("grab", [[]]), /1 to 12 URLs/);
  await assert.rejects(async () => await session.call("grab", [Array(13).fill("https://example.com/a.png")]), /1 to 12 URLs/);
  // This piece is unknown to the control plane (or the control plane is not there): the outcome is an
  // error the reducer can render, never a throw.
  const outcome = await session.call("grab", ["https://example.com/a.png"]);
  assert.equal(typeof outcome.error, "string");
});

test("shipped files: a binary asset deploys as base64, is served, and stays out of the isolate", async () => {
  const cell = `a${Date.now().toString(36)}`;
  const bad = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": FILES_JS, "logo.png": "not an image" } });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /logo\.png must be the base64 of a PNG/);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg"><circle r="4"/></svg>`;
  const good = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": FILES_JS, "logo.png": PNG_BASE64, "img/mark.svg": svg, "client.js": "// ui" },
  });
  assert.equal(good.status, 200, JSON.stringify(good.body));
  // The piece still runs with an image beside its code.
  assert.equal((await kernel("POST", "org1", cell, "rpc/attach", { args: [{ id: "x" }] })).body.result, "x");

  const ticket = await mintTicket({ org: "org1", piece: cell, user: "u2", role: "viewer", exp: Date.now() + 60_000 });
  const png = await fetch(`${BASE}/pieces/${cell}/assets/logo.png?org=org1&ticket=${ticket}`);
  assert.equal(png.headers.get("content-type"), "image/png");
  assert.deepEqual(new Uint8Array(await png.arrayBuffer()), PNG);
  const mark = await fetch(`${BASE}/pieces/${cell}/assets/img/mark.svg?org=org1&ticket=${ticket}`);
  assert.equal(mark.headers.get("content-type"), "image/svg+xml; charset=utf-8");
  assert.equal(await mark.text(), svg);
  // Code is not an asset.
  assert.equal((await fetch(`${BASE}/pieces/${cell}/assets/piece.js?org=org1&ticket=${ticket}`)).status, 404);
  assert.equal((await fetch(`${BASE}/pieces/${cell}/assets/logo.png?org=org1&ticket=garbage`)).status, 401);
});

// Tests inside a piece: scenarios are data, run against
// head with state from the scenario and effects answered from it.
const TESTED_JS = `
import { Piece } from "./costa.js";
export default class extends Piece {
  viewCount(state) { return { result: state?.count ?? 0 }; }
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { ...state, count }, result: count };
  }
  look(state) {
    return { state: { ...state, loading: true }, effect: { fetch: "https://example.com/n.json", then: "onLooked" } };
  }
  onLooked(state, outcome) {
    if (outcome.error) return { state: { ...state, loading: false, error: outcome.error } };
    return { state: { ...state, loading: false, n: outcome.json.n } };
  }
  lost(state) { return { effect: { fetch: "https://example.com/x", then: "onNowhere" } }; }
}
`;
const scenarios = (list) => `export default ${JSON.stringify(list, null, 2)};\n`;
const LOOK_OK = {
  name: "looking keeps the number it read", call: "look", state: { count: 7 },
  steps: [
    { expect: { effect: { fetch: "https://example.com/n.json", then: "onLooked" }, state: { loading: true } },
      outcome: { status: 200, json: { n: 42 } } },
    { expect: { effect: null, state: { loading: false, n: 42, count: 7 } } },
  ],
};

test("piece tests: a deploy runs the scenarios, records the count, and touches no state", async () => {
  const cell = `t${Date.now().toString(36)}`;
  const deployed = await kernel("PUT", "org1", cell, "files", {
    files: {
      "piece.js": TESTED_JS,
      "interface.js": `export default ${JSON.stringify({ viewCount: { description: "The count" }, look: { description: "Look" } })};`,
      "tests.js": scenarios([
        LOOK_OK,
        { name: "adding is wrong on purpose", call: "add", args: [2], state: { count: 1 }, steps: [{ expect: { result: 4 } }] },
      ]),
    },
  });
  assert.equal(deployed.status, 200, JSON.stringify(deployed.body));
  assert.deepEqual([deployed.body.tests.total, deployed.body.tests.passed, deployed.body.tests.failed], [2, 1, 1]);
  const [ok, wrong] = deployed.body.tests.results;
  assert.equal(ok.passed, true);
  assert.equal(wrong.failure.step, 1);
  assert.match(wrong.failure.message, /result: expected 4, got 3/);
  // look is covered; viewCount is declared and nothing calls it.
  assert.deepEqual(deployed.body.untested, ["viewCount"]);
  assert.deepEqual(deployed.body.dangling, ['piece.js: then: "onNowhere" names a method that is not there']);

  // A failing test does not refuse the deploy, and the version says how it went.
  const versions = await kernel("GET", "org1", cell, "versions");
  assert.deepEqual(versions.body.versions[0].tests, { total: 2, passed: 1, failed: 1 });

  // Nothing a scenario did was saved, and no effect left the kernel.
  const state = await kernel("GET", "org1", cell, "state");
  assert.equal(state.body.state, null);
  const logs = await kernel("GET", "org1", cell, "logs");
  assert.ok(!logs.body.lines.some((line) => / effect fetch /.test(line)), "no effect was performed");

  // On demand, the same answer.
  const again = await kernel("POST", "org1", cell, "tests");
  assert.equal(again.status, 200);
  assert.equal(again.body.tests.failed, 1);
});

test("piece tests: no tests.js still checks continuations; a malformed one says why and deploys", async () => {
  const cell = `u${Date.now().toString(36)}`;
  const bare = await kernel("PUT", "org1", cell, "files", { files: { "piece.js": TESTED_JS } });
  assert.equal(bare.status, 200);
  assert.equal(bare.body.tests, null);
  assert.equal(bare.body.dangling.length, 1);
  assert.equal((await kernel("GET", "org1", cell, "versions")).body.versions[0].tests, undefined);

  const malformed = await kernel("PUT", "org1", cell, "files", {
    files: { "tests.js": "export default [{ name: 'unquoted' }];" }, mode: "merge",
  });
  assert.equal(malformed.status, 200, "a bad tests.js is reported, not refused");
  assert.equal(malformed.body.tests, null);
  assert.match(malformed.body.error, /must be plain JSON/);

  const invented = await kernel("PUT", "org1", cell, "files", {
    files: { "tests.js": scenarios([{ ...LOOK_OK, steps: [{ ...LOOK_OK.steps[0], outcome: { ok: true } }, LOOK_OK.steps[1]] }]) },
    mode: "merge",
  });
  assert.match(invented.body.tests.results[0].failure.message, /a fetch effect answers with \{ "status"/);
});

// Pieces were called pieces, and OpenStudio still says so on the wire: the old
// address, the old signed path and the old ticket field keep working.
test("old names: /cells/ addresses and a ticket's cell field are still accepted", async () => {
  const cell = `${CELL}-oldnames`;
  const signed = async (method, route, body) => {
    const bytes = enc.encode(body === undefined ? "" : JSON.stringify(body));
    const ts = Date.now();
    const sig = await hmacHex(`${ts}.${method}./org1/cells/${cell}/${route}.${await sha256Hex(bytes)}`);
    const res = await fetch(`${BASE}/cells/${cell}/${route}`, {
      method,
      headers: { authorization: `Kernel v1.${ts}.${sig}`, "x-kernel-org": "org1", "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await signed("PUT", "files", { files: { "piece.js": CELL_JS } })).status, 200);
  assert.equal((await signed("POST", "rpc/add", { args: [3] })).body.result, 3);

  // The same piece, by its new address.
  assert.equal((await kernel("GET", "org1", cell, "state")).body.state.count, 3);

  const ticket = await mintTicket({ org: "org1", cell, user: "u1", role: "owner", exp: Date.now() + 60_000 });
  assert.equal((await fetch(`${BASE}/cells/${cell}/client?org=org1&ticket=${ticket}`)).status, 200);
  assert.equal((await fetch(`${BASE}/pieces/${cell}/client?org=org1&ticket=${ticket}`)).status, 200);

  // A path signed for one name is not good for the other.
  const bytes = enc.encode("");
  const ts = Date.now();
  const sig = await hmacHex(`${ts}.GET./org1/cells/${cell}/state.${await sha256Hex(bytes)}`);
  const crossed = await fetch(`${BASE}/pieces/${cell}/state`, {
    headers: { authorization: `Kernel v1.${ts}.${sig}`, "x-kernel-org": "org1" },
  });
  assert.equal(crossed.status, 401);
});
