// One PieceHost DO per piece (name: `${org}:${piece}`). Owns the piece's files,
// state, logs, and the loader isolate running its code.
//
// Cell code contract (v1 "reducer" template, validated in the Phase 0 spike):
//   export default class extends WorkerEntrypoint {
//     method(state, ...args) { return { state?, result? } }
//   }
// Loaded with globalOutbound: null — zero egress. The DO owns SQLite-backed
// state, applies returned state, and pushes updates to capnweb subscribers.
import { newWorkersWebSocketRpcResponse } from "capnweb";
import { serviceAuthHeader, verifyTicket, type Ticket } from "./auth";
import { PieceSession } from "./session";
import {
  TESTS_MODULE, danglingContinuations, parseTests, runScenarios, untested,
  type Invoke, type Scenario, type TestSummary,
} from "./piece_tests";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 1_000_000; // loader cap is 64 MiB total; keep cells small
const MAX_LOG_LINES = 500;
const MAX_PAGE_LOGS_PER_MINUTE = 30;
const MAX_EFFECT_DEPTH = 8; // fetch -> continuation -> fetch ... bound
const MAX_LINK_CHAIN = 8; // sanity bound on visited-cell chains (the control plane enforces its own cap)
// Entry modules. piece.js holds the reducers a person (or another piece) calls;
// tasks.js holds the ones a schedule calls. Timing lives in SchedulerHost.
const PIECE_MODULE = "piece.js";
const TASKS_MODULE = "tasks.js";
// DEPRECATED (cell.js -> piece.js rename): pieces deployed before the rename
// hold their reducers under the old name, and older clients still send it.
// Every read of the stored set and every incoming deploy passes through
// legacyModuleRenamed, so an old piece loads and its next deploy persists the
// new name. Delete once no stored file set contains cell.js.
const LEGACY_PIECE_MODULE = "cell.js";
function legacyModuleRenamed(files: Record<string, string>): Record<string, string> {
  if (!(LEGACY_PIECE_MODULE in files)) return files;
  const { [LEGACY_PIECE_MODULE]: legacy, ...rest } = files;
  return PIECE_MODULE in rest ? rest : { ...rest, [PIECE_MODULE]: legacy };
}
// Not an entry module: data. Declares which of piece.js's reducers outsiders
// (the concierge, a linked piece) may call, and what each one is for. Parsed at
// deploy and stored as `interfaceSpec`, so gating a call is a storage read.
const INTERFACE_MODULE = "interface.js";
// Usage: how long this piece's own code ran, per
// payer, kept in storage and flushed to the control plane at most this often while the
// piece is in use, and at the end of every scheduled run. The control plane charges it.
const USAGE_FLUSH_MS = 60_000;
// The most CPU one call into a piece's code may use.
const PIECE_CPU_MS = 2_000;

// Files. Two kinds, both served from the piece's own
// address so the page's `img-src 'self'` never has to widen:
//   stored  — data the piece gathers while running (a saved image, an upload).
//             Lives beside the state, unversioned. Page address: files/<id>.
//   shipped — assets deployed with the code, versioned with it. Binary types
//             are base64 text in the file set. Page address: assets/<name>.
const MAX_STORED_FILE_BYTES = 1_000_000;
const MAX_STORED_BYTES = 50_000_000;
const MAX_STORED_FILES = 500;
const MAX_EFFECT_URLS = 12; // one save: or preview: effect
const FILE_TYPES: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif",
  avif: "image/avif", svg: "image/svg+xml", pdf: "application/pdf", csv: "text/csv",
  json: "application/json", txt: "text/plain", md: "text/markdown",
};
// Held as base64 in the deployed file set, and never handed to the isolate as
// a module.
const BINARY_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif", "avif", "pdf"];
const TEXT_TYPES = /^(text\/|application\/json$|image\/svg\+xml$)/;
// Shown in the page; everything else downloads.
const INLINE_TYPES = /^(image\/|application\/pdf$|text\/plain$)/;

// What a stored file is, as it appears in state: JSON, so a reducer can keep
// it and the page can turn it into an address.
interface FileRef { id: string; name: string; type: string; bytes: number }
interface StoredFile extends FileRef {
  at: number;
  by: string | null; // who uploaded it, or whose call fetched it; null = a schedule
  source?: string; // the URL it was saved from
  expires?: number; // purged on the first write after this
}

// One payer's share of a batch: the person who called (null for a scheduled
// task, which the owner pays) and whether it was a task.
interface UsageEntry { invoker: string | null; task: boolean; calls: number; ms: number }
interface UsageBatch { batch: string; entries: UsageEntry[] }

interface CellMeta {
  codeVersion: number;
  updatedAt: number;
  // Set = a person pinned what people see to this version. Head keeps
  // moving under it (the builder deploys, tests and previews head); viewers,
  // links and schedules run the pin until it is moved or removed.
  pinnedVersion?: number;
}

// One `ver:<n>` per deploy, never deleted. File contents live under
// `blob:<sha256>`, so a version costs one manifest plus whatever changed, and
// any version can be rebuilt from blobs. `parent` is the version the deploy
// built on; `restoredFrom` marks a restore, which is a new version pointing
// back at an old one — the versions in between stay readable, so nothing is
// lost by rolling back and forward again.
interface VersionManifest {
  files: Record<string, string>; // name -> sha256 of the content
  at: number;
  parent: number; // 0 for the first deploy
  restoredFrom?: number;
  loadError?: string;
  // How this version's own tests went when it was deployed (tests.js).
  tests?: { total: number; passed: number; failed: number };
}

