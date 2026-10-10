// When a piece's tasks run. The list is kept here; the kernel does the
// timing, and holds only the ones that are switched on.
import type { Store, Schedule, Spec } from "./store.ts";
import type { Reply } from "./kernel.ts";

interface Kernel {
  request(method: string, piece: string, route: string, body?: unknown): Promise<Reply>;
  scheduler(method: string, route: string, body?: unknown): Promise<Reply>;
}
interface Deps { store: Store; kernel: Kernel }

const DAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
const DAY_NAMES: Record<string, string> = { MO: "Mon", TU: "Tue", WE: "Wed", TH: "Thu", FR: "Fri", SA: "Sat", SU: "Sun" };

// A schedule as a download describes it, in the kernel's words.
export function specFromManifest(entry: any): { task: string; spec: Spec } | null {
  try {
    const spec = specFrom({
      freq: entry.freq, timeZone: entry.time_zone, hour: entry.hour, minute: entry.minute, days: entry.by_day,
      every: entry.interval_seconds === undefined ? undefined : entry.interval_seconds / 60,
    });
    return /^[a-zA-Z]\w*$/.test(String(entry.task)) ? { task: String(entry.task), spec } : null;
  } catch {
    return null;
  }
}

// From what someone typed. `every` is minutes. Throws on anything the kernel
// would not run, so a schedule that cannot fire is never saved.
export function specFrom(fields: Record<string, any>): Spec {
  const timeZone = String(fields.timeZone ?? "");
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`${timeZone || "That"} is not a time zone`);
  }
  const within = (name: string, max: number) => {
    const value = Number(fields[name]);
    if (!Number.isInteger(value) || value < 0 || value > max) throw new Error(`${name} must be 0 to ${max}`);
    return value;
  };
  switch (fields.freq) {
    case "hourly": return { freq: "hourly", timeZone, minute: within("minute", 59) };
    case "daily": return { freq: "daily", timeZone, hour: within("hour", 23), minute: within("minute", 59) };
    case "weekly": {
      const byDay = DAYS.filter((day) => [fields.days ?? []].flat().includes(day));
      if (byDay.length === 0) throw new Error("Choose at least one day");
      return { freq: "weekly", timeZone, hour: within("hour", 23), minute: within("minute", 59), byDay };
    }
    case "interval": {
      const minutes = Number(fields.every);
      if (!Number.isFinite(minutes) || minutes < 1) throw new Error("It can run every minute at most");
      return { freq: "interval", timeZone, intervalSeconds: Math.round(minutes * 60) };
    }
    default: throw new Error("That is not a kind of schedule");
  }
}

export function describeSpec(spec: Spec): string {
  const at = `${String(spec.hour ?? 0).padStart(2, "0")}:${String(spec.minute ?? 0).padStart(2, "0")}`;
  if (spec.freq === "hourly") return `Every hour at :${String(spec.minute).padStart(2, "0")}`;
  if (spec.freq === "daily") return `Every day at ${at}, ${spec.timeZone}`;
  if (spec.freq === "weekly") return `${days(spec.byDay ?? [])} at ${at}, ${spec.timeZone}`;
  const minutes = Math.round((spec.intervalSeconds ?? 0) / 60);
  return minutes === 1 ? "Every minute" : `Every ${minutes} minutes`;
}

function days(byDay: string[]): string {
  if (byDay.join() === "MO,TU,WE,TH,FR") return "Weekdays";
  const names = byDay.map((day) => DAY_NAMES[day]);
  return names.length < 3 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

// When it runs next, said in the schedule's own time zone.
export function nextSaid(at: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

// On: the kernel is given it and starts timing. Off: the kernel forgets it.
export async function setSchedule({ store, kernel }: Deps, id: string, on: boolean): Promise<void> {
  const schedule = store.schedule(id);
  if (!schedule) throw new Error("No such schedule");
  if (on) {
    const { status, body } = await kernel.scheduler("PUT", `schedules/${id}`, { cellUuid: schedule.piece, task: schedule.task, spec: schedule.spec });
    if (status !== 200) throw new Error(body?.error ?? `The kernel answered ${status}`);
  } else {
    await kernel.scheduler("DELETE", `schedules/${id}`);
  }
  store.setEnabled(id, on);
}

export async function runNow({ store, kernel }: Deps, id: string): Promise<Reply> {
  const schedule = store.schedule(id);
  if (!schedule) throw new Error("No such schedule");
  return kernel.request("POST", schedule.piece, `task/${schedule.task}`, { invoker: "operator" });
}

export async function removeSchedule({ store, kernel }: Deps, id: string): Promise<void> {
  await kernel.scheduler("DELETE", `schedules/${id}`);
  store.removeSchedule(id);
}

// What the kernel holds, by id: when each runs next and how the last run went.
export async function timings({ kernel }: Pick<Deps, "kernel">): Promise<Map<string, any>> {
  const { status, body } = await kernel.scheduler("GET", "schedules");
  return new Map(status === 200 ? (body?.schedules ?? []).map((held: any) => [String(held.id), held]) : []);
}

// The kernel stops a schedule after five failures in a row and says so once.
// Anything switched on here that it no longer holds was stopped that way.
export async function reconcile({ store, kernel }: Deps): Promise<void> {
  const held = await timings({ kernel });
  for (const schedule of store.schedules()) {
    if (schedule.enabled && !held.has(schedule.id)) store.stop(schedule.id, "It was stopped after failing several times in a row.");
  }
}

export type { Schedule };
