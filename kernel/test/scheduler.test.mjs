// Scheduler integration test against the local dev fleet (./dev.sh up first).
// Covers: registration validation, org isolation, the tasks.js boundary,
// alarm firing, run history, and the backoff/auto-pause path.
import { test, before } from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.CELLS_KERNEL_TEST_URL ?? "http://127.0.0.1:18080";
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

async function signed(method, signedPath, url, body) {
  const bytes = enc.encode(body === undefined ? "" : JSON.stringify(body));
  const ts = Date.now();
  const sig = await hmacHex(`${ts}.${method}.${signedPath}.${await sha256Hex(bytes)}`);
  const res = await fetch(url, {
    method,
    headers: {
      "authorization": `Kernel v1.${ts}.${sig}`,
      "x-kernel-org": signedPath.split("/")[1],
      "content-type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

// Mirrors Cells::KernelClient's piece routes.
const kernel = (method, org, cell, route, body) =>
  signed(method, `/${org}/pieces/${cell}/${route}`, `${BASE}/pieces/${cell}/${route}`, body);

// Mirrors Cells::KernelClient's scheduler routes.
const scheduler = (method, org, route, body) =>
  signed(method, `/${org}/scheduler/${route}`, `${BASE}/scheduler/${org}/${route}`, body);

const CELL_JS = `
import { Piece } from "./costa.js";
export default class extends Piece {
  viewCount(state) { return { result: state?.ticks ?? 0 }; }
  notATask(state) { return { result: "interactive only" }; }
}`;

const TASKS_JS = `
import { Piece } from "./costa.js";
export default class extends Piece {
  tick(state) {
    const ticks = (state?.ticks ?? 0) + 1;
    return { state: { ...state, ticks }, result: ticks };
  }
  explode() { throw new Error("task blew up"); }
}`;

const soon = () => ({ freq: "interval", timeZone: "UTC", intervalSeconds: 60 });
const daily8 = () => ({ freq: "daily", timeZone: "America/Chicago", hour: 8, minute: 0 });

before(async () => {
  const health = await fetch(`${BASE}/.well-known/celld/health`).catch(() => null);
  assert.ok(health?.ok, `no kernel at ${BASE}; start it first (see the README)`);
});

test("scheduler: rejects unsigned requests", async () => {
  const bare = await fetch(`${BASE}/scheduler/org1/schedules`);
  assert.equal(bare.status, 401);
});

test("scheduler: validates the registration payload", async () => {
  const noCell = await scheduler("PUT", "org1", "schedules/v1", { task: "tick", spec: daily8() });
  assert.equal(noCell.status, 400);
  assert.match(noCell.body.error, /cellUuid/);

  const badTask = await scheduler("PUT", "org1", "schedules/v2", {
    cellUuid: "c1", task: "not a name", spec: daily8(),
  });
  assert.equal(badTask.status, 400);
  assert.match(badTask.body.error, /tasks\.js export name/);

  const badSpec = await scheduler("PUT", "org1", "schedules/v3", {
    cellUuid: "c1", task: "tick", spec: { freq: "daily", timeZone: "America/Chicago", hour: 99, minute: 0 },
  });
  assert.equal(badSpec.status, 400);
  assert.match(badSpec.body.error, /invalid schedule spec/);
});

test("scheduler: schedules are org-scoped", async () => {
  const id = `iso${Date.now().toString(36)}`;
  await scheduler("PUT", "org1", `schedules/${id}`, { cellUuid: "c1", task: "tick", spec: daily8() });

  const mine = await scheduler("GET", "org1", "schedules");
  assert.ok(mine.body.schedules.some((s) => s.id === id));

  const theirs = await scheduler("GET", "org2", "schedules");
  assert.ok(!theirs.body.schedules.some((s) => s.id === id), "org2 must not see org1's schedule");

  await scheduler("DELETE", "org1", `schedules/${id}`);
});

test("scheduler: wall-clock next occurrence is in the future", async () => {
  const id = `wc${Date.now().toString(36)}`;
  const put = await scheduler("PUT", "org1", `schedules/${id}`, {
    cellUuid: "c1", task: "tick", spec: daily8(),
  });
  assert.equal(put.status, 200);
  assert.ok(put.body.nextAt > Date.now(), "8am Chicago must resolve ahead of now");
  // Within 24h: it is the NEXT 8am, not some far-future one.
  assert.ok(put.body.nextAt - Date.now() <= 24 * 3600_000);

  // Re-PUT of the same shape keeps the phase rather than resetting it.
  const again = await scheduler("PUT", "org1", `schedules/${id}`, {
    cellUuid: "c1", task: "tick", spec: daily8(),
  });
  assert.equal(again.body.nextAt, put.body.nextAt);

  await scheduler("DELETE", "org1", `schedules/${id}`);
});

test("tasks: a task runs from tasks.js and updates state", async () => {
  const cell = `tk${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });

  const ran = await kernel("POST", "org1", cell, "task/tick", { runId: "r1" });
  assert.equal(ran.status, 200);
  assert.equal(ran.body.result, 1);

  const state = await kernel("GET", "org1", cell, "state");
  assert.equal(state.body.state.ticks, 1);

  await kernel("DELETE", "org1", cell, "");
});

// A schedule is delivered at least once. The same run arriving again is not run again.
test("tasks: a run that arrives twice runs once", async () => {
  const cell = `td${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });

  const first = await kernel("POST", "org1", cell, "task/tick", { runId: "slot-1" });
  const again = await kernel("POST", "org1", cell, "task/tick", { runId: "slot-1" });
  const next = await kernel("POST", "org1", cell, "task/tick", { runId: "slot-2" });

  assert.equal(first.body.result, 1);
  assert.deepEqual(again.body.result, { skipped: "already ran" });
  assert.equal(next.body.result, 2);
  assert.equal((await kernel("GET", "org1", cell, "state")).body.state.ticks, 2);

  await kernel("DELETE", "org1", cell, "");
});

// Schedules are people-facing: a tick runs the pinned tasks.js, not head's.
test("tasks: a pinned piece ticks on the pinned tasks.js", async () => {
  const cell = `tp${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });
  await kernel("PUT", "org1", cell, "pin", { version: 1 });
  await kernel("PUT", "org1", cell, "files", { files: {
    "tasks.js": `import { Piece } from "./costa.js";
export default class extends Piece { tick() { return { result: "head" }; } }`,
  }, mode: "merge" });

  assert.equal((await kernel("POST", "org1", cell, "task/tick", { runId: "r1" })).body.result, 1);
  await kernel("PUT", "org1", cell, "pin", { version: null });
  assert.equal((await kernel("POST", "org1", cell, "task/tick", { runId: "r2" })).body.result, "head");
  await kernel("DELETE", "org1", cell, "");
});

test("tasks: the tasks.js boundary holds in both directions", async () => {
  const cell = `bd${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });

  // A schedule cannot reach an ordinary reducer...
  const reducer = await kernel("POST", "org1", cell, "task/notATask", {});
  assert.equal(reducer.status, 404);
  assert.match(reducer.body.error, /tasks\.js has no method/);

  // ...and an interactive call cannot reach a task.
  const task = await kernel("POST", "org1", cell, "rpc/tick", { args: [] });
  assert.equal(task.status, 404);
  assert.match(task.body.error, /piece\.js has no method/);

  await kernel("DELETE", "org1", cell, "");
});

test("tasks: a cell with no tasks.js says so", async () => {
  const cell = `nt${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS } });

  const res = await kernel("POST", "org1", cell, "task/tick", {});
  assert.equal(res.status, 404);
  assert.match(res.body.error, /no tasks\.js/);

  const listed = await kernel("GET", "org1", cell, "tasks");
  assert.deepEqual(listed.body.tasks, []);

  await kernel("DELETE", "org1", cell, "");
});

test("tasks: deploy validates tasks.js against the same contract", async () => {
  const cell = `tv${Date.now().toString(36)}`;
  const bad = await kernel("PUT", "org1", cell, "files", {
    files: { "piece.js": CELL_JS, "tasks.js": "export const tick = () => {};" },
  });
  assert.equal(bad.status, 422);
  assert.match(bad.body.error, /tasks\.js must/);
});

test("tasks: GET tasks lists what can be scheduled", async () => {
  const cell = `tl${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });

  const listed = await kernel("GET", "org1", cell, "tasks");
  assert.deepEqual(listed.body.tasks.sort(), ["explode", "tick"]);

  await kernel("DELETE", "org1", cell, "");
});

test("scheduler: a due schedule fires and records a run", async () => {
  const cell = `fr${Date.now().toString(36)}`;
  const id = `s${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });
  // intervalSeconds 60 is the floor; firstOccurrence jitters inside it, so
  // this fires within a minute rather than at a predictable instant.
  await scheduler("PUT", "org1", `schedules/${id}`, { cellUuid: cell, task: "tick", spec: soon() });

  const fired = await waitFor(async () => {
    const state = await kernel("GET", "org1", cell, "state");
    return state.body.state?.ticks >= 1;
  }, 70_000);
  assert.ok(fired, "expected the schedule to fire within its first interval");

  const runs = await scheduler("GET", "org1", `schedules/${id}/runs`);
  assert.ok(runs.body.runs.length >= 1);
  assert.equal(runs.body.runs.at(-1).status, "ok");
  assert.equal(runs.body.failures, 0);
  assert.ok(runs.body.nextAt > Date.now(), "a fired schedule re-arms ahead");

  await scheduler("DELETE", "org1", `schedules/${id}`);
  await kernel("DELETE", "org1", cell, "");
});

test("scheduler: a failing task records the error and backs off", async () => {
  const cell = `fa${Date.now().toString(36)}`;
  const id = `f${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });
  await scheduler("PUT", "org1", `schedules/${id}`, { cellUuid: cell, task: "explode", spec: soon() });

  const failed = await waitFor(async () => {
    const runs = await scheduler("GET", "org1", `schedules/${id}/runs`);
    return runs.body.runs?.length >= 1;
  }, 70_000);
  assert.ok(failed, "expected the failing task to record a run");

  const runs = await scheduler("GET", "org1", `schedules/${id}/runs`);
  const last = runs.body.runs.at(-1);
  assert.equal(last.status, "error");
  assert.match(last.error, /blew up/);
  assert.equal(runs.body.failures, 1);
  // Backoff: the retry is a minute out, not immediately due again.
  assert.ok(runs.body.nextAt - Date.now() > 30_000);

  await scheduler("DELETE", "org1", `schedules/${id}`);
  await kernel("DELETE", "org1", cell, "");
});

test("scheduler: deleting a schedule drops its runs and disarms it", async () => {
  const cell = `dl${Date.now().toString(36)}`;
  const id = `d${Date.now().toString(36)}`;
  await kernel("PUT", "org1", cell, "files", { files: { "piece.js": CELL_JS, "tasks.js": TASKS_JS } });
  await scheduler("PUT", "org1", `schedules/${id}`, { cellUuid: cell, task: "tick", spec: daily8() });

  const gone = await scheduler("DELETE", "org1", `schedules/${id}`);
  assert.equal(gone.status, 200);

  const runs = await scheduler("GET", "org1", `schedules/${id}/runs`);
  assert.equal(runs.status, 404);

  const list = await scheduler("GET", "org1", "schedules");
  assert.ok(!list.body.schedules.some((s) => s.id === id));

  await kernel("DELETE", "org1", cell, "");
});

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}