async function sha256Hex(content: string | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", (typeof content === "string" ? new TextEncoder().encode(content) : content) as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Platform-injected module: pieces import Costa vocabulary, never
// cloudflare:workers directly. One place to extend the base class (or retarget
// the runtime) later. The Cell alias is DEPRECATED — pieces written before the
// rename import it and keep working; nothing new should name it.
const COSTA_MODULE = `import { WorkerEntrypoint } from "cloudflare:workers";
export class Piece extends WorkerEntrypoint {}
export const Cell = Piece;
`;

// Themes the generated client page may link. Allow-list, not a path join:
// the value arrives in a query param and becomes a URL.
const THEMES = ["openstudio", "swiss", "mono"];
const DEFAULT_THEME = "openstudio";

// Served as /pieces/:id/boot.js inside the generated client page (classic
// script, so it runs before the client.js module). A client-side exception
// used to mean a silently blank iframe; now it renders the actual error so
// users and the builder agent can see what broke.
//
// Colour scheme needs no JS here: scheme=light|dark is an attribute on <html>,
// and scheme=auto is resolved by each theme's own prefers-color-scheme block,
// which also follows a live OS change.
const BOOT_SCRIPT = `(function () {
  // A <form> whose submit handler doesn't preventDefault tries to navigate,
  // which the iframe sandbox (allow-scripts, deliberately no allow-forms)
  // refuses: "Blocked form submission ... the 'allow-forms' permission is not
  // set." The piece's own handler still ran, so the work happened and only the
  // navigation was refused — the error is confusing precisely because nothing
  // visibly broke. Cancelling it here in the capture phase stops the
  // navigation before any listener runs, while still letting the piece's own
  // submit handler fire (verified: capture-phase preventDefault does not stop
  // propagation). Cells that want a real navigating form cannot have one
  // regardless, so nothing is lost.
  document.addEventListener("submit", function (e) {
    if (!e.defaultPrevented) e.preventDefault();
  }, true);

  function show(message) {
    var banner = document.getElementById("__cell_error__");
    if (!banner) {
      banner = document.createElement("div");
      banner.id = "__cell_error__";
      banner.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:99999;" +
        "background:#7f1d1d;color:#fecaca;font:12px/1.5 monospace;" +
        "padding:8px 12px;white-space:pre-wrap;word-break:break-word;";
      (document.body || document.documentElement).appendChild(banner);
    }
    banner.textContent = "cell client error: " + message;
  }
  // Tell the platform too, so whoever is building this piece can read what
  // went wrong in its page without being shown a screenshot of it. The same
  // thing is said once, and a page that keeps failing stops being listened to.
  var told = {};
  var tellings = 0;
  function tell(kind, message) {
    message = String(message == null ? "" : message).slice(0, 600);
    if (!message || told[kind + message] || tellings >= 20) return;
    told[kind + message] = true;
    tellings += 1;
    try {
      fetch(location.pathname.split("/").slice(0, -1).concat("page-log").join("/") + location.search, {
        method: "POST", mode: "no-cors", keepalive: true, body: JSON.stringify({ kind: kind, message: message }),
      }).catch(function () {});
    } catch (e) {}
  }
  function words(args) {
    return Array.prototype.map.call(args, function (arg) {
      if (arg instanceof Error) return arg.message;
      if (typeof arg === "string") return arg;
      try { return JSON.stringify(arg); } catch (e) { return String(arg); }
    }).join(" ");
  }
  ["error", "warn"].forEach(function (level) {
    var original = console[level];
    console[level] = function () {
      tell("console." + level, words(arguments));
      return original.apply(console, arguments);
    };
  });
  window.addEventListener("error", function (e) {
    var message = (e.message || "unknown error") + (e.filename ? " (" + e.filename.split("?")[0].split("/").pop() + ":" + e.lineno + ")" : "");
    show(message);
    tell("error", message);
  });
  window.addEventListener("unhandledrejection", function (e) {
    var r = e.reason;
    var message = r && r.message ? r.message : String(r);
    show(message);
    tell("unhandled", message);
  });
  // Something the browser refused on the page's behalf: a picture or a
  // script from somewhere its policy does not allow.
  document.addEventListener("securitypolicyviolation", function (e) {
    tell("blocked", (e.violatedDirective || "policy") + " " + (e.blockedURI || ""));
  });

  // A plain link would load its page in this frame, where the piece was, and
  // most sites refuse to be shown in a frame at all. Every link out opens in
  // a new tab instead; a link to somewhere on this page is left alone.
  document.addEventListener("click", function (e) {
    var link = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!link || e.defaultPrevented) return;
    var href = link.getAttribute("href") || "";
    var target = (link.getAttribute("target") || "").toLowerCase();
    if (href.charAt(0) === "#" || /^javascript:/i.test(href) || (target && target !== "_self" && target !== "_top" && target !== "_parent")) return;
    e.preventDefault();
    window.open(link.href, "_blank", "noopener,noreferrer");
  });

  // window.__cellReady: "this app has painted", for thumbnail capture.
  //
  // Measured from #app rather than from the SDK, deliberately. The socket
  // being up says nothing about whether the piece has rendered, and the render
  // itself happens in the piece's own client.js — code the kernel does not
  // control and must not require anything of. #app ships empty in the
  // generated page, so "has content, and has stopped changing" is the closest
  // observable thing to a finished first paint.
  //
  // Never set on the legacy whole-file client.html path, which does not
  // include this script: those capture on the reader's timeout instead.
  (function () {
    var app = document.getElementById("app");
    if (!app) return;
    var SETTLE_MS = 250;
    // A piece with a clock or an animation never stops mutating. Past this
    // point the picture is as good as it is going to get.
    var CEILING_MS = 5000;
    var settle = null;
    var done = false;
    function ready() {
      if (done) return;
      done = true;
      clearTimeout(settle);
      observer.disconnect();
      window.__cellReady = true;
      // And tell the page around it, which cannot read the flag across the
      // sandbox, so it can lift its loader. Carries nothing but the word.
      try { window.parent.postMessage({ type: "cell:ready" }, "*"); } catch (e) {}
    }
    var observer = new MutationObserver(function () {
      if (!app.firstChild) return;
      clearTimeout(settle);
      settle = setTimeout(ready, SETTLE_MS);
    });
    observer.observe(app, { childList: true, subtree: true, characterData: true });
    setTimeout(function () { if (app.firstChild) ready(); }, CEILING_MS);
  })();
})();
`;

export class PieceHost {
  state: DurableObjectState;
  env: Env;
  // Keyed by entry module (piece.js, tasks.js): a scheduled tick and a live
  // browser session can be in flight at once and need different entrypoints.
  workers = new Map<string, { entrypoint: any; dispose: () => void; version: number }>();
  // Tasks under way in this object, by name. A schedule is delivered at least
  // once, and a run that outlasts the runtime's deadline is started again
  // beside itself: two runs of one task then take turns at every effect and
  // each reads state the other just wrote.
  runningTasks = new Set<string>();
  pageLogs = { minute: 0, count: 0 };
  // Subscriber wrappers, not bare stubs: capnweb RPC stubs reject property
  // assignment, so the ticket user rides in the wrapper (personal-mode
  // broadcasts go only to the slice owner's sockets).
  subscribers = new Set<{ cb: (s: unknown) => unknown; user: string }>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  // Router (src/index.ts) has already authenticated: service-auth requests
  // arrive with x-kernel-authed: service; /connect arrives with the verified
  // ticket JSON in x-kernel-ticket. The DO trusts these headers because only
  // the router can reach it.
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const identity = request.headers.get("x-kernel-identity");
    if (identity && !this.identity) {
      this.identity = JSON.parse(identity);
      // Persist for alarm wake-ups (cold starts have no router request).
      this.state.storage.put("identity", this.identity).catch(() => {});
    }
    const route = url.pathname.split("/").slice(3).join("/"); // /cells/:id/<route>
    try {
      if (route === "connect") return this.connect(request);
      if (route === "client" && request.method === "GET") return this.clientPage(url, ticketPreview(request));
      if ((route === "client.js" || route === "styles.css" || route === "boot.js") && request.method === "GET") {
        return this.clientAsset(route, ticketPreview(request));
      }
      if (route === "page-log" && request.method === "POST") return this.pageLog(request);
      if (route.startsWith("files/") && request.method === "GET") return this.serveStoredFile(route.slice(6));
      if (route.startsWith("assets/") && request.method === "GET") {
        return this.serveShippedFile(route.slice(7), ticketPreview(request));
      }
      switch (`${request.method} ${route}`) {
        case "PUT files": return this.putFiles(request);
        case "GET files": return this.getFiles();
        case "GET versions": return this.getVersions();
        case "PUT pin": return this.putPin(request);
        case "POST reload": return this.reload();
        case "PUT mode": {
          const { mode, wipe } = (await request.json().catch(() => ({}))) as { mode?: string; wipe?: boolean };
          if (mode !== "shared" && mode !== "personal") return json({ error: "mode must be shared or personal" }, 400);
          await this.state.storage.put("stateMode", mode);
          if (wipe) {
            // Consented wipe on mode change: drop the shared state and every
            // personal slice; connected clients see an empty state.
            const slices = await this.state.storage.list({ prefix: "cellState" });
            await this.state.storage.delete([...slices.keys()]);
            this.broadcast(null);
            this.log("info", `state mode -> ${mode} (state wiped)`);
          } else {
            this.log("info", `state mode -> ${mode}`);
          }
          return json({ ok: true, mode });
        }
        case "GET stored-files": return json({ files: Object.values(await this.fileIndex()) });
        case "POST stored-files": return this.importStoredFile(request);
        case "GET tasks": return json({ tasks: await this.taskNames() });
        case "POST tests": return json(await this.runTests());
        case "GET describe": return json(await this.describeExternal());
        case "GET logs": return this.getLogs(url);
        // What has been timed but not yet reported to the control plane. For operators
        // and the integration test; The control plane never needs to ask.
        case "GET usage": return json({
          pending: Object.values((await this.state.storage.get<Record<string, UsageEntry>>("usage:pending")) ?? {}),
          inflight: (await this.state.storage.get<UsageBatch>("usage:inflight")) ?? null,
        });
        case "GET state": return json({
          // Personal pieces need ?user= (service-auth only reaches here, so
          // the query is as trustworthy as the caller).
          state: await this.currentState(url.searchParams.get("user")),
          meta: await this.meta(),
          mode: await this.stateMode(),
        });
        case "PUT state": return this.putState(request);
        case "DELETE ": return this.destroy();
        default:
          if (route.startsWith("versions/")) return this.versionRoute(request.method, route.slice(9));
          if (request.method === "GET" && route.startsWith("stored-files/")) return this.exportStoredFile(route.slice(13));
          if (request.method === "POST" && route.startsWith("task/")) {
            // The scheduler's entry point, and the builder's "run it now".
            // Unlike rpc/, this resolves against tasks.js rather than the
            // piece's default export, so a schedule can never reach an
            // ordinary reducer. invoker: the person running it by hand (the control plane
            // names them); a schedule names no one.
            const { runId, invoker } = (await request.json().catch(() => ({}))) as { runId?: string; invoker?: unknown };
            return json({
              result: await this.invokeTask(route.slice(5), runId ?? null,
                typeof invoker === "string" || typeof invoker === "number" ? String(invoker) : null),
            });
          }
          if (request.method === "POST" && route.startsWith("rpc/")) {
            const payload = (await request.json().catch(() => ({}))) as { args?: unknown[]; chain?: unknown; user?: string };
            // chain: pieces already visited by this link chain. Threaded into
            // any further call: effects so the control plane can refuse cycles and cap
            // depth. Sanity-capped here as defense in depth.
            const chain = Array.isArray(payload.chain) && payload.chain.every((c) => typeof c === "string")
              ? (payload.chain as string[]) : [];
            if (chain.length > MAX_LINK_CHAIN) return json({ error: "link chain too long" }, 422);
            // This route is the external boundary: the concierge and linked
            // pieces arrive here, while the piece's own UI calls over the
            // WebSocket and schedules go to task/. So the interface gate lives
            // here and nowhere else. The control plane marks its own dev tooling (the
            // builder testing a piece it is writing) internal; service auth
            // already guards the route, so which caller gets that is the control plane's
            // decision to make.
            // Internal callers are working on the piece, so they also get
            // head rather than the pinned version.
            const internal = request.headers.get("x-kernel-scope") === "internal";
            const refusal = internal ? null : await this.interfaceRefusal(route.slice(4));
            if (refusal) return json({ error: refusal }, 403);
            return json({
              result: await this.invoke(route.slice(4), payload.args ?? [], "owner",
                typeof payload.user === "string" ? payload.user : null, chain, internal),
            });
          }
          return json({ error: `no route: ${request.method} /${route}` }, 404);
      }
    } catch (e: any) {
      this.log("error", `${request.method} /${route}: ${e?.message ?? e}`);
      return json({ error: String(e?.message ?? e) }, e?.status ?? 500);
    }
  }

  private async connect(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return json({ error: "websocket upgrade required" }, 426);
    }
    const ticket: Ticket = JSON.parse(request.headers.get("x-kernel-ticket")!);
    this.log("info", `connect user=${ticket.user} role=${ticket.role}`);
    return newWorkersWebSocketRpcResponse(request, new PieceSession(this, ticket));
  }

  // The piece's UI, served ticket-authed on the kernel origin so the the control plane
  // iframe stays cross-origin. Preferred shape: files["client.js"] (+ optional
  // styles.css) — the platform generates the wrapper page, so the CSP needs no
  // 'unsafe-inline' for scripts. Legacy: files["client.html"] served whole.
  // Fallback: generic debug client asset.
  private async clientPage(url: URL, preview: boolean): Promise<Response> {
    const { files } = await this.servedFiles(preview);
    const custom = Boolean(files?.["client.js"]);
    if (custom || !files?.["client.html"]) {
      // The asset query carries only what the SDK needs to reach the socket.
      // Rebuilt rather than passed through: url.search lands inside href/src
      // attributes, so an arbitrary param could close one and inject markup.
      const assetQuery = new URLSearchParams();
      for (const key of ["org", "ticket"]) {
        const value = url.searchParams.get(key);
        if (value !== null) assetQuery.set(key, value);
      }
      const q = `?${assetQuery}`;
      // Theme and scheme ride the client URL (the control plane resolves org default +
      // user preference when it mints the ticket). Both are allow-listed:
      // the values reach a URL and an attribute.
      const requested = url.searchParams.get("theme") ?? "";
      const theme = THEMES.includes(requested) ? requested : DEFAULT_THEME;
      const scheme = url.searchParams.get("scheme");
      // auto (the default) ships no attribute, so the theme's own
      // prefers-color-scheme block decides and follows a live OS change.
      const schemeAttr = scheme === "dark" || scheme === "light" ? ` data-theme="${scheme}"` : "";
      // No client.js: serve the built-in console, which lists the piece's
      // methods and state. Same generated page and same theme as a custom
      // client — a piece whose author skipped the UI still gets a designed one.
      const entry = custom ? `client.js${q}` : "/console.js";
      // Cascade order is the contract: theme tokens, then the kit that
      // consumes them, then the piece's own CSS, which wins every tie.
      const styles =
        `<link rel="stylesheet" href="/ui/themes/${theme}.css">` +
        `<link rel="stylesheet" href="/ui/kit.css">` +
        (custom && files?.["styles.css"] ? `<link rel="stylesheet" href="styles.css${q}">` : "");
      // Body ships an empty #app div (models assume one exists — the top
      // blank-first-render cause) and boot.js, which surfaces client-side
      // exceptions as a visible banner instead of a silent blank page.
      const page = `<!doctype html><html${schemeAttr}><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width,initial-scale=1">` +
        `<title>cell</title>${styles}</head><body>` +
        `<div id="app"></div>` +
        `<script src="boot.js${q}"></script>` +
        `<script type="module" src="${entry}"></script></body></html>`;
      return new Response(page, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:",
        },
      });
    }
    const html = files["client.html"];
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:",
      },
    });
  }

  // Client-side assets (client.js, styles.css) referenced by the wrapper page.
  // Same ticket auth as /client (router gates these routes).
  private async clientAsset(name: string, preview: boolean): Promise<Response> {
    if (name === "boot.js") {
      return new Response(BOOT_SCRIPT, { headers: {
        "content-type": "text/javascript; charset=utf-8",
        "access-control-allow-origin": "*",
      } });
    }
    const { files } = await this.servedFiles(preview);
    const content = files?.[name];
    if (typeof content !== "string") return json({ error: `no such asset: ${name}` }, 404);
    const type = name.endsWith(".css") ? "text/css" : "text/javascript";
    return new Response(content, { headers: {
      "content-type": `${type}; charset=utf-8`,
      // The iframe is sandboxed (opaque origin) and module scripts fetch in
      // CORS mode; auth is the ticket in the URL, not cookies, so * is safe.
      "access-control-allow-origin": "*",
    } });
  }

  // mode "replace" (default) stores exactly what was sent; "merge" writes the
  // sent files over the stored ones and drops the names in `delete`. Merge
  // exists because output size per edit otherwise scales with total piece size:
  // a one-line change made the builder agent re-emit every file, which
  // truncated against its completion-token cap.
  private async putFiles(request: Request): Promise<Response> {
    const { files, mode = "replace", delete: removals = [] } =
      (await request.json()) as { files: Record<string, string>; mode?: string; delete?: string[] };
    if (!files || typeof files !== "object") return json({ error: "files object required" }, 400);
    const sent = legacyModuleRenamed(files); // DEPRECATED: see LEGACY_PIECE_MODULE
    if (mode !== "replace" && mode !== "merge") {
      return json({ error: `mode must be "replace" or "merge"` }, 400);
    }
    if (!Array.isArray(removals)) return json({ error: "delete must be an array of file names" }, 400);
    // DEPRECATED: a caller deleting cell.js means the entry module, whatever it
    // is stored as.
    const drops = removals.map((n) => (n === LEGACY_PIECE_MODULE ? PIECE_MODULE : n));
    // Outside merge mode a delete list would silently do nothing, hiding the
    // caller's mistake — refuse it instead.
    if (drops.length && mode !== "merge") {
      return json({ error: `delete requires mode "merge"` }, 400);
    }

    // Validate what was sent; stored files already passed these checks.
    for (const [name, content] of Object.entries(sent)) {
      if (!validFileName(name)) return json({ error: `bad or reserved file name: ${name}` }, 400);
      if (typeof content !== "string" || content.length > MAX_FILE_BYTES) {
        return json({ error: `file too large or not a string: ${name}` }, 400);
      }
    }
    for (const name of drops) {
      if (typeof name !== "string" || !validFileName(name)) {
        return json({ error: `bad or reserved file name: ${name}` }, 400);
      }
    }

    // Everything below validates the *resulting* file set, which in merge mode
    // is not what was sent.
    let merged = sent;
    if (mode === "merge") {
      const stored = (await this.storedFiles()) ?? {};
      merged = { ...stored, ...sent };
      for (const name of drops) delete merged[name];
    }
    return this.deploy(merged, { via: mode });
  }

  // GET versions/:n — that version's files; POST versions/:n/restore — deploy
  // them again as a new version.
  private async versionRoute(method: string, rest: string): Promise<Response> {
    const match = rest.match(/^(\d+)(\/restore)?$/);
    if (!match) return json({ error: `no route: ${method} /versions/${rest}` }, 404);
    const version = Number(match[1]);
    const resolved = await this.versionFiles(version);
    if (!resolved) return json({ error: `no version ${version}` }, 404);
    const { manifest, files } = resolved;
    if (method === "GET" && !match[2]) return json({ version, ...manifest, files });
    if (method === "POST" && match[2]) {
      // It failed once and its files have not changed: deploying it again
      // would fail the same way and take the piece down for nothing.
      if (manifest.loadError) {
        return json({ error: `version ${version} failed to load and cannot be restored`, loadError: manifest.loadError }, 422);
      }
      return this.deploy(files, { via: `restore of v${version}`, restoredFrom: version });
    }
    return json({ error: `no route: ${method} /versions/${rest}` }, 404);
  }

  // A version's files, rebuilt from blobs; null when there is no such version.
  private async versionFiles(version: number): Promise<{ manifest: VersionManifest; files: Record<string, string> } | null> {
    const manifest = await this.state.storage.get<VersionManifest>(`ver:${version}`);
    if (!manifest) return null;
    const files: Record<string, string> = {};
    for (const [name, sha] of Object.entries(manifest.files)) {
      const content = await this.state.storage.get<string>(`blob:${sha}`);
      if (content === undefined) throw httpError(500, `version ${version}: content of ${name} is missing`);
      files[name] = content;
    }
    return { manifest, files };
  }

  // PUT pin {version} serves that version to everyone who is not previewing;
  // {version: null} serves head again. The control plane decides who may pin; the kernel
  // only refuses a version that does not exist or never loaded.
  private async putPin(request: Request): Promise<Response> {
    const { version } = (await request.json().catch(() => ({}))) as { version?: number | null };
    const meta = await this.meta();
    if (version === null || version === undefined) {
      delete meta.pinnedVersion;
    } else {
      if (!Number.isInteger(version)) return json({ error: "version must be an integer or null" }, 400);
      const resolved = await this.versionFiles(version);
      if (!resolved) return json({ error: `no version ${version}` }, 404);
      if (resolved.manifest.loadError || !resolved.files[PIECE_MODULE]) {
        return json({ error: `version ${version} cannot be served: it failed to load when deployed` }, 422);
      }
      meta.pinnedVersion = version;
    }
    await this.state.storage.put("meta", meta);
    this.dropWorker(); // served isolates are keyed by version; rebuild on demand
    this.log("info", meta.pinnedVersion === undefined ? "unpinned: serving head" : `pinned: serving v${meta.pinnedVersion}`);
    return json({ ok: true, pinnedVersion: meta.pinnedVersion ?? null });
  }

  // What a caller runs. preview (the builder's internal calls, an editor's
  // Studio pane) = head, always. Everyone else = head unless pinned.
  private async servedFiles(preview: boolean): Promise<{ files: Record<string, string> | undefined; version: number }> {
    const meta = await this.meta();
    if (preview || meta.pinnedVersion === undefined) {
      return { files: await this.storedFiles(), version: meta.codeVersion };
    }
    const resolved = await this.versionFiles(meta.pinnedVersion);
    if (!resolved) throw httpError(500, `pinned version ${meta.pinnedVersion} is missing`);
    return { files: resolved.files, version: meta.pinnedVersion };
  }

  // Manifests newest first, without content: enough to list, badge and diff
  // names between versions.
  private async getVersions(): Promise<Response> {
    const stored = await this.state.storage.list<VersionManifest>({ prefix: "ver:" });
    const versions = [...stored]
      .map(([key, manifest]) => ({ version: Number(key.slice(4)), ...manifest }))
      .sort((a, b) => b.version - a.version);
    return json({ versions, meta: await this.meta() });
  }

  // Validates a complete file set, stores it as the next version, and
  // smoke-loads it. via: what to log ("replace", "merge", "restore of v7").
  private async deploy(
    merged: Record<string, string>, { via, restoredFrom }: { via: string; restoredFrom?: number },
  ): Promise<Response> {
    const names = Object.keys(merged);
    if (!names.includes(PIECE_MODULE)) return json({ error: "files['piece.js'] required" }, 400);
    if (names.length > MAX_FILES) return json({ error: `too many files (max ${MAX_FILES})` }, 400);
    // The reducer contract requires an entrypoint-class default export; a
    // plain object loads but every RPC fails opaquely (Phase 0 finding).
    for (const entry of [PIECE_MODULE, TASKS_MODULE]) {
      if (!merged[entry]) continue; // tasks.js is optional
      if (!/export\s+default\s+class/.test(merged[entry])) {
        return json({
          error: `${entry} must \`export default class extends Piece\` ` +
            "(import { Piece } from \"./costa.js\")",
        }, 422);
      }
    }
    // A shipped binary is base64 of what its name says it is, or the page would
    // be handed bytes under a type they are not.
    for (const [name, content] of Object.entries(merged)) {
      const extension = fileExtension(name);
      if (!BINARY_EXTENSIONS.includes(extension)) continue;
      const bytes = base64Bytes(content);
      if (!bytes || detectType(name, bytes) !== FILE_TYPES[extension]) {
        return json({ error: `${name} must be the base64 of a ${extension.toUpperCase()} file` }, 422);
      }
    }
    // Parsed before anything is stored: a piece whose declared surface is
    // malformed must not deploy, or the rpc gate would fall back to "no
    // interface" and quietly expose everything.
    let interfaceSpec: Record<string, InterfaceEntry> | null = null;
    if (merged[INTERFACE_MODULE]) {
      try {
        interfaceSpec = parseInterface(merged[INTERFACE_MODULE]);
      } catch (e: any) {
        return json({ error: String(e?.message ?? e) }, 422);
      }
    }

    const meta = await this.meta();
    const version = meta.codeVersion + 1;
    // History first, head second: a manifest without a head is a version
    // nobody serves; a head without a manifest is a version nobody can undo.
    const shas: Record<string, string> = {};
    for (const [name, content] of Object.entries(merged)) {
      shas[name] = await sha256Hex(content);
      const key = `blob:${shas[name]}`;
      if ((await this.state.storage.get(key)) === undefined) await this.state.storage.put(key, content);
    }
    const manifest: VersionManifest = { files: shas, at: Date.now(), parent: meta.codeVersion };
    if (restoredFrom !== undefined) manifest.restoredFrom = restoredFrom;
    await this.state.storage.put(`ver:${version}`, manifest);
    await this.state.storage.put("files", merged);
    if (interfaceSpec) {
      await this.state.storage.put("interfaceSpec", interfaceSpec);
    } else {
      // Deleting interface.js reopens the surface; leaving a stale spec would
      // keep gating against a file that no longer exists.
      await this.state.storage.delete("interfaceSpec");
    }
    await this.state.storage.put("meta", { ...meta, codeVersion: version, updatedAt: manifest.at } satisfies CellMeta);
    this.dropWorker();
    this.log("info", `deployed codeVersion=${version} (${names.length} files, ${via})`);
    // Smoke-load now so a broken deploy is a deploy error, not a first-use
    // error. celld defers load errors to first use, so probe with a sentinel
    // method: a healthy worker rejects it with "not a function"; anything else
    // (SyntaxError, import failure) is a broken deploy.
    try {
      const { entrypoint } = await this.loadedWorker(PIECE_MODULE, true);
      await entrypoint.__cellsDeployProbe__();
      return json({ ok: true, codeVersion: version, restoredFrom, ...(await this.testedDeploy(version, manifest)) });
    } catch (e: any) {
      const message = String(e?.message ?? e);
      if (/does not implement|not a function/i.test(message)) {
        return json({ ok: true, codeVersion: version, restoredFrom, ...(await this.testedDeploy(version, manifest)) });
      }
      this.log("error", `deploy probe failed: ${message}`);
      await this.state.storage.put(`ver:${version}`, { ...manifest, loadError: message });
      const reverted = await this.revertFrom(version);
      return json({ ok: false, codeVersion: version, restoredFrom, loadError: message, ...(reverted ? { reverted } : {}) }, 422);
    }
  }

  // After a deploy that will not load: put the last version that did load
  // back as head, as a new version, so the piece keeps working and head is
  // still the newest. Nothing to go back to (a first deploy) leaves it as is.
  private async revertFrom(failed: number): Promise<{ codeVersion: number; restoredFrom: number } | null> {
    for (let good = failed - 1; good >= 1; good--) {
      const resolved = await this.versionFiles(good);
      if (!resolved || resolved.manifest.loadError) continue;
      const version = failed + 1;
      const manifest: VersionManifest = { files: resolved.manifest.files, at: Date.now(), parent: failed, restoredFrom: good };
      await this.state.storage.put(`ver:${version}`, manifest);
      await this.state.storage.put("files", resolved.files);
      const declared = resolved.files[INTERFACE_MODULE];
      if (declared) await this.state.storage.put("interfaceSpec", parseInterface(declared));
      else await this.state.storage.delete("interfaceSpec");
      await this.state.storage.put("meta", { ...(await this.meta()), codeVersion: version, updatedAt: manifest.at } satisfies CellMeta);
      this.dropWorker();
      this.log("info", `v${failed} failed to load; v${good} put back as codeVersion=${version}`);
      return { codeVersion: version, restoredFrom: good };
    }
    return null;
  }

  // A deploy runs the piece's own tests and says how they went. It never
  // refuses on them: the builder has to deploy to iterate, and a failing test
  // is what it is iterating on. Nor does a fault in the runner cost a deploy.
  private async testedDeploy(version: number, manifest: VersionManifest): Promise<Record<string, unknown>> {
    try {
      const report = await this.runTests();
      const summary = report.tests as TestSummary | null;
      if (summary) {
        const { total, passed, failed } = summary;
        await this.state.storage.put(`ver:${version}`, { ...manifest, tests: { total, passed, failed } });
        this.log(failed ? "warn" : "info", `tests: ${passed} of ${total} passed`);
      }
      return report;
    } catch (e: any) {
      this.log("error", `tests could not run: ${String(e?.message ?? e)}`);
      return {};
    }
  }

  // The piece's scenarios (tests.js) against head, plus two checks that need
  // none written. Nothing here is saved, broadcast, timed as usage or sent to
  // The control plane: state comes from each scenario and effects are answered from it.
  private async runTests(): Promise<Record<string, unknown>> {
    const files = await this.storedFiles();
    if (!files) throw httpError(409, "no code deployed");
    const dangling = [PIECE_MODULE, TASKS_MODULE].flatMap((module) =>
      danglingContinuations(files[module], scanMethods(files[module]).map((m) => m.name))
        .map((name) => `${module}: then: "${name}" names a method that is not there`));
    if (!files[TESTS_MODULE]) return { tests: null, dangling };

    let scenarios: Scenario[];
    try {
      scenarios = parseTests(files[TESTS_MODULE]);
    } catch (e: any) {
      return { tests: null, error: String(e?.message ?? e), dangling };
    }
    const invoke: Invoke = async (module, method, state, args) => {
      if (!files[module]) throw new Error(`this piece has no ${module}`);
      const { entrypoint } = await this.loadedWorker(module, true);
      try {
        return await entrypoint[method](state, ...args);
      } catch (e: any) {
        const message = String(e?.message ?? e);
        // Same signature invokeReducer reads a missing method from.
        throw new Error(/does not implement|not a function/i.test(message) ? `${module} has no method "${method}"` : message);
      }
    };
    const declared = await this.state.storage.get<Record<string, InterfaceEntry>>("interfaceSpec");
    const entries = [
      ...Object.keys(declared ?? {}).map((method) => ({ module: PIECE_MODULE, method })),
      ...(await this.taskNames()).map((method) => ({ module: TASKS_MODULE, method })),
    ];
    const reached = new Set<string>();
    const tests = await runScenarios(scenarios, invoke, reached);
    return { tests, dangling, untested: untested(reached, entries) };
  }

  // Import a whole shared state, for duplicating a cell. Refused on personal
  // pieces: their data is per-user slices that belong to the people who made
  // them, and there is no coherent way to hand one person's slice to a copy.
  private async putState(request: Request): Promise<Response> {
    if ((await this.stateMode()) === "personal") {
      return json({ error: "this cell keeps personal state; state cannot be imported" }, 422);
    }
    const { state } = (await request.json().catch(() => ({}))) as { state?: unknown };
    if (state === undefined) return json({ error: "state required" }, 400);

    await this.state.storage.put("cellState", state);
    this.broadcast(state);
    this.log("info", "state imported");
    return json({ ok: true });
  }

  // Stored file set, with the pre-rename entry module mapped onto the current
  // one. DEPRECATED shim: see LEGACY_PIECE_MODULE.
  private async storedFiles(): Promise<Record<string, string> | undefined> {
    const files = await this.state.storage.get<Record<string, string>>("files");
    return files && legacyModuleRenamed(files);
  }

  private async getFiles(): Promise<Response> {
    return json({
      files: (await this.storedFiles()) ?? null,
      meta: await this.meta(),
    });
  }

  private async reload(): Promise<Response> {
    this.dropWorker();
    await this.loadedWorker(PIECE_MODULE, true);
    return json({ ok: true, codeVersion: (await this.meta()).codeVersion });
  }

  private async getLogs(url: URL): Promise<Response> {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, MAX_LOG_LINES);
    const lines: string[] = (await this.state.storage.get("logs")) ?? [];
    return json({ lines: lines.slice(-limit) });
  }

  // Scheduled work lives in its own tasks.js module rather than among the
  // piece's reducers. That is a discoverability decision as much as a safety
  // one: "what runs when nobody is watching" is the first question asked of a
  // piece that surprises someone, and it should be answerable by opening one
  // file. The scheduler DO owns the timing; this is only the entry point.
  //
  // A task has the reducer contract — (state) -> {state?, result?, effect?} —
  // so effects, continuations and the control plane mediation work exactly as they do for
  // an interactive call. There is no viewer: the tick runs as the piece owner,
  // resolved on the control plane's side.
  private async invokeTask(task: string, runId: string | null, invoker: string | null = null): Promise<unknown> {
    if (!/^[a-zA-Z]\w*$/.test(task)) throw httpError(400, `invalid task name: ${task}`);
    // One run of a task at a time, and each scheduled run once. Checked and
    // claimed before the first await, so nothing can slip in between.
    if (this.runningTasks.has(task)) {
      this.log("info", `task ${task} is already running; not started again${runId ? ` (run ${runId})` : ""}`);
      return { skipped: "already running" };
    }
    this.runningTasks.add(task);
    try {
      if (runId) {
        if ((await this.state.storage.get<string>(`ran:${task}`)) === runId) {
          this.log("info", `task ${task} already ran as ${runId}; not run again`);
          return { skipped: "already ran" };
        }
        await this.state.storage.put(`ran:${task}`, runId);
      }
      return await this.runTask(task, runId, invoker);
    } finally {
      this.runningTasks.delete(task);
    }
  }

  private async runTask(task: string, runId: string | null, invoker: string | null): Promise<unknown> {
    // Alarms reach this DO without a router request, so identity may be cold.
    this.identity ??= (await this.state.storage.get("identity")) ?? null;
    const { files } = await this.servedFiles(false);
    if (!files?.["tasks.js"]) {
      throw httpError(404, `this cell has no tasks.js, so there is no task "${task}" to run`);
    }
    this.log("info", `task ${task} starting${runId ? ` (run ${runId})` : ""}`);
    try {
      const result = await this.invokeReducer(task, [], 0, invoker, [], TASKS_MODULE);
      this.log("info", `task ${task} finished`);
      return result;
    } finally {
      // A scheduled run is reported when it ends, not up to a minute later:
      // nobody is around to keep the piece busy until the next flush.
      await this.flushUsage().catch(() => {});
    }
  }

  // Task names for the registration check and the connections tab. Read from
  // source: the loader hands back an RPC stub, whose properties can't be
  // enumerated, and loading an isolate only to ask "what could be scheduled?"
  // is a poor trade. Advisory only — invokeTask's own lookup is what decides
  // whether a task exists, so a name this misses still runs.
  private async taskNames(): Promise<string[]> {
    const files = await this.storedFiles();
    return scanMethods(files?.[TASKS_MODULE]).map((m) => m.name);
  }

  // What a client can call, for the default console: method names and their
  // declared parameters, minus the leading state argument every reducer takes.
  // Same source-scraping caveat as taskNames — advisory, not authoritative.
  async describe(preview = false): Promise<{ name: string; params: string[] }[]> {
    const { files } = await this.servedFiles(preview);
    return scanMethods(files?.[PIECE_MODULE]).map(({ name, params }) => ({
      name,
      params: params.slice(1),
    }));
  }

  // What an OUTSIDE caller may invoke, for the concierge and linked cells.
  // Declared entries when the piece ships an interface.js — descriptions and
  // all, so an agent reads what a method is for instead of guessing from its
  // name. Otherwise the scanned names, which is what every piece written before
  // interface.js existed still offers.
  private async describeExternal(): Promise<{
    methods: { name: string; description?: string; params?: unknown }[];
    declared: boolean;
  }> {
    const spec = await this.servedInterfaceSpec();
    if (!spec) {
      return { methods: await this.describe(), declared: false };
    }
    return {
      methods: Object.entries(spec).map(([name, entry]) => ({
        name,
        description: entry.description,
        ...(entry.params ? { params: entry.params } : {}),
      })),
      declared: true,
    };
  }

  // Why this call may not proceed, or null to allow it. A piece with no
  // interface.js declares nothing and refuses nothing — the surface it had
  // before this file existed.
  private async interfaceRefusal(method: string): Promise<string | null> {
    const spec = await this.servedInterfaceSpec();
    if (!spec || Object.hasOwn(spec, method)) return null;

    const offered = Object.keys(spec);
    return `"${method}" is not in this cell's interface` +
      (offered.length ? ` (it offers: ${offered.join(", ")})` : " (it offers nothing)");
  }

  // The stored spec is head's (parsed at deploy). Under a pin the gate is the
  // pinned version's interface.js — the surface people are actually using.
  private async servedInterfaceSpec(): Promise<Record<string, InterfaceEntry> | null> {
    const meta = await this.meta();
    if (meta.pinnedVersion === undefined) {
      return (await this.state.storage.get<Record<string, InterfaceEntry>>("interfaceSpec")) ?? null;
    }
    const { files } = await this.servedFiles(false);
    const source = files?.[INTERFACE_MODULE];
    return source ? parseInterface(source) : null; // parsed once at deploy, so it parses
  }

  private async destroy(): Promise<Response> {
    this.dropWorker();
    this.subscribers.clear();
    await this.state.storage.deleteAll();
    this.log = () => {}; // storage is gone; drop further writes
    return json({ ok: true });
  }

  // role: least privilege of the caller. Every role — viewer included — may
  // call any method: "viewer" means "can use the app, cannot modify the
  // piece", and modification (deploy, connections, sharing) is gated in the control plane
  // before a ticket is ever minted. The role still reaches the client via
  // whoami() so UIs can tailor what they show.
  // invoker: user id for effect attribution (ticket user, or service caller).
  // chain: pieces already visited when this invocation is part of a link
  // chain — forwarded on further call: effects so the control plane can refuse cycles.
  // preview: run head rather than the pinned version (see servedFiles).
  async invoke(method: string, args: unknown[], role: Ticket["role"], invoker: string | null = null, chain: string[] = [], preview = false): Promise<unknown> {
    if (typeof method !== "string" || !/^[a-zA-Z]\w*$/.test(method)) {
      throw httpError(400, `invalid method: ${method}`);
    }
    return this.invokeReducer(method, args, 0, invoker, chain, PIECE_MODULE, preview);
  }

  // mainModule: which file owns the method. Interactive calls run piece.js;
  // scheduled ticks run tasks.js. Effects and continuations stay within the
  // module they started in, so a task's `then:` resolves against tasks.js.
  private async invokeReducer(method: string, args: unknown[], depth: number, invoker: string | null = null, chain: string[] = [], mainModule: string = PIECE_MODULE, preview = false): Promise<unknown> {
    const key = await this.stateKey(invoker);
    const state = (await this.state.storage.get(key)) ?? null;
    const { entrypoint } = await this.loadedWorker(mainModule, preview);
    let r: any;
    // Timed around the piece's own code only. It has no network and its
    // effects run after it returns, so this is close to compute time (celld's
    // clock is not frozen during execution, unlike workerd's). Waiting for a
    // free isolate slot is included; effects and the control plane calls are not.
    const started = Date.now();
    try {
      r = await entrypoint[method](state, ...args);
    } catch (e: any) {
      const message = String(e?.message ?? e);
      // A missing method can't be detected by inspecting the stub — the
      // loader hands back an RPC proxy whose properties all look present, and
      // the absence only surfaces when the call crosses the boundary. Same
      // signature the deploy probe relies on.
      if (/does not implement|not a function/i.test(message)) {
        throw httpError(404, `${mainModule} has no method "${method}"`);
      }
      this.log("error", `rpc ${method}: ${message}`);
      throw httpError(422, `cell method ${method} failed: ${message}`);
    } finally {
      // Background only when nobody started it: a task run by hand is the
      // person's own work.
      await this.recordUsage(invoker, mainModule === TASKS_MODULE && invoker === null, Date.now() - started).catch(() => {});
    }
    if (r && typeof r === "object" && "state" in r) {
      await this.state.storage.put(key, r.state);
      this.broadcast(r.state, key === "cellState" ? null : invoker);
    }
    if (r && typeof r === "object" && r.effect) {
      return this.runEffect(r.effect, r.result ?? null, depth, invoker, chain, mainModule, preview);
    }
    if (r && typeof r === "object" && ("state" in r || "result" in r)) return r.result ?? null;
    return r ?? null;
  }

  // Effects: reducers stay pure; I/O runs here, mediated by the control plane. Shapes:
  //   { effect: { fetch: url, method?, then } }   -> {status, body, json} | {error}
  //   { effect: { search: query, then } }         -> {results: [...]} | {error}
  //   { effect: { extract: url, then } }          -> {markdown, title} | {error}
  //   { effect: { call: {piece, method, args?}, then } } -> {result} | {error}
  //   { effect: { mcp: {server, tool, args?}, then } }  -> {result} | {error}
  //   { effect: { notify: {text, via?}, then } }  -> {sent, via} | {error}
  //     Says something to the piece's OWNER, by text or Slack DM. There is no
  //     recipient to pass: The control plane resolves it from who owns the piece, so an
  //     injected page cannot redirect it. via defaults to the grant's first.
  //   { effect: { browser: {...}, then } } -- a real browser, one action per
  //     effect so each passes the control plane's allowlist check:
  //       {scrape: url, format?}          -> {content, title, url}
  //       {screenshot: url, fullPage?}    -> {image_url, url}
  //       {session: "create"}             -> {session, expires_in_minutes}
  //       {session: id, release: true}    -> {session, status}
  //       {session: id, goto: url}        -> {url, title}
  //       {session: id, read: true, format?} -> {url, title, content}
  //       {session: id, act: {type, selector, text?|key?|value?}}
  //                                       -> {acted, url_before, url}
  //       {session: id, liveView: true}   -> {login_url, expires_in_minutes}
  // The continuation reducer receives the outcome as its first arg after
  // state. Bounded chain depth stops runaway loops.
  private async runEffect(effect: any, result: unknown, depth: number, invoker: string | null = null, chain: string[] = [], mainModule: string = PIECE_MODULE, preview = false): Promise<unknown> {
    if (depth >= MAX_EFFECT_DEPTH) throw httpError(422, "effect chain too deep");
    const then = effect?.then;
    if (typeof then !== "string" || !/^[a-zA-Z]\w*$/.test(then)) {
      throw httpError(422, "invalid effect: missing continuation reducer name in `then`");
    }
    // Kept in the piece, so answered here: The control plane has nothing to add.
    if (typeof effect.read === "string") {
      const outcome = await this.readStoredFile(effect.read);
      this.log("info", `effect read ${effect.read} -> ${outcome.error ? `failed: ${outcome.error}` : "ok"}`);
      return this.invokeReducer(then, [outcome], depth + 1, invoker, chain, mainModule, preview);
    }
    if (Array.isArray(effect.remove)) {
      const outcome = { removed: await this.removeStoredFiles(effect.remove.filter((id: unknown) => typeof id === "string")) };
      this.log("info", `effect remove -> ${outcome.removed}`);
      return this.invokeReducer(then, [outcome], depth + 1, invoker, chain, mainModule, preview);
    }
    let payload: Record<string, unknown>;
    // save: and preview: fetch through the control plane like any web effect; what comes
    // back is stored here and the continuation gets refs, never bytes.
    const saving = typeof effect.save === "string" ? [effect.save] : effect.save;
    if (Array.isArray(saving) || Array.isArray(effect.preview)) {
      const kind = Array.isArray(saving) ? "save" : "preview";
      const urls = (kind === "save" ? saving : effect.preview).filter((u: unknown) => typeof u === "string");
      if (urls.length === 0 || urls.length > MAX_EFFECT_URLS) {
        throw httpError(422, `invalid effect: ${kind}: takes 1 to ${MAX_EFFECT_URLS} URLs`);
      }
      payload = { kind, urls };
    } else if (typeof effect.fetch === "string") {
      payload = { kind: "fetch", url: effect.fetch, method: effect.method ?? "GET" };
    } else if (typeof effect.search === "string") {
      // since: only results from the past day, week or month. The control plane refuses anything else.
      payload = { kind: "search", query: effect.search, since: typeof effect.since === "string" ? effect.since : undefined };
    } else if (typeof effect.extract === "string") {
      payload = { kind: "extract", url: effect.extract };
    } else if (effect.llm && typeof effect.llm === "object" && typeof effect.llm.prompt === "string") {
      payload = { kind: "llm", prompt: effect.llm.prompt, system: effect.llm.system ?? null };
    } else if (effect.mcp && typeof effect.mcp === "object" && typeof effect.mcp.server === "string"
        && typeof effect.mcp.tool === "string") {
      // MCP tools take NAMED arguments (an object), unlike call:'s positional
      // array. The control plane resolves the credential per invoker.
      payload = { kind: "mcp", server: effect.mcp.server, tool: effect.mcp.tool, args: effect.mcp.args ?? {} };
    } else if (effect.call && typeof effect.call === "object" && typeof effect.call.cell === "string"
        && typeof effect.call.method === "string") {
      // Link chains are allowed; the visited-piece chain rides along so the control plane
      // can refuse cycles and cap depth (a refusal comes back as {error} to
      // the continuation, never a throw).
      payload = { kind: "cell_link", target: effect.call.cell, method: effect.call.method, args: effect.call.args ?? [], chain };
    } else if (effect.browser && typeof effect.browser === "object") {
      payload = browserPayload(effect.browser);
    } else if (effect.notify && typeof effect.notify === "object" && typeof effect.notify.text === "string") {
      // No recipient field, deliberately. The control plane sends to the piece's owner.
      payload = { kind: "notify", text: effect.notify.text, via: effect.notify.via ?? null };
    } else {
      throw httpError(422, "invalid effect: expected fetch:, search:, extract:, save:, preview:, read:, remove:, llm:, call:, mcp:, browser:, or notify:");
    }
    if (invoker) payload.invoker = invoker;
    let outcome = await this.controlEffect(payload);
    if (payload.kind === "save" || payload.kind === "preview") {
      outcome = await this.keepFetched(outcome, {
        by: invoker, expiresDays: effect.expires, single: typeof effect.save === "string",
      });
    }
    const target = payload.url ?? payload.query ?? payload.target ?? payload.tool ?? payload.via ?? payload.kind;
    this.log("info", `effect ${payload.kind} ${target} -> ${outcome.error ? `denied: ${outcome.error}` : "ok"}`);
    return this.invokeReducer(then, [outcome], depth + 1, invoker, chain, mainModule, preview);
  }

  private async controlEffect(payload: Record<string, unknown>): Promise<any> {
    const controlUrl = this.env.CONTROL_URL ?? this.env.RAILS_URL;
    if (!controlUrl) return { error: "platform effects are not configured" };
    const [org, cellUuid] = this.orgAndCell();
    const body = JSON.stringify(payload);
    const noun = controlNoun(this.env);
    const path = `/api/v1/${noun}/${cellUuid}/fetch`;
    const auth = await serviceAuthHeader(
      this.env.KERNEL_SECRET, "POST", `/${org}/${noun}/${cellUuid}/fetch`, new TextEncoder().encode(body),
    );
    try {
      const res = await fetch(`${controlUrl}${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth, "x-kernel-org": org },
        body,
      });
      const parsed: any = await res.json().catch(() => ({ error: `bad response (${res.status})` }));
      if (!res.ok) return { error: parsed.error ?? `platform fetch failed (${res.status})` };
      return parsed;
    } catch (e: any) {
      return { error: `platform fetch unreachable: ${e?.message ?? e}` };
    }
  }

  // --- files ---------------------------------------------------------------

  private async fileIndex(): Promise<Record<string, StoredFile>> {
    return (await this.state.storage.get<Record<string, StoredFile>>("fileIndex")) ?? {};
  }

  // The one way bytes get in: an upload, a save, an import. The type is read
  // from the bytes, so a name cannot make a file something it is not.
  async storeFile(
    name: string, bytes: Uint8Array,
    { by = null, source, expiresDays }: { by?: string | null; source?: string; expiresDays?: unknown } = {},
  ): Promise<FileRef> {
    if (!(bytes instanceof Uint8Array) || bytes.length === 0) throw httpError(400, "a file needs bytes");
    if (bytes.length > MAX_STORED_FILE_BYTES) {
      throw httpError(413, `file too large (max ${MAX_STORED_FILE_BYTES / 1_000_000} MB)`);
    }
    const safeName = String(name ?? "").replace(/[^\w.-]+/g, "_").slice(-100) || "file";
    const type = detectType(safeName, bytes);
    if (!type) {
      throw httpError(415, `unsupported file type: ${safeName} (pieces keep ${Object.keys(FILE_TYPES).join(", ")})`);
    }
    const id = (await sha256Hex(bytes)).slice(0, 32);
    const now = Date.now();
    const index = await this.fileIndex();
    // Expired files go on the way in, so a cache that says "30 days" does not
    // need its own alarm.
    const expired = Object.values(index).filter((file) => file.expires !== undefined && file.expires < now);
    for (const file of expired) delete index[file.id];
    if (expired.length) await this.state.storage.delete(expired.map((file) => `filedata:${file.id}`));

    const days = typeof expiresDays === "number" && expiresDays > 0 ? expiresDays : null;
    const expires = days ? now + days * 86_400_000 : undefined;
    const held = index[id];
    if (!held) {
      const total = Object.values(index).reduce((sum, file) => sum + file.bytes, 0);
      if (Object.keys(index).length >= MAX_STORED_FILES || total + bytes.length > MAX_STORED_BYTES) {
        throw httpError(507, `this piece's file storage is full (${MAX_STORED_FILES} files, ${MAX_STORED_BYTES / 1_000_000} MB)`);
      }
      await this.state.storage.put(`filedata:${id}`, bytes);
    }
    // Saving the same bytes again keeps the one copy and whichever lifetime is
    // longer: something kept for good stays kept.
    const file: StoredFile = held
      ? { ...held, expires: held.expires === undefined || expires === undefined ? undefined : Math.max(held.expires, expires) }
      : { id, name: safeName, type, bytes: bytes.length, at: now, by, ...(source ? { source } : {}), ...(expires ? { expires } : {}) };
    if (file.expires === undefined) delete file.expires;
    index[id] = file;
    await this.state.storage.put("fileIndex", index);
    return { id, name: file.name, type: file.type, bytes: file.bytes };
  }

  private async removeStoredFiles(ids: string[]): Promise<number> {
    const index = await this.fileIndex();
    const found = ids.filter((id) => index[id]);
    if (found.length === 0) return 0;
    for (const id of found) delete index[id];
    await this.state.storage.delete(found.map((id) => `filedata:${id}`));
    await this.state.storage.put("fileIndex", index);
    return found.length;
  }

  // read: gives a reducer the text of a file it holds (a CSV someone
  // uploaded). Text only: bytes have no place in a reducer's arguments.
  private async readStoredFile(id: string): Promise<{ text?: string; type?: string; error?: string }> {
    const file = (await this.fileIndex())[id];
    if (!file) return { error: `no such file: ${id}` };
    if (!TEXT_TYPES.test(file.type)) {
      return { error: `${file.name} is ${file.type}, which cannot be read as text` };
    }
    const bytes = await this.state.storage.get<Uint8Array>(`filedata:${id}`);
    if (!bytes) return { error: `no such file: ${id}` };
    return { text: new TextDecoder().decode(bytes), type: file.type };
  }

  // Turns what the control plane fetched ({name, base64} per URL) into stored files. One
  // file failing to store costs that file, not the batch.
  private async keepFetched(
    outcome: any, { by, expiresDays, single }: { by: string | null; expiresDays?: unknown; single: boolean },
  ): Promise<any> {
    if (!outcome || outcome.error) return outcome;
    const keep = async (fetched: any, source: string): Promise<{ file?: FileRef; error?: string }> => {
      if (!fetched || typeof fetched.base64 !== "string") return {};
      const bytes = base64Bytes(fetched.base64);
      if (!bytes) return { error: "bad file data" };
      try {
        return { file: await this.storeFile(fetched.name, bytes, { by, source, expiresDays }) };
      } catch (e: any) {
        return { error: String(e?.message ?? e) };
      }
    };
    if (Array.isArray(outcome.previews)) {
      const previews = [];
      for (const entry of outcome.previews) {
        const { image, ...rest } = entry;
        const kept = await keep(image, image?.url ?? entry.url);
        previews.push({ ...rest, image: kept.file ?? null });
      }
      return { previews };
    }
    const files = [];
    for (const entry of Array.isArray(outcome.files) ? outcome.files : []) {
      if (entry.error) { files.push({ url: entry.url, error: entry.error }); continue; }
      const kept = await keep(entry, entry.url);
      files.push(kept.file ? { url: entry.url, file: kept.file } : { url: entry.url, error: kept.error ?? "nothing fetched" });
    }
    if (single) return files[0]?.file ? { file: files[0].file } : { error: files[0]?.error ?? "nothing fetched" };
    return { files };
  }

  private async serveStoredFile(id: string): Promise<Response> {
    const file = (await this.fileIndex())[id];
    const bytes = file && await this.state.storage.get<Uint8Array>(`filedata:${id}`);
    if (!file || !bytes) return json({ error: `no such file: ${id}` }, 404);
    return fileResponse(file.name, file.type, bytes);
  }

  private async serveShippedFile(name: string, preview: boolean): Promise<Response> {
    const { files } = await this.servedFiles(preview);
    const content = files?.[name];
    const extension = fileExtension(name);
    const type = FILE_TYPES[extension];
    if (typeof content !== "string" || !type) return json({ error: `no such asset: ${name}` }, 404);
    const bytes = BINARY_EXTENSIONS.includes(extension) ? base64Bytes(content) : new TextEncoder().encode(content);
    if (!bytes) return json({ error: `no such asset: ${name}` }, 404);
    return fileResponse(name.split("/").pop()!, type, bytes);
  }

  // The control plane puts a file in: copying a piece's data, or the builder adding one.
  private async importStoredFile(request: Request): Promise<Response> {
    const { name, base64, by, source, expires } = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const bytes = typeof base64 === "string" ? base64Bytes(base64) : null;
    if (typeof name !== "string" || !bytes) return json({ error: "name and base64 required" }, 400);
    const file = await this.storeFile(name, bytes, {
      by: typeof by === "string" ? by : null,
      source: typeof source === "string" ? source : undefined,
      expiresDays: expires,
    });
    return json({ file });
  }

  private async exportStoredFile(id: string): Promise<Response> {
    const file = (await this.fileIndex())[id];
    const bytes = file && await this.state.storage.get<Uint8Array>(`filedata:${id}`);
    if (!file || !bytes) return json({ error: `no such file: ${id}` }, 404);
    return json({ file, base64: bytesBase64(bytes) });
  }

  // --- usage ---------------------------------------------------------------

  private async recordUsage(invoker: string | null, task: boolean, ms: number): Promise<void> {
    const pending = (await this.state.storage.get<Record<string, UsageEntry>>("usage:pending")) ?? {};
    const key = `${task ? "task" : "call"}:${invoker ?? ""}`;
    const entry = pending[key] ?? { invoker, task, calls: 0, ms: 0 };
    entry.calls += 1;
    entry.ms += Math.max(0, ms);
    pending[key] = entry;
    await this.state.storage.put("usage:pending", pending);
    if ((await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + USAGE_FLUSH_MS);
    }
  }

  // The only alarm a PieceHost sets (schedules live in SchedulerHost).
  async alarm(): Promise<void> {
    await this.flushUsage();
  }

  // Reports one batch at a time. A batch keeps its id until the control plane takes it,
  // so a retry after a failed or lost response is charged once; usage timed
  // meanwhile waits in pending for the next batch.
  private async flushUsage(): Promise<void> {
    this.identity ??= (await this.state.storage.get("identity")) ?? null;
    let inflight = await this.state.storage.get<UsageBatch>("usage:inflight");
    if (!inflight) {
      const pending = await this.state.storage.get<Record<string, UsageEntry>>("usage:pending");
      if (!pending || Object.keys(pending).length === 0) return;
      inflight = { batch: crypto.randomUUID(), entries: Object.values(pending) };
      await this.state.storage.put("usage:inflight", inflight);
      await this.state.storage.delete("usage:pending");
    }
    const delivered = await this.postUsage(inflight);
    if (delivered) await this.state.storage.delete("usage:inflight");
    const more = !delivered || (await this.state.storage.get("usage:pending")) !== undefined;
    if (more && (await this.state.storage.getAlarm()) === null) {
      await this.state.storage.setAlarm(Date.now() + USAGE_FLUSH_MS);
    }
  }

  private async postUsage(batch: UsageBatch): Promise<boolean> {
    const controlUrl = this.env.CONTROL_URL ?? this.env.RAILS_URL;
    if (!controlUrl || !this.identity) return true; // nowhere to report: drop rather than pile up
    const [org, cellUuid] = this.orgAndCell();
    const body = JSON.stringify(batch);
    const auth = await serviceAuthHeader(
      this.env.KERNEL_SECRET, "POST", `/${org}/${controlNoun(this.env)}/${cellUuid}/usage`, new TextEncoder().encode(body),
    );
    try {
      const res = await fetch(`${controlUrl}/api/v1/${controlNoun(this.env)}/${cellUuid}/usage`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: auth, "x-kernel-org": org },
        body,
      });
      if (res.ok) return true;
      // Refused (bad signature, unknown piece): sending it again will not
      // change the answer, so it is dropped. The control plane being down is retried.
      this.log("warn", `usage report ${res.status >= 500 ? "failed" : "refused"} (${res.status})`);
      return res.status < 500;
    } catch (e: any) {
      this.log("warn", `usage report unreachable: ${e?.message ?? e}`);
      return false;
    }
  }

  // DO name is `${org}:${cellUuid}`; recover both for the control plane calls. Stored at
  // first request because idFromName is one-way.
  private orgAndCell(): [string, string] {
    if (!this.identity) throw httpError(500, "cell identity not initialized");
    return this.identity;
  }
  identity: [string, string] | null = null;

  // State mode (the control plane is the source of truth, PUT mode): "shared" = one
  // collaborative state; "personal" = per-user slices keyed by user id.
  // Reducers never know which — arg 1 is always "the state".
  private async stateMode(): Promise<string> {
    return (await this.state.storage.get<string>("stateMode")) ?? "shared";
  }

  private async stateKey(user: string | null): Promise<string> {
    if ((await this.stateMode()) !== "personal") return "cellState";
    if (!user) throw httpError(422, "this cell keeps personal state; the call must carry a user");
    return `cellState:${user}`;
  }

  async currentState(user: string | null = null): Promise<unknown> {
    return (await this.state.storage.get(await this.stateKey(user))) ?? null;
  }

  // One isolate per entry module and version: piece.js for interactive calls,
  // tasks.js for scheduled ticks; under a pin, the served version and head
  // coexist. All see the same zero-egress rules — the split is about which
  // file's exports are reachable, not about trust. Deploys, pins and reloads
  // drop every isolate; nothing else does.
  private async loadedWorker(mainModule: string = PIECE_MODULE, preview = false) {
    const { files, version } = await this.servedFiles(preview);
    const key = `${mainModule}@${version}`;
    const live = this.workers.get(key);
    if (live) return live;
    if (!files) throw httpError(409, "no code deployed");
    if (!files[mainModule]) throw httpError(404, `this cell has no ${mainModule}`);
    const stub = this.env.LOADER.load({
      compatibilityDate: "2026-01-01",
      mainModule,
      modules: { ...codeModules(files), "costa.js": COSTA_MODULE },
      env: { CELL_ID: this.state.id.toString() },
      globalOutbound: null, // zero egress: the sandbox invariant
      // A reducer is a few milliseconds of work. One that spins is stopped
      // here, where before celld 0.6 it held a worker thread until restart.
      limits: { cpuMs: PIECE_CPU_MS },
    });
    const worker = {
      entrypoint: stub.getEntrypoint(),
      dispose: () => stub.dispose(),
      version,
    };
    this.workers.set(key, worker);
    return worker;
  }

  private dropWorker() {
    for (const worker of this.workers.values()) worker.dispose();
    this.workers.clear();
  }

  private async meta(): Promise<CellMeta> {
    return (await this.state.storage.get("meta")) ?? { codeVersion: 0, updatedAt: 0 };
  }

  // user null = shared state (everyone); otherwise only that user's tabs.
  broadcast(state: unknown, user: string | null = null) {
    for (const sub of this.subscribers) {
      if (user !== null && sub.user !== user) continue;
      Promise.resolve(sub.cb(state)).catch(() => this.subscribers.delete(sub));
    }
  }

  // Ring buffer in DO storage so the builder agent can read recent activity.
  // Fire-and-forget; log writes must never fail a request.
  // What went wrong in the piece's page, as the page itself reports it
  // (BOOT_SCRIPT): an uncaught error, a console.error, something the browser
  // blocked. Kept with the server's log lines at level "page", so whoever is
  // building the piece reads both in one place. A page is not trusted to be
  // brief: so many a minute, each cut short.
  private async pageLog(request: Request): Promise<Response> {
    const minute = Math.floor(Date.now() / 60_000);
    if (this.pageLogs.minute !== minute) this.pageLogs = { minute, count: 0 };
    if (++this.pageLogs.count <= MAX_PAGE_LOGS_PER_MINUTE) {
      const text = (await request.text().catch(() => "")).slice(0, 2_000);
      let kind = "error";
      let message = text;
      try {
        const parsed = JSON.parse(text);
        if (typeof parsed?.kind === "string") kind = parsed.kind.replace(/[^a-z.]/gi, "").slice(0, 24) || "error";
        if (typeof parsed?.message === "string") message = parsed.message;
      } catch {}
      if (message.trim()) this.log("page", `${kind}: ${message.replace(/\s+/g, " ").trim().slice(0, 600)}`);
    }
    // The page is sandboxed to an origin of its own and cannot read this.
    return new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } });
  }

  log(level: string, message: string) {
    const line = `${new Date().toISOString()} ${level} ${message}`.slice(0, 1000);
    this.state.storage.get<string[]>("logs").then((lines) => {
      const next = [...(lines ?? []), line].slice(-MAX_LOG_LINES);
      return this.state.storage.put("logs", next);
    }).catch(() => {});
  }
}

