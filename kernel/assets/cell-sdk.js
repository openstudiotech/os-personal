// SDK for piece client pages, served on the kernel origin. A piece's
// client.html imports this and calls connect(); the WebSocket URL + ticket are
// derived from the page's own /pieces/:id/client?org=..&ticket=.. location.
import { newWebSocketRpcSession, RpcTarget } from "/capnweb.js";

export { RpcTarget };

// Returns { api, me, files }: api.call(method, args), api.subscribe(cb) ->
// initial state (cb fires on every state change), me = { user, role }, and
// files, which turns what a piece holds into addresses the page can show:
//   files.url(ref)     a stored file (ref = what save:/preview:/upload gave)
//   files.asset(name)  a file shipped with the piece's code
//   files.upload(file) a File from an <input type="file"> -> its ref
// How long a call may take before the page says it is working.
const SOON = 400;

// Every api.call shows that it is under way, without the piece doing anything:
// the button that was pressed is held until its call comes back, and a call
// that takes more than a moment (one that reaches another piece, the web or a
// model) puts a bar across the top of the page until it is done. A piece that
// wants to show its own waiting marks the button `data-quiet`.
function waited(session) {
  let waiting = 0;
  let bar = null;
  let timer = null;
  const show = () => {
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "__cell_waiting__";
      bar.setAttribute("role", "progressbar");
      bar.setAttribute("aria-label", "Working");
      const style = document.createElement("style");
      style.textContent = "#__cell_waiting__{position:fixed;top:0;left:0;right:0;height:3px;z-index:99998;overflow:hidden;" +
        "background:color-mix(in srgb,var(--c-accent,#6366f1) 20%,transparent)}" +
        "#__cell_waiting__::after{content:\"\";position:absolute;top:0;bottom:0;width:35%;background:var(--c-accent,#6366f1);" +
        "animation:__cell_waiting__ 1.1s ease-in-out infinite}" +
        "@keyframes __cell_waiting__{0%{left:-35%}100%{left:100%}}" +
        "@media (prefers-reduced-motion:reduce){#__cell_waiting__::after{animation:none;left:0;width:100%;opacity:.6}}";
      document.head.appendChild(style);
    }
    document.body.appendChild(bar);
    document.body.setAttribute("aria-busy", "true");
  };
  const settle = () => {
    waiting -= 1;
    if (waiting > 0) return;
    clearTimeout(timer);
    timer = null;
    bar?.remove();
    document.body.removeAttribute("aria-busy");
  };
  const call = (...args) => {
    const pressed = document.activeElement;
    const held = pressed instanceof HTMLButtonElement && !pressed.disabled && !pressed.hasAttribute("data-quiet") ? pressed : null;
    if (held) held.disabled = true;
    waiting += 1;
    timer ??= setTimeout(show, SOON);
    const result = session.call(...args);
    const done = () => {
      if (held?.isConnected) held.disabled = false;
      settle();
    };
    Promise.resolve(result).then(done, done);
    return result;
  };
  return new Proxy(session, { get: (target, name) => (name === "call" ? call : target[name]) });
}

export async function connect() {
  const url = new URL(location.href);
  // Custom clients are served at /pieces/:id/client; the debug fallback lives
  // at /client.html with the connect path in ?connect=.
  const connectPath = url.pathname.endsWith("/client")
    ? url.pathname.replace(/\/client$/, "/connect")
    : url.searchParams.get("connect");
  if (!connectPath) throw new Error("no connect path");
  const params = new URLSearchParams(url.search);
  params.delete("connect");
  const wsUrl = new URL(`${connectPath}?${params}`, url);
  wsUrl.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const session = newWebSocketRpcSession(wsUrl.toString());
  const me = await session.whoami();
  const api = waited(session);
  // The same credential the page was served with, and nothing else from its
  // query.
  const auth = new URLSearchParams();
  for (const key of ["org", "ticket"]) {
    if (params.has(key)) auth.set(key, params.get(key));
  }
  const address = (path) => new URL(`${connectPath.replace(/\/connect$/, "")}/${path}?${auth}`, url).toString();
  const files = {
    url: (ref) => address(`files/${encodeURIComponent(typeof ref === "string" ? ref : ref?.id)}`),
    asset: (name) => address(`assets/${String(name).split("/").map(encodeURIComponent).join("/")}`),
    upload: async (file) => session.upload(file.name, new Uint8Array(await file.arrayBuffer())),
  };
  return { api, me, files };
}
