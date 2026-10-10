// One SchedulerHost DO per org (name: `sched:${org}`). Owns every enabled
// schedule in that org and ONE alarm for all of them.
//
// Division of labour with the control plane: The control plane is the source of truth for what
// schedules exist, who may run them, and why a paused one stopped. This DO
// mirrors only the ENABLED rows and owns the alarm mechanics, the run history
// ring, and the backoff. A row that is disabled, deleted or paused on the control plane's side
// is simply absent here — there is no "disabled" state to represent.
//
// Why per-org rather than per-piece: a central scheduler is what makes "show me
// every schedule in this org, and which ones are failing" one query instead of
// a fan-out. The tradeoff is a shared failure domain — one hung tick delays its
// siblings until the runtime aborts the alarm — which bounded batches contain
// but do not eliminate.
import { serviceAuthHeader } from "./auth";
import { controlNoun, json, httpError, type Env } from "./cell_host";
import { firstOccurrence, isValidSpec, nextOccurrence, type ScheduleSpec } from "./schedule_spec";

const MAX_DUE_PER_PASS = 20; // bounded batch; a backlog re-arms immediately
const MAX_FAILURES = 5; // consecutive failures before the schedule pauses itself
const MAX_RUNS_KEPT = 20; // per-schedule run history ring
const BACKOFF_BASE_MS = 60_000; // first retry delay; doubles per failure
const BACKOFF_MAX_MS = 60 * 60_000;

interface Schedule {
  id: string; // the control plane's schedule id — the shared key
  cellUuid: string;
  task: string;
  spec: ScheduleSpec;
  nextAt: number;
  failures: number;
}

interface Run {
  runId: string;
  startedAt: number;
  finishedAt: number;
  status: "ok" | "error";
  error?: string;
}