export interface Env {
  CELL_HOST: DurableObjectNamespace;
  SCHEDULER_HOST: DurableObjectNamespace;
  LOADER: any;
  KERNEL_SECRET: string;
  CONTROL_URL?: string; // where effects, usage and schedule status are sent; unset disables effects
  RAILS_URL?: string; // the same, under its older name
}

// The control plane is called back at /api/v1/pieces/... A control plane still
// set by the older name, RAILS_URL, is one that still answers at /cells/.
export function controlNoun(env: Env): "pieces" | "cells" {
  return env.CONTROL_URL ? "pieces" : "cells";
}

// One browser effect -> one effect kind for the control plane. Deliberately one action per
// effect: batching would let a later action run on a page an earlier one
// navigated to without the control plane checking the allowlist in between.
//
// `format` and `action` are renamed on the wire (content_format,
// browser_action) because the control plane owns both of those param names — a payload
// using them would arrive as the controller action and the response format.
function browserPayload(b: any): Record<string, unknown> {
  if (typeof b.scrape === "string") {
    return { kind: "browser_scrape", url: b.scrape, content_format: b.format ?? null };
  }
  if (typeof b.screenshot === "string") {
    return { kind: "browser_screenshot", url: b.screenshot, full_page: b.fullPage === true };
  }
  if (b.session === "create") return { kind: "browser_session" };
  if (typeof b.session === "string" && b.session.length > 0) {
    if (b.release === true) return { kind: "browser_session", session: b.session, release: true };
    // Hand the browser to a person: returns a URL they open to drive this
    // session themselves (logging in, clearing a challenge). The piece shows
    // the link; it never gets control of the viewer itself.
    if (b.liveView === true) return { kind: "browser_live_view", session: b.session };
    if (typeof b.goto === "string") return { kind: "browser_goto", session: b.session, url: b.goto };
    if (b.read === true) {
      return { kind: "browser_read", session: b.session, content_format: b.format ?? null };
    }
    if (b.act && typeof b.act === "object" && typeof b.act.type === "string") {
      return { kind: "browser_act", session: b.session, browser_action: b.act };
    }
    throw httpError(422, "invalid browser effect: session needs goto:, read: true, act:, liveView: true, or release: true");
  }
  throw httpError(422, "invalid browser effect: expected scrape:, screenshot:, or session:");
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot < 0 ? "" : name.slice(dot + 1).toLowerCase();
}

