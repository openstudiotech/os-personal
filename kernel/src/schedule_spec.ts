// Recurrence math for piece schedules. The control plane sends a structured spec (never a
// cron string); this file is the only place that knows how to turn one into a
// next-occurrence timestamp.
//
// Wall-clock freqs go through croner, which owns the timezone and DST rules —
// "8am America/Chicago" has to stay 8am across a spring-forward, and that is
// not arithmetic anyone should hand-roll. Interval is deliberately NOT a cron
// pattern: it measures elapsed time and drifts against the local clock on
// purpose.
import { Cron } from "croner";

export type ScheduleSpec =
  | { freq: "hourly"; timeZone: string; minute: number }
  | { freq: "daily"; timeZone: string; minute: number; hour: number }
  | { freq: "weekly"; timeZone: string; minute: number; hour: number; byDay: string[] }
  | { freq: "interval"; timeZone: string; intervalSeconds: number };

// The control plane speaks iCalendar's two-letter codes (MO, TU); croner wants three
// (MON, TUE). The two-letter form is what a person reads on the connections
// tab, so it stays the wire format and the translation lives here.
const CRON_DAY: Record<string, string> = {
  MO: "MON", TU: "TUE", WE: "WED", TH: "THU", FR: "FRI", SA: "SAT", SU: "SUN",
};
const DAYS = Object.keys(CRON_DAY);

export function isValidSpec(spec: any): spec is ScheduleSpec {
  if (!spec || typeof spec !== "object" || typeof spec.timeZone !== "string") return false;
  const min = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 59;
  const hr = (v: unknown) => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 23;
  switch (spec.freq) {
    case "hourly": return min(spec.minute);
    case "daily": return min(spec.minute) && hr(spec.hour);
    case "weekly":
      return min(spec.minute) && hr(spec.hour) && Array.isArray(spec.byDay) &&
        spec.byDay.length > 0 && spec.byDay.every((d: unknown) => DAYS.includes(d as string));
    case "interval": return Number.isInteger(spec.intervalSeconds) && spec.intervalSeconds >= 60;
    default: return false;
  }
}

export function cronPattern(spec: ScheduleSpec): string | null {
  switch (spec.freq) {
    case "hourly": return `${spec.minute} * * * *`;
    case "daily": return `${spec.minute} ${spec.hour} * * *`;
    case "weekly": return `${spec.minute} ${spec.hour} * * ${spec.byDay.map((d) => CRON_DAY[d]).join(",")}`;
    case "interval": return null;
  }
}

// Next occurrence strictly after `from`. Missed occurrences are skipped, never
// replayed: computing from now (rather than from the last due slot) is what
// makes a piece that was down for a day fire once on return, not twenty times.
export function nextOccurrence(spec: ScheduleSpec, from: number = Date.now()): number {
  if (spec.freq === "interval") return from + spec.intervalSeconds * 1000;
  const next = new Cron(cronPattern(spec)!, { timezone: spec.timeZone }).nextRun(new Date(from));
  if (!next) throw new Error(`schedule has no next occurrence: ${JSON.stringify(spec)}`);
  return next.getTime();
}

// Interval schedules get a jittered first tick so a fleet of pieces registered
// together doesn't thunder. Wall-clock schedules do NOT: 8am means 8am, and
// smearing it would be a bug, not politeness.
export function firstOccurrence(spec: ScheduleSpec, from: number = Date.now()): number {
  if (spec.freq !== "interval") return nextOccurrence(spec, from);
  return from + Math.floor(Math.random() * spec.intervalSeconds * 1000);
}