export class SchedulerHost {
  state: DurableObjectState;
  env: Env;
  org: string | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // Router has already verified service auth; only the control plane ever reaches here.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const org = request.headers.get("x-kernel-org");
    if (org && !this.org) {
      this.org = org;
      // Alarms wake the DO cold with no request; persist so ticks can still
      // sign their callbacks to the control plane.
      this.state.storage.put("org", org).catch(() => {});
    }
    // /scheduler/:org/<route>
    const route = url.pathname.split("/").slice(3).join("/");
    try {
      if (request.method === "GET" && route === "schedules") return this.list();
      const runs = route.match(/^schedules\/([^/]+)\/runs$/);
      if (request.method === "GET" && runs) return this.runsFor(runs[1]);
      const one = route.match(/^schedules\/([^/]+)$/);
      if (one) {
        if (request.method === "PUT") return this.put(one[1], request);
        if (request.method === "DELETE") return this.remove(one[1]);
      }
      return json({ error: `no route: ${request.method} /${route}` }, 404);
    } catch (e: any) {
      return json({ error: String(e?.message ?? e) }, e?.status ?? 500);
    }
  }

  private async put(id: string, request: Request): Promise<Response> {
    const body = (await request.json().catch(() => ({}))) as {
      cellUuid?: string; task?: string; spec?: unknown;
    };
    if (typeof body.cellUuid !== "string" || !body.cellUuid) {
      return json({ error: "schedule requires cellUuid" }, 400);
    }
    if (typeof body.task !== "string" || !/^[a-zA-Z]\w*$/.test(body.task)) {
      return json({ error: "schedule requires a tasks.js export name" }, 400);
    }
    if (!isValidSpec(body.spec)) return json({ error: "invalid schedule spec" }, 400);

    // Re-PUT of a live schedule keeps its recurrence phase and failure count:
    // enabling something already enabled shouldn't silently reset its backoff.
    const existing = await this.load(id);
    const spec = body.spec;
    const sameShape = existing && JSON.stringify(existing.spec) === JSON.stringify(spec) &&
      existing.task === body.task && existing.cellUuid === body.cellUuid;
    const schedule: Schedule = sameShape ? existing! : {
      id, cellUuid: body.cellUuid, task: body.task, spec,
      nextAt: firstOccurrence(spec), failures: 0,
    };
    await this.save(schedule);
    await this.rearm();
    return json({ ok: true, id, nextAt: schedule.nextAt });
  }

  private async remove(id: string): Promise<Response> {
    await this.state.storage.delete(`s:${id}`);
    await this.state.storage.delete(`r:${id}`);
    await this.rearm();
    return json({ ok: true });
  }

  private async list(): Promise<Response> {
    const schedules = await this.all();
    const out = await Promise.all(schedules.map(async (s) => {
      const runs = await this.runs(s.id);
      return {
        id: s.id, cellUuid: s.cellUuid, task: s.task, nextAt: s.nextAt,
        failures: s.failures, lastRun: runs.at(-1) ?? null,
      };
    }));
    return json({ schedules: out, nextAlarm: await this.state.storage.getAlarm() });
  }

  private async runsFor(id: string): Promise<Response> {
    const schedule = await this.load(id);
    if (!schedule) return json({ error: "no such schedule" }, 404);
    return json({ id, nextAt: schedule.nextAt, failures: schedule.failures, runs: await this.runs(id) });
  }

  async alarm(): Promise<void> {
    this.org ??= (await this.state.storage.get<string>("org")) ?? null;
    const now = Date.now();
    const due = (await this.all())
      .filter((s) => s.nextAt <= now)
      .sort((a, b) => a.nextAt - b.nextAt)
      .slice(0, MAX_DUE_PER_PASS);

    // Fire sequentially: a piece's DO is single-threaded anyway, and serial
    // ticks keep one slow piece from being indistinguishable from a stampede.
    for (const schedule of due) await this.runOne(schedule, now);
    await this.rearm();
  }

  private async runOne(schedule: Schedule, now: number): Promise<void> {
    const runId = `${schedule.id}-${schedule.nextAt}`;
    const startedAt = Date.now();
    try {
      await this.invokeTask(schedule, runId);
      schedule.failures = 0;
      // Next occurrence from NOW, not from the slot we just ran: a tick that
      // took ten minutes shouldn't immediately be due again.
      schedule.nextAt = nextOccurrence(schedule.spec, Date.now());
      await this.record(schedule.id, { runId, startedAt, finishedAt: Date.now(), status: "ok" });
    } catch (e: any) {
      const error = String(e?.message ?? e);
      schedule.failures += 1;
      await this.record(schedule.id, { runId, startedAt, finishedAt: Date.now(), status: "error", error });
      if (schedule.failures >= MAX_FAILURES) {
        // The control plane owns the paused state — tell it why, then drop the mirror.
        // If the callback fails we still drop it: a schedule that keeps
        // failing must not keep firing just because the control plane was unreachable.
        await this.reportPaused(schedule, error).catch(() => {});
        await this.state.storage.delete(`s:${schedule.id}`);
        return;
      }
      schedule.nextAt = Date.now() + Math.min(BACKOFF_BASE_MS * 2 ** (schedule.failures - 1), BACKOFF_MAX_MS);
    }
    await this.save(schedule);
  }

  // Run the task in its own piece's DO, through the normal reducer path, so
  // effects, depth caps and the control plane mediation are all unchanged. The piece host
  // resolves the task against tasks.js and refuses anything else.
  private async invokeTask(schedule: Schedule, runId: string): Promise<void> {
    const org = this.orgOrThrow();
    const id = this.env.CELL_HOST.idFromName(`${org}:${schedule.cellUuid}`);
    const res = await this.env.CELL_HOST.get(id).fetch(
      new Request(`https://kernel/pieces/${schedule.cellUuid}/task/${schedule.task}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-kernel-identity": JSON.stringify([org, schedule.cellUuid]),
        },
        body: JSON.stringify({ runId }),
      }),
    );
    const parsed: any = await res.json().catch(() => ({ error: `bad response (${res.status})` }));
    if (!res.ok) throw new Error(parsed.error ?? `task failed (${res.status})`);
  }

  private async reportPaused(schedule: Schedule, error: string): Promise<void> {
    const controlUrl = this.env.CONTROL_URL ?? this.env.RAILS_URL;
    if (!controlUrl) return;
    const org = this.orgOrThrow();
    const body = JSON.stringify({ status: "paused_failures", reason: error.slice(0, 500) });
    const noun = controlNoun(this.env);
    const path = `/api/v1/${noun}/schedules/${schedule.id}/status`;
    const auth = await serviceAuthHeader(
      this.env.KERNEL_SECRET, "POST", `/${org}/${noun}/schedules/${schedule.id}/status`,
      new TextEncoder().encode(body),
    );
    await fetch(`${controlUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: auth, "x-kernel-org": org },
      body,
    });
  }

  // One alarm for the whole org: the earliest nextAt across every schedule.
  private async rearm(): Promise<void> {
    const schedules = await this.all();
    if (schedules.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    const earliest = Math.min(...schedules.map((s) => s.nextAt));
    // A backlog (more due than one pass handles) re-arms immediately rather
    // than waiting for the next natural occurrence.
    await this.state.storage.setAlarm(Math.max(earliest, Date.now() + 1000));
  }

  private async all(): Promise<Schedule[]> {
    const map = await this.state.storage.list<Schedule>({ prefix: "s:" });
    return [...map.values()];
  }

  private async load(id: string): Promise<Schedule | null> {
    return (await this.state.storage.get<Schedule>(`s:${id}`)) ?? null;
  }

  private async save(schedule: Schedule): Promise<void> {
    await this.state.storage.put(`s:${schedule.id}`, schedule);
  }

  private async runs(id: string): Promise<Run[]> {
    return (await this.state.storage.get<Run[]>(`r:${id}`)) ?? [];
  }

  private async record(id: string, run: Run): Promise<void> {
    const runs = [...(await this.runs(id)), run].slice(-MAX_RUNS_KEPT);
    await this.state.storage.put(`r:${id}`, runs);
  }

  private orgOrThrow(): string {
    if (!this.org) throw httpError(500, "scheduler identity not initialized");
    return this.org;
  }
}