// The isolate gets code. A base64 image is not a module, and at 1 MB each a
// few of them would eat the loader's budget for nothing.
function codeModules(files: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(files).filter(([name]) => !BINARY_EXTENSIONS.includes(fileExtension(name))));
}

function base64Bytes(text: string): Uint8Array | null {
  try {
    const raw = atob(text.replace(/\s+/g, ""));
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

function bytesBase64(bytes: Uint8Array): string {
  let raw = "";
  for (let i = 0; i < bytes.length; i += 0x8000) raw += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(raw);
}

// The type a file may be served as, or null to refuse it. Binary types are
// recognised by their leading bytes, whatever the name says. Text types have
// no signature, so the name's extension picks one — but only for bytes that
// are text, so an executable renamed notes.txt is still refused.
function detectType(name: string, bytes: Uint8Array): string | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (ascii(0, 4) === "GIF8") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(4, 8) === "ftyp" && /^(avif|avis)$/.test(ascii(8, 12))) return "image/avif";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";

  const extension = fileExtension(name);
  if (BINARY_EXTENSIONS.includes(extension) || !FILE_TYPES[extension]) return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.includes("\0")) return null;
  if (extension === "svg" && !/<svg[\s>]/i.test(text)) return null;
  return FILE_TYPES[extension];
}

