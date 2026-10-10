// Pieces kernel router. The only worker deployed to the celld fleet.
//
// URL shape: /pieces/:cellId/<route>. Org is never taken from the URL — it comes
// from the authenticated credential (service auth body / ticket), so a caller
// can only ever reach DOs inside its own org prefix.
//
//   The control plane (service auth):  PUT files, GET files, POST reload, POST rpc/:m,
//                          GET logs, GET state, GET describe, DELETE
//   Browser (ticket):      GET connect (WebSocket -> capnweb), GET files/:id,
//                          GET assets/:name
//
// Schedules live on a second URL shape, /scheduler/:org/..., because they are
// org-scoped rather than piece-scoped: one SchedulerHost owns every schedule in
// an org. The control plane only; no browser credential reaches it.
import { verifyServiceAuth, verifyTicket, unauthorized } from "./auth";
import { PieceHost, json, type Env } from "./cell_host";
import { SchedulerHost } from "./scheduler_host";

// Registered as CellHost: every piece's storage hangs on that name, so the
// class is renamed in the code and not where the data is.
export { PieceHost as CellHost, SchedulerHost };

const CELL_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const ORG_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const scheduler = url.pathname.match(/^\/scheduler\/([^/]+)(\/.*)?$/);
    if (scheduler) return schedulerFetch(request, env, scheduler[1], (scheduler[2] ?? "/").slice(1));

    // /pieces/ is the address. /cells/ is its older name, still answered so a
    // control plane that has not changed keeps working.
    const m = url.pathname.match(/^\/(pieces|cells)\/([^/]+)(\/.*)?$/);
    if (!m) return json({ error: "expected /pieces/:id/..." }, 404);
    const noun = m[1];
    const cellId = m[2];
    const route = (m[3] ?? "/").slice(1);
    if (!CELL_ID.test(cellId)) return json({ error: "bad cell id" }, 400);

    let org: string;
    const headers = new Headers(request.headers);
    headers.delete("x-kernel-ticket");
    headers.delete("x-kernel-identity");
    headers.delete("x-kernel-org");
    // Scrubbed here and restored below only for a service call: x-kernel-scope
    // waives the interface gate, so it must never survive from a browser
    // request. The signature covers path and body, not headers, so the header
    // alone is not evidence — arriving on a service-authed request is.
    const scope = headers.get("x-kernel-scope");
    headers.delete("x-kernel-scope");

    // files/<id> and assets/<name> are what a piece's page shows; the bare
    // `files` route is the control plane deploying code.
    // `page-log` is the page saying what went wrong in it.
    if (route === "connect" || route === "client" || route === "client.js" || route === "styles.css" || route === "boot.js" ||
        route === "page-log" || route.startsWith("files/") || route.startsWith("assets/")) {
      // Browser credential: ticket in ?ticket= (WS API can't set headers;
      // the client page keeps the same query so it can derive its WS URL).
      const ticket = await verifyTicket(
        url.searchParams.get("ticket"), env.KERNEL_SECRET,
        url.searchParams.get("org") ?? "", cellId,
      );
      if (!ticket) return unauthorized("invalid or expired ticket");
      org = ticket.org;
      headers.set("x-kernel-ticket", JSON.stringify(ticket));
    } else {
      // A service call from the control plane: org rides in x-kernel-org and is folded into the
      // signed path, so it cannot be forged independently of the signature.
      org = request.headers.get("x-kernel-org") ?? "";
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(org)) {
        return unauthorized("missing or bad x-kernel-org");
      }
      const body = new Uint8Array(await request.clone().arrayBuffer());
      const signedPath = `/${org}/${noun}/${cellId}/${route}`;
      const failure = await verifyServiceAuth(request, signedPath, body, env.KERNEL_SECRET);
      if (failure) return failure;
      if (scope) headers.set("x-kernel-scope", scope);
    }

    const id = env.CELL_HOST.idFromName(`${org}:${cellId}`);
    // The DO can't recover org/cell from its id (idFromName is one-way), and
    // effects need them to call back into the control plane.
    headers.set("x-kernel-identity", JSON.stringify([org, cellId]));
    // new Request(request, {headers}) preserves method/body/upgrade with the
    // scrubbed + augmented headers.
    return env.CELL_HOST.get(id).fetch(new Request(request, { headers }));
  },
};

// Org is in the URL here (unlike /pieces/:id, where it rides in a header), but
// it is still folded into the signed path, so it cannot be forged
// independently of the signature.
async function schedulerFetch(request: Request, env: Env, org: string, route: string): Promise<Response> {
  if (!ORG_ID.test(org)) return json({ error: "bad org" }, 400);
  const body = new Uint8Array(await request.clone().arrayBuffer());
  const failure = await verifyServiceAuth(request, `/${org}/scheduler/${route}`, body, env.KERNEL_SECRET);
  if (failure) return failure;

  const headers = new Headers(request.headers);
  headers.delete("x-kernel-ticket");
  headers.delete("x-kernel-identity");
  headers.set("x-kernel-org", org);
  const id = env.SCHEDULER_HOST.idFromName(`sched:${org}`);
  return env.SCHEDULER_HOST.get(id).fetch(new Request(request, { headers }));
}
