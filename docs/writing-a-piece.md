# Writing a piece

For whoever writes a piece's code for OpenStudio Personal, person or AI client. The full contract is `contract.md`; this is the part you need to write one that works.

## What a piece is

A small app: a set of text files the kernel runs. Its code has **no network**. It is given its state, returns a new state, and asks for anything outside itself by returning an effect.

| File | What it is |
|---|---|
| `piece.js` | Required. The methods people and other pieces call |
| `tasks.js` | Optional. The methods a schedule calls |
| `interface.js` | Optional. Which methods an outside caller may use, and what each is for |
| `tests.js` | Optional, and worth writing. Scenarios the kernel runs on every deploy |
| `client.js`, `styles.css` | Optional. The piece's own page. Without them a plain console is shown |

At most 64 files, each under 1,000,000 characters. Names match `^[\w./-]+$`. `costa.js` is supplied; do not ship one.

## Methods

```js
import { Piece } from "./costa.js";

export default class extends Piece {
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { count }, result: count };
  }
}
```

Every method is `(state, ...args) -> { state?, result?, effect? }`.

- `state` is one JSON value, `null` at first. It is passed in whole and replaced whole, so spread what you keep: `{ ...state, count }`.
- `result` goes back to the caller.
- A method runs for at most 2 seconds of CPU.
- Nothing may be kept between calls except in `state`.

## Asking for something outside

Return an effect and name the method that receives the answer:

```js
refresh(state) {
  return { effect: { fetch: "https://example.com/data.json", then: "onData" } };
}
onData(state, outcome) {
  if (outcome.error) return { state: { ...state, error: outcome.error } };
  return { state: { ...state, data: outcome.json } };
}
```

`then` is required. A refusal or a failure arrives as `{ error: "..." }`; it is never thrown. **Always handle `outcome.error`.** At most 8 effects in a row from one call.

| Effect | The answer |
|---|---|
| `{ fetch: "<https url>" }` | `{ status, body, json }`. GET only. The host must be one the piece was granted |
| `{ search: "<query>", since?: "day" \| "week" \| "month" }` | `{ results: [{ title, url, snippet }] }` |
| `{ extract: "<https url>" }` | `{ markdown, title }`: the page as text |
| `{ llm: { prompt, system? } }` | `{ text }`. You do not choose the model |
| `{ call: { cell: "<piece name>", method, args? } }` | `{ result }`: another piece's method |
| `{ browser: { scrape: "<https url>" } }` | `{ content, title, url }`: the page as a browser sees it |
| `{ browser: { screenshot: "<https url>" } }` | `{ image_url, url }` |
| `{ browser: { session: "create" } }` | `{ session, expires_in_minutes }`: a browser of the piece's own, for ten minutes. Two at most |
| `{ browser: { session, goto: "<https url>" } }` | `{ url, title }`: where it landed |
| `{ browser: { session, read: true } }` | `{ url, title, content, truncated }`: the words on the page; `format: "html"` for its HTML |
| `{ browser: { session, act: { type, selector, ... } } }` | `{ acted, url_before, url }`. `type` is `click`, `type` or `fill` (with `text`), `press` (with `key`: Enter, Tab, Escape and the like) or `select` (with `value`) |
| `{ browser: { session, liveView: true } }` | `{ login_url, expires_in_minutes }`: a page to send the person to, where they sign in themselves. Never ask for a password in the piece |
| `{ browser: { session, release: true } }` | `{ session, status }`. Release it when done |

A session goes only to hosts the piece was granted. If a click takes it elsewhere, reading and acting are refused until it is back.

A piece can also use an MCP server its owner added under Services, naming it by its key:

| Returns | Comes back as |
|---|---|
| `{ mcp: { server: "google_calendar", tool: "<name>", args: {..} } }` | `{ result }`: the tool's text. A tool that fails comes back as `{ error }` |
| `{ mcp: { server: "google_calendar", tool: "__describe" } }` | `{ result: { server, tools } }`: what it can do |

Gmail, Google Calendar and Google Drive are `gmail_api`, `google_calendar` and `google_drive`, with the same tools and arguments as in OpenStudio. Their results are objects, not text.

Not available in this version, and refused: `save`, `preview` and `notify`.

**A piece reaches only what its owner granted it**, in the browser: the web by host, web search, the model, other pieces, services. A new piece has been granted nothing, so every effect answers `{ error: "... is not granted to this piece" }` until its owner grants it. Code cannot grant itself anything. Tell the person what the piece needs.

## Tasks and schedules

`tasks.js` has the same form as `piece.js`. A task takes the state and no other arguments. Its owner sets when it runs.

## `interface.js`

```js
export default {
  "add": { "description": "Adds n to the count", "params": { "n": "how much to add" } }
}
```

Strict JSON inside (quoted keys, no trailing commas). `description` is required. Without this file every method can be called.

## `tests.js`

```js
export default [
  { "name": "refresh stores the data", "call": "refresh", "state": { "count": 1 },
    "steps": [
      { "expect": { "effect": { "fetch": "https://example.com/data.json" } },
        "outcome": { "status": 200, "body": "{}", "json": { "a": 1 } } },
      { "expect": { "state": { "data": { "a": 1 } } } }
    ] }
]
```

Strict JSON, at most 50 scenarios, 1 to 8 steps each. Each step has `expect` (some of `effect`, `state`, `result`) and, on every step but the last, the `outcome` to answer the effect with. Matching is by subset. Tests never reach the network.

## The page

`client.js` runs in the browser. The page starts empty and there is no HTML file, so it makes every element it uses before it looks for any of them:

```js
import { connect } from "/cell-sdk.js";

document.body.innerHTML = `<p id="count">0</p><button id="add">+1</button>`;
const count = document.querySelector("#count");
const render = (state) => { count.textContent = state?.count ?? 0; };

const { api } = await connect();
render(await api.subscribe(render));
document.querySelector("#add").onclick = () => api.call("add", [1]);
```

`api.call(method, args)` calls a method. `api.subscribe(callback)` returns the state and calls back on every change. The page may load nothing from outside the kernel.

The state is `null` until a method has stored one, so read it as `state?.count ?? 0`.

Nothing runs `client.js` until a person opens the piece in a browser. The tests do not cover it, and a deploy that says `ok` has not checked it. So after writing or changing `client.js`:

1. Read it once more for anything used before it exists: an element not yet made, a field of a state that may be `null`.
2. Ask the person to open the piece.
3. Call `read_logs`. An error in the page is a line marked `page`, with the file and line. `read_piece` lists the ones since the last deploy as `page_errors`. Fix them before saying the piece is done.

## Deploying

A deploy checks the files, stores them as a new version, loads it, and runs the tests.

- If it will not load, the reply has `loadError`. The last version that loaded is put back, so the piece keeps working. **Your files are then no longer the current ones: fix the error and send your whole change again.**
- Failing tests do not stop a deploy. Read the results and fix them.
- `dangling` lists a `then:` naming a method that does not exist.