// Every file leaves with the same locks: the browser may not guess a type,
// and a file opened on its own (an SVG, a PDF) runs nothing.
function fileResponse(name: string, type: string, bytes: Uint8Array): Response {
  return new Response(bytes as BodyInit, { headers: {
    "content-type": TEXT_TYPES.test(type) ? `${type}; charset=utf-8` : type,
    "content-disposition": `${INLINE_TYPES.test(type) ? "inline" : "attachment"}; filename="${name.replace(/[^\w.-]/g, "_")}"`,
    "x-content-type-options": "nosniff",
    "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    "cache-control": "private, max-age=3600",
    // Same reason as client.js: the page is a sandboxed (opaque-origin)
    // iframe, and the ticket in the URL is the auth.
    "access-control-allow-origin": "*",
  } });
}

// costa.js is platform-injected (COSTA_MODULE); a piece must not shadow it.
function validFileName(name: string): boolean {
  return /^[\w./-]+$/.test(name) && !name.includes("..") && name !== "costa.js";
}

// Method names and parameter lists, read from source. The loader hands back an
// RPC stub whose properties can't be enumerated, so scraping is the only way
// to answer "what could be called?" without loading an isolate to ask.
// Advisory: the real lookup happens at invoke time, so a name missed here
// still runs, and one found here may not exist.
const NOT_A_METHOD = ["if", "for", "while", "switch", "catch", "return", "constructor"];

