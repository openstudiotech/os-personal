import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { loadPiece } from "../src/pieces.ts";
import { describeSpec, reconcile, runNow, setSchedule, specFrom } from "../src/schedules.ts";
import { COUNTER, fakeKernel, makeZip, manifest } from "./support.ts";

const daily = { freq: "daily", timeZone: "America/Chicago", hour: 8, minute: 0 };

function world() {
  const store = new Store(":memory:");
  store.addPiece({ id: "pa", name: "Brief", description: "", wants: [] });
  return { store, kernel: fakeKernel() };
}

test("a schedule in a download is kept, switched off", async () => {
  const { store, kernel } = world();
  const piece = await loadPiece(makeZip({
    "manifest.yml": manifest({ connections: [{ kind: "schedule", config: { schedules: [
      { task: "refresh", freq: "weekly", hour: 9, minute: 30, by_day: ["MO", "FR"], time_zone: "Europe/London" },
      { task: "sweep", freq: "interval", interval_seconds: 900, time_zone: "UTC" },
    ] } }] }),
    "files/piece.js": COUNTER,
  }), { store, kernel });

  const kept = store.schedules(piece.id);
  assert.deepEqual(kept.map((s) => [s.task, s.enabled]), [["refresh", false], ["sweep", false]]);
  assert.deepEqual(kept[0].spec, { freq: "weekly", timeZone: "Europe/London", hour: 9, minute: 30, byDay: ["MO", "FR"] });
  assert.deepEqual(kept[1].spec, { freq: "interval", timeZone: "UTC", intervalSeconds: 900 });
  assert.equal(kernel.calls.filter((call) => call.route.startsWith("schedules")).length, 0, "nothing is timed until it is turned on");
});

test("turning one on gives it to the kernel; turning it off takes it back", async () => {
  const { store, kernel } = world();
  const id = store.addSchedule({ piece: "pa", task: "refresh", spec: daily });

  await setSchedule({ store, kernel }, id, true);
  assert.deepEqual(kernel.calls.at(-1), { method: "PUT", piece: "scheduler", route: `schedules/${id}`, body: { cellUuid: "pa", task: "refresh", spec: daily } });
  assert.equal(store.schedule(id)?.enabled, true);

  await setSchedule({ store, kernel }, id, false);
  assert.equal(kernel.calls.at(-1)?.method, "DELETE");
  assert.equal(store.schedule(id)?.enabled, false);
});

test("a schedule the kernel will not take stays off, and says why", async () => {
  const { store } = world();
  const kernel = fakeKernel({ "PUT schedules": { status: 400, body: { error: "invalid schedule spec" } } });
  const id = store.addSchedule({ piece: "pa", task: "refresh", spec: daily });

  await assert.rejects(setSchedule({ store, kernel }, id, true), /invalid schedule spec/);
  assert.equal(store.schedule(id)?.enabled, false);
});

test("a spec is taken only in the shapes the kernel knows", () => {
  assert.deepEqual(specFrom({ freq: "hourly", minute: "15", timeZone: "UTC" }), { freq: "hourly", timeZone: "UTC", minute: 15 });
  assert.deepEqual(specFrom({ freq: "interval", every: "30", timeZone: "UTC" }), { freq: "interval", timeZone: "UTC", intervalSeconds: 1800 });
  for (const bad of [
    { freq: "yearly", timeZone: "UTC" }, { freq: "daily", hour: "25", minute: "0", timeZone: "UTC" },
    { freq: "weekly", hour: "8", minute: "0", days: [], timeZone: "UTC" }, { freq: "interval", every: "0", timeZone: "UTC" },
    { freq: "daily", hour: "8", minute: "0", timeZone: "Mars/Olympus" },
  ]) assert.throws(() => specFrom(bad), /./, JSON.stringify(bad));
});

test("a schedule is described the way someone would say it", () => {
  assert.equal(describeSpec(daily), "Every day at 08:00, America/Chicago");
  assert.equal(describeSpec({ freq: "weekly", timeZone: "UTC", hour: 9, minute: 30, byDay: ["MO", "FR"] }), "Mon and Fri at 09:30, UTC");
  assert.equal(describeSpec({ freq: "weekly", timeZone: "UTC", hour: 8, minute: 0, byDay: ["MO", "TU", "WE", "TH", "FR"] }), "Weekdays at 08:00, UTC");
  assert.equal(describeSpec({ freq: "weekly", timeZone: "UTC", hour: 8, minute: 0, byDay: ["MO", "WE", "SA"] }), "Mon, Wed and Sat at 08:00, UTC");
  assert.equal(describeSpec({ freq: "hourly", timeZone: "UTC", minute: 5 }), "Every hour at :05");
  assert.equal(describeSpec({ freq: "interval", timeZone: "UTC", intervalSeconds: 900 }), "Every 15 minutes");
});

test("running one now runs the task as the operator", async () => {
  const { store, kernel } = world();
  const id = store.addSchedule({ piece: "pa", task: "refresh", spec: daily });

  await runNow({ store, kernel }, id);

  const call = kernel.calls.at(-1)!;
  assert.equal(call.route, "task/refresh");
  assert.equal(call.body.invoker, "operator");
});

// The kernel stops a schedule that keeps failing and says so once. If that
// was missed, asking it what it holds finds out.
test("a schedule the kernel no longer holds is marked as stopped", async () => {
  const { store } = world();
  const held = store.addSchedule({ piece: "pa", task: "refresh", spec: daily });
  const dropped = store.addSchedule({ piece: "pa", task: "sweep", spec: daily });
  store.setEnabled(held, true);
  store.setEnabled(dropped, true);
  const kernel = fakeKernel({ "GET schedules": { status: 200, body: { schedules: [{ id: held }] } } });

  await reconcile({ store, kernel });

  assert.equal(store.schedule(held)?.enabled, true);
  assert.equal(store.schedule(dropped)?.enabled, false);
  assert.match(store.schedule(dropped)?.stopped ?? "", /stopped/);
});
