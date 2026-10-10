// Recurrence math, including the DST cases that are the whole reason this
// goes through croner instead of arithmetic. No dev fleet needed.
//
// Runs against the compiled module (npm run build:test) so the day-code
// translation and the spec validation under test are the real ones.
import { test } from "node:test";
import assert from "node:assert/strict";
import { cronPattern, firstOccurrence, isValidSpec, nextOccurrence } from "../dist-test/schedule_spec.js";

const CHICAGO = "America/Chicago";

function nextFor(spec, fromIso) {
  return new Date(nextOccurrence(spec, Date.parse(fromIso)));
}
function daily(hour, minute = 0, timeZone = CHICAGO) {
  return { freq: "daily", timeZone, hour, minute };
}

// What the local wall clock reads at a given instant, in a given zone.
function wallClock(date, tz) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(date);
}

test("daily wall-clock time survives spring-forward", () => {
  // US Central springs forward 2026-03-08. 8am must stay 8am on both sides.
  const before = nextFor(daily(8), "2026-03-07T20:00:00Z");
  const after = nextFor(daily(8), "2026-03-08T20:00:00Z");
  assert.equal(wallClock(before, CHICAGO), "08:00");
  assert.equal(wallClock(after, CHICAGO), "08:00");
  // ...and the UTC instants shift by the DST hour, proving it is not naive.
  assert.equal(before.toISOString(), "2026-03-08T13:00:00.000Z");
  assert.equal(nextFor(daily(8), "2026-03-06T20:00:00Z").toISOString(),
    "2026-03-07T14:00:00.000Z");
});

test("daily wall-clock time survives fall-back", () => {
  // US Central falls back 2026-11-01.
  assert.equal(wallClock(nextFor(daily(8), "2026-10-31T20:00:00Z"), CHICAGO), "08:00");
  assert.equal(wallClock(nextFor(daily(8), "2026-11-01T20:00:00Z"), CHICAGO), "08:00");
});

test("a nonexistent spring-forward hour still produces an occurrence", () => {
  // 02:30 local does not exist on 2026-03-08 in Chicago. The schedule must
  // not silently stall — a task set for 2:30am should still run that day.
  const from = "2026-03-08T06:00:00Z";
  const next = nextFor(daily(2, 30), from);
  assert.ok(next.getTime() > Date.parse(from), "expected an occurrence despite the DST gap");
  // Whatever it resolves to, it is within a day — not skipped to next week.
  assert.ok(next.getTime() - Date.parse(from) < 36 * 3600_000);
});

test("weekly byDay uses iCalendar codes on the wire and croner's inside", () => {
  assert.equal(
    cronPattern({ freq: "weekly", timeZone: CHICAGO, hour: 9, minute: 30, byDay: ["MO", "FR"] }),
    "30 9 * * MON,FRI",
  );
  // Tue Sep 15 2026 -> next MO or FR is Fri Sep 18.
  const next = nextFor(
    { freq: "weekly", timeZone: CHICAGO, hour: 9, minute: 30, byDay: ["MO", "FR"] },
    "2026-09-15T20:00:00Z",
  );
  assert.equal(wallClock(next, CHICAGO), "09:30");
  assert.equal(next.toISOString().slice(0, 10), "2026-09-18");
});

test("hourly fires at the same minute every hour", () => {
  const spec = { freq: "hourly", timeZone: CHICAGO, minute: 15 };
  const first = nextFor(spec, "2026-09-15T20:00:00Z");
  const second = nextFor(spec, first.toISOString());
  assert.equal(second.getTime() - first.getTime(), 3600_000);
});

test("occurrences are computed forward, never replayed", () => {
  // A piece down for a week returns to ONE next occurrence, not seven.
  const from = "2026-09-15T20:00:00Z";
  const next = nextFor(daily(8), from);
  assert.ok(next.getTime() > Date.parse(from));
  assert.ok(next.getTime() - Date.parse(from) < 24 * 3600_000);
});

test("interval measures elapsed time and jitters only its first tick", () => {
  const spec = { freq: "interval", timeZone: "UTC", intervalSeconds: 3600 };
  const from = Date.parse("2026-09-15T20:00:00Z");
  assert.equal(cronPattern(spec), null);
  assert.equal(nextOccurrence(spec, from), from + 3600_000);
  // First tick lands inside the window, so a fleet registered together
  // doesn't thunder; wall-clock schedules are NOT jittered.
  const first = firstOccurrence(spec, from);
  assert.ok(first >= from && first < from + 3600_000);
  assert.equal(firstOccurrence(daily(8), from), nextOccurrence(daily(8), from));
});

test("invalid specs are rejected before they can be stored", () => {
  assert.ok(isValidSpec(daily(8)));
  assert.ok(!isValidSpec({ freq: "daily", timeZone: CHICAGO, hour: 24, minute: 0 }));
  assert.ok(!isValidSpec({ freq: "daily", timeZone: CHICAGO, hour: 8 })); // no minute
  assert.ok(!isValidSpec({ freq: "weekly", timeZone: CHICAGO, hour: 8, minute: 0, byDay: [] }));
  assert.ok(!isValidSpec({ freq: "weekly", timeZone: CHICAGO, hour: 8, minute: 0, byDay: ["FUNDAY"] }));
  assert.ok(!isValidSpec({ freq: "interval", timeZone: "UTC", intervalSeconds: 30 }));
  assert.ok(!isValidSpec({ freq: "yearly", timeZone: "UTC" }));
  assert.ok(!isValidSpec(null));
});