function scanMethods(source: string | undefined): { name: string; params: string[] }[] {
  if (!source) return [];
  const found = new Map<string, string[]>();
  // Find where a method's parameter list STARTS, then walk the parens to find
  // where it ends. A single regex cannot do that half: a default value may
  // contain parens of its own (`at = Date.now()`), and a pattern that stops at
  // the first `)` fails to match the method at all — dropping it silently from
  // describe and from the console, rather than merely garbling its arguments.
  for (const m of source.matchAll(/^(?: {2,}|\t+)(?:async\s+)?(?:\*\s*)?([a-zA-Z]\w*)\s*\(/gm)) {
    const name = m[1];
    if (NOT_A_METHOD.includes(name) || found.has(name)) continue;

    const open = m.index! + m[0].length - 1;
    const close = closingParen(source, open);
    if (close < 0) continue;
    // A body has to follow, or this is a call in an expression rather than a
    // declaration — `  this.emit(x)` is not a method named emit.
    if (!/^\s*\{/.test(source.slice(close + 1))) continue;

    const params = splitParams(source.slice(open + 1, close))
      .map((p) => p.trim())
      // Destructured or defaulted params have no single name to show; keep the
      // position so arity still lines up, and let the console label it.
      .map((p) => (/^[a-zA-Z_$][\w$]*$/.test(p) ? p : stripDefault(p)))
      .filter((p) => p.length > 0);
    found.set(name, params);
  }
  return [...found].map(([name, params]) => ({ name, params }));
}

// The index of the `)` closing the `(` at `open`, or -1 if the source runs out
// first. Quotes are tracked because a default value is allowed to contain a
// bracket in a string — `sep = ")"` would otherwise close the list early.
function closingParen(source: string, open: number): number {
  let depth = 0;
  let quote = "";
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === ")" ? i : -1;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

// `x = 5` -> `x`, but only at the top level: the `=` inside `{ a, b = 5 }` is
// part of the pattern, and cutting there would report the parameter as
// `{ a, b` — which is worse than showing the pattern whole.
function stripDefault(param: string): string {
  let depth = 0;
  let quote = "";
  for (let i = 0; i < param.length; i++) {
    const c = param[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    // `=` alone: not `==`, and not the `=>` of an arrow default.
    else if (c === "=" && depth === 0 && param[i + 1] !== "=" && param[i + 1] !== ">" &&
      param[i - 1] !== "=" && param[i - 1] !== "!" && param[i - 1] !== "<" && param[i - 1] !== ">") {
      return param.slice(0, i).trim();
    }
  }
  return param.trim();
}

// Commas at the top level only, so `x = f(a, b)` and `{ a, b }` each stay one
// parameter instead of becoming two.
function splitParams(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote = "";
  let current = "";
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (quote) {
      current += c;
      if (c === "\\" && i + 1 < list.length) current += list[++i];
      else if (c === quote) quote = "";
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

// interface.js is data, not code: `export default { ... }` where the object is
// JSON. Parsing it here (rather than loading an isolate to read its export)
// keeps the deploy cheap and lets the rpc gate be a storage read. The tradeoff
// is that the file may not compute its entries — which is the point: the
// external surface should be readable without running anything.
export interface InterfaceEntry {
  description: string;
  params?: Record<string, string>;
}

// The router forwards the verified ticket on browser routes; its preview flag
// (signed by the control plane) says the holder is working on the piece and gets head.
function ticketPreview(request: Request): boolean {
  const raw = request.headers.get("x-kernel-ticket");
  if (!raw) return false;
  try { return (JSON.parse(raw) as Ticket).preview === true; } catch { return false; }
}

// Throws with a caller-facing reason; putFiles turns that into a 422.
export function parseInterface(source: string): Record<string, InterfaceEntry> {
  const body = source
    .replace(/^\s*\/\/.*$/gm, "") // line comments, incl. the file's own header
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*export\s+default\s*/, "")
    .replace(/[\s;]+$/, "")
    .trim();
  if (!body.startsWith("{")) {
    throw new Error(`${INTERFACE_MODULE} must be \`export default { ... }\``);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e: any) {
    // The common miss is JS object syntax (unquoted keys, trailing commas);
    // say so rather than echoing a bare position from JSON.parse.
    throw new Error(
      `${INTERFACE_MODULE} must be plain JSON — quote every key and drop ` +
        `trailing commas (${String(e?.message ?? e)})`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${INTERFACE_MODULE} must export an object of methods`);
  }
  const spec: Record<string, InterfaceEntry> = {};
  for (const [name, raw] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-zA-Z]\w*$/.test(name)) {
      throw new Error(`${INTERFACE_MODULE}: "${name}" is not a valid method name`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${INTERFACE_MODULE}: ${name} must be an object with a description`);
    }
    const { description, params } = raw as Record<string, unknown>;
    if (typeof description !== "string" || description.trim() === "") {
      throw new Error(`${INTERFACE_MODULE}: ${name} needs a non-empty description`);
    }
    const entry: InterfaceEntry = { description };
    if (params !== undefined) {
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        throw new Error(`${INTERFACE_MODULE}: ${name}.params must be an object of name -> description`);
      }
      for (const [param, text] of Object.entries(params as Record<string, unknown>)) {
        if (typeof text !== "string") {
          throw new Error(`${INTERFACE_MODULE}: ${name}.params.${param} must be a string`);
        }
      }
      entry.params = params as Record<string, string>;
    }
    spec[name] = entry;
  }
  return spec;
}

export function json(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), {
    status, headers: { "content-type": "application/json" },
  });
}

export function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}
