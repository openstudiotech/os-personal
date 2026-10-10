// The default piece UI: what you get before (or instead of) a hand-built
// client.js. Lists the piece's methods, gives each one a form, shows live state
// and a log of what came back. Styled with the platform kit, so it follows the
// org's theme and the viewer's colour scheme like any other piece.
import { connect } from "/cell-sdk.js";

const app = document.getElementById("app");
const fmt = (v) => (typeof v === "string" ? v : JSON.stringify(v, null, 2));

// A form field's value, parsed the way a caller would expect: JSON when it
// looks like JSON (numbers, arrays, objects, booleans), a plain string
// otherwise, so `buy milk` doesn't have to be typed as `"buy milk"`.
function parseArg(raw) {
  const text = raw.trim();
  if (text === "") return undefined;
  if (/^(-?\d|\[|\{|"|true$|false$|null$)/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children.flat()) {
    if (child != null) node.append(child);
  }
  return node;
}

function main() {
  const shell = el("div", { className: "mx-auto max-w-4xl" });
  const status = el("span", { className: "c-pill" }, "connecting…");
  const header = el("div", { className: "c-header" },
    el("div", {},
      el("h1", { className: "text-xl m-0" }, "Piece console"),
      el("p", { className: "text-xs text-muted m-0 mt-1" },
        "No custom UI is deployed, so this is the piece's methods and state."),
    ),
    status,
  );

  const methodPane = el("div", {});
  const statePane = el("pre", { className: "text-xs m-0 overflow-auto",
    style: "max-height: 320px" }, "–");
  const logPane = el("div", { className: "text-xs font-mono overflow-auto",
    style: "max-height: 220px" },
    el("p", { className: "text-muted m-0" }, "Nothing called yet."));

  const grid = el("div", { className: "grid grid-cols-2 gap-4 sm:grid-cols-1" },
    el("div", {},
      el("span", { className: "c-label" }, "Methods"),
      methodPane),
    el("div", {},
      el("span", { className: "c-label" }, "State"),
      el("div", { className: "c-card p-3 mb-4" }, statePane),
      el("span", { className: "c-label" }, "Activity"),
      el("div", { className: "c-card p-3" }, logPane)),
  );

  shell.append(header, grid);
  app.replaceChildren(shell);
  return { status, methodPane, statePane, logPane };
}

function log(pane, kind, title, detail) {
  if (pane.firstElementChild?.dataset.placeholder) pane.replaceChildren();
  const row = el("div", { className: "pb-2 mb-2 border-b" },
    el("div", { className: "flex items-baseline gap-2" },
      el("span", { className: kind === "error" ? "c-pill c-pill-danger" : "c-pill c-pill-accent" },
        kind === "error" ? "error" : "ok"),
      el("span", { className: "text-strong break-words" }, title)),
    detail === undefined ? null
      : el("pre", { className: "mt-1 mb-0 text-2xs whitespace-pre-wrap break-words" }, fmt(detail)),
  );
  pane.prepend(row);
}

// One card per method: a field per declared parameter, and a call button.
function methodCard(method, api, panes) {
  const inputs = method.params.map((name) =>
    el("label", { className: "c-field block" },
      el("span", { className: "c-label" }, name),
      el("input", { className: "c-input c-input-mono", placeholder: "value or JSON" })));

  const button = el("button", { className: "c-btn c-btn-primary c-btn-sm" }, "Call");
  const form = el("form", { className: "c-card mb-3" },
    el("div", { className: "flex items-baseline justify-between gap-2 mb-2" },
      el("code", { className: "text-strong text-sm" }, method.name),
      method.params.length
        ? el("span", { className: "text-2xs text-muted" },
            `${method.params.length} arg${method.params.length === 1 ? "" : "s"}`)
        : el("span", { className: "text-2xs text-muted" }, "no args")),
    inputs,
    el("div", { className: "flex justify-end" }, button),
  );

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    // Trailing blanks are dropped so optional params can be left empty, but an
    // omitted middle arg still has to hold its position.
    const args = inputs.map((label) => parseArg(label.querySelector("input").value));
    while (args.length && args.at(-1) === undefined) args.pop();

    button.disabled = true;
    button.textContent = "Calling…";
    try {
      const result = await api.call(method.name, args);
      log(panes.logPane, "ok", `${method.name}()`, result);
    } catch (error) {
      log(panes.logPane, "error", `${method.name}()`, error?.message ?? String(error));
    } finally {
      button.disabled = false;
      button.textContent = "Call";
    }
  });

  return form;
}

const panes = main();

try {
  const { api, me } = await connect();
  panes.status.replaceChildren(`${me.user} · ${me.role}`);

  const initial = await api.subscribe((state) => {
    panes.statePane.textContent = state === null || state === undefined
      ? "No state yet." : fmt(state);
  });
  panes.statePane.textContent = initial === null || initial === undefined
    ? "No state yet." : fmt(initial);

  const methods = await api.describe();
  if (!methods.length) {
    panes.methodPane.replaceChildren(
      el("div", { className: "c-empty" }, "This piece has no methods yet."));
  } else {
    panes.methodPane.replaceChildren(
      ...methods.map((method) => methodCard(method, api, panes)));
  }

  panes.logPane.firstElementChild.dataset.placeholder = "true";
} catch (error) {
  panes.status.className = "c-pill c-pill-danger";
  panes.status.replaceChildren("disconnected");
  panes.methodPane.replaceChildren(
    el("div", { className: "c-empty text-danger" },
      `Could not connect: ${error?.message ?? error}`));
}
