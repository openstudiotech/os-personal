# The kernel contract

This document is the contract between the kernel and a control plane. It is meant to be exact enough to write a control plane from, without reading the kernel's source. Where the kernel's behaviour could not be established from its source, the text says "Not determined".

Contents:

1. [The two programs](#1-the-two-programs)
2. [The shared secret, service auth and tickets](#2-the-shared-secret-service-auth-and-tickets)
3. [Kernel routes](#3-kernel-routes)
4. [The WebSocket session](#4-the-websocket-session)
5. [What piece code is](#5-what-piece-code-is)
6. [Callbacks from the kernel to the control plane](#6-callbacks-from-the-kernel-to-the-control-plane)
7. [Schedules](#7-schedules)
8. [Usage reporting](#8-usage-reporting)
9. [Limits](#9-limits)
10. [Older names](#10-older-names)

## 1. The two programs

**The kernel** runs pieces. A piece is a small app: a set of files, a JSON state, a log, and some stored files. The kernel keeps one isolated object per piece, addressed by `(org, pieceId)`, and loads the piece's code into a sandbox of its own.

**The control plane** is whatever drives the kernel. It decides which pieces exist, who may use them, what they may reach, and what they cost. It deploys code to the kernel, mints the tickets browsers use, and answers the kernel's callbacks.

The one rule: **a piece has no network.** Its code runs with outbound access switched off; `fetch()` inside a piece throws. Anything a piece wants from outside itself it asks for by returning an *effect*, which the kernel sends to the control plane. The control plane decides whether to perform it and replies with the outcome. The kernel never judges whether an effect is allowed; the control plane always does.

Division of work:

| The kernel owns | The control plane owns |
|---|---|
| Piece code, every deployed version, the pin | Which pieces exist, their names, who owns them |
| Piece state, stored files, the log | Users, roles, sharing |
| Running reducers, the effect loop, CPU limit | Performing effects, and every permission check on them |
| Schedule timing, run history, backoff | Which schedules exist and whether each is enabled |
| Timing how long piece code ran | Charging for it |

Identifiers. An org id and a piece id each match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. The control plane chooses both. A piece comes into being on its first deploy; there is no create call.

The kernel is configured with two values:

| Variable | Meaning |
|---|---|
| `KERNEL_SECRET` | The shared secret (section 2) |
| `CONTROL_URL` | Base URL of the control plane, with no trailing slash. Callback paths are appended to it as they are. Unset: effects answer `{"error": "platform effects are not configured"}`, usage is dropped, and a paused schedule is not reported |

## 2. The shared secret, service auth and tickets

Both programs hold one secret, `KERNEL_SECRET`. It is used as the UTF-8 key of HMAC-SHA256 for everything below. There is one secret for all orgs. All signatures are lowercase hex, 64 characters.

### Service auth

Used by the control plane on every non-browser kernel route, and by the kernel on every callback.

```
Authorization: Kernel v1.<ts>.<sig>
```

- `<ts>` is the sender's clock in milliseconds since the Unix epoch, decimal digits only.
- `<sig>` = `hex(HMAC-SHA256(KERNEL_SECRET, "<ts>.<METHOD>.<signedPath>.<bodyHash>"))`
- `<METHOD>` is the HTTP method in upper case.
- `<bodyHash>` = `hex(SHA-256(raw request body bytes))`. With no body it is the hash of zero bytes, `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
- `<signedPath>` is **not** the URL path. It has the org folded in:

| Request | URL path | Signed path |
|---|---|---|
| Piece route | `/pieces/{piece}/{route}` | `/{org}/pieces/{piece}/{route}` |
| Destroy a piece | `/pieces/{piece}` or `/pieces/{piece}/` | `/{org}/pieces/{piece}/` (trailing slash, empty route) |
| Scheduler route | `/scheduler/{org}/{route}` | `/{org}/scheduler/{route}` |

The header must match `^Kernel v1\.(\d+)\.([0-9a-f]{64})$`. The receiver rejects a request when `|now - ts| > 60000` ms. There is no nonce: a captured request can be replayed inside the window.

**The org header.** Piece routes carry the org in `x-kernel-org`, which must match `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`. Because the org is part of the signed path, changing the header invalidates the signature. Scheduler routes take the org from the URL and need no header.

**What the signature does not cover:**

- The query string. `GET /pieces/p1/logs?limit=50` signs `/org1/pieces/p1/logs`. This includes `?user=` on `GET state`.
- Every header, including `x-kernel-scope`.

**`x-kernel-scope: internal`.** Read on `POST rpc/:method` only. It says the caller is working on the piece rather than using it. It has two effects: the interface gate is skipped (any method may be called, not only those in `interface.js`), and the call runs head rather than the pinned version. The kernel removes this header from every browser (ticketed) request and honours it only on a request that passed service auth, so holding the secret is what vouches for it.

The kernel also removes `x-kernel-ticket`, `x-kernel-identity` and `x-kernel-org` from incoming requests before using its own values for them; a caller cannot set them.

Service auth failures are `401` with a JSON body:

| `error` | Cause |
|---|---|
| `missing or bad x-kernel-org` | Header absent or not matching the rule |
| `missing or malformed service auth` | `Authorization` absent or not in the format above |
| `service auth timestamp outside window` | More than 60 s from the kernel's clock |
| `bad service auth signature` | Anything else |

Example, signing `PUT /pieces/p1/pin` for org `org1` with body `{"version":3}`:

```
message = "1760000000000.PUT./org1/pieces/p1/pin." + sha256hex('{"version":3}')
header  = "Kernel v1.1760000000000." + hmacSha256Hex(KERNEL_SECRET, message)
```

### Tickets

A ticket is what a browser presents. The control plane mints it; the kernel only verifies.

```
ticket = <payload>.<sig>
payload = base64url(JSON), no padding
sig     = hex(HMAC-SHA256(KERNEL_SECRET, payload))     // over the base64url text, not the JSON
```

The ticket must match `^[A-Za-z0-9_-]+\.[0-9a-f]{64}$`; a padded payload is refused.

Payload fields:

| Field | Type | Meaning |
|---|---|---|
| `org` | string | The org. Must equal the `org` query parameter of the request |
| `piece` | string | The piece id. Must equal the id in the URL |
| `user` | string | The user's id, as the control plane names users. Send a string. It becomes the `invoker` on effects and usage, and the key of a personal state slice |
| `role` | `"owner"`, `"editor"` or `"viewer"` | See below |
| `exp` | number | Expiry, milliseconds since the epoch. Must be a number |
| `preview` | boolean, optional | `true`: the holder runs head even when the piece is pinned. Must be a boolean if present |

```json
{"org":"org1","piece":"p1","user":"42","role":"editor","exp":1760000300000,"preview":true}
```

Keep the JSON to ASCII. The kernel decodes the payload byte for byte, so a non-ASCII character in it does not survive.

A ticket is passed as `?ticket=` alongside `?org=`. The kernel refuses it (`401 {"error":"invalid or expired ticket"}`) when the signature is wrong, the JSON does not parse, `org` or the piece does not match the request, `exp` has passed, `role` is not one of the three, or `preview` is present and not a boolean.

**Roles.** The kernel does not restrict what a role may call. Every role, `viewer` included, may call every method of the piece, upload files and subscribe. "Viewer" means "may use the app"; changing the piece (deploying, pinning, sharing) is done over service auth, so it is the control plane's check to make before it acts. The role is reported to the page by `whoami()` so a page can adapt what it shows. A control plane must not mint a ticket for someone who should not be able to run the piece's methods.

**`preview`.** Signed with the rest of the payload, so a holder cannot add it. Give it to someone working on the piece. Everyone else gets the pinned version when there is one.

**Expiry.** The control plane chooses `exp`. The kernel checks it on every ticketed HTTP request, when the WebSocket is opened, and again on each `call` and `upload` over an open socket (`ticket expired`). An open socket is not closed at expiry, and `subscribe` pushes continue. A page that outlives its ticket must be reloaded with a new one.

## 3. Kernel routes

All bodies are JSON unless stated. An error is a JSON object with an `error` string and a non-2xx status. Unless a route says otherwise, an unexpected failure is `500 {"error": "<message>"}`.

Before auth: a path that is neither `/pieces/:id/...` nor `/scheduler/:org/...` is `404 {"error":"expected /pieces/:id/..."}`; a piece id that breaks the id rule is `400 {"error":"bad cell id"}`; a scheduler org that breaks it is `400 {"error":"bad org"}`. An unknown route under a piece is `404 {"error":"no route: <METHOD> /<route>"}`.

### Summary

| Method and route | Auth | Purpose |
|---|---|---|
| `PUT files` | service | Deploy |
| `GET files` | service | Head's files |
| `GET versions` | service | Every version's manifest |
| `GET versions/:n` | service | One version's files |
| `POST versions/:n/restore` | service | Deploy version n again as a new version |
| `PUT pin` | service | Pin or unpin what people run |
| `PUT mode` | service | Set the state mode |
| `GET state`, `PUT state` | service | Read or import state |
| `GET logs` | service | Recent log lines |
| `GET describe` | service | What outside callers may call |
| `GET tasks` | service | Task names |
| `POST tests` | service | Run the piece's tests |
| `GET usage` | service | Usage not yet reported |
| `GET stored-files`, `POST stored-files`, `GET stored-files/:id` | service | Stored files |
| `POST task/:name` | service | Run a task now |
| `POST rpc/:method` | service | Call a method |
| `POST reload` | service | Drop and reload the sandbox |
| `DELETE` (empty route) | service | Destroy the piece |
| `GET connect` | ticket | WebSocket session |
| `GET client`, `client.js`, `styles.css`, `boot.js` | ticket | The piece's page |
| `POST page-log` | ticket | The page reporting an error |
| `GET files/:id` | ticket | A stored file |
| `GET assets/:name` | ticket | A file shipped with the code |

Note `files` (service, the code) and `files/:id` (ticket, a stored file) are different routes.

### `PUT files` (deploy)

Request:

```json
{
  "files": { "piece.js": "import { Piece } from \"./costa.js\"; ...", "client.js": "..." },
  "mode": "merge",
  "delete": ["old.js"]
}
```

| Field | Type | Meaning |
|---|---|---|
| `files` | object, required | File name to content. Every content is a string |
| `mode` | `"replace"` (default) or `"merge"` | `replace`: the sent files become the whole set. `merge`: the sent files are written over head's set |
| `delete` | array of names | `merge` only: names removed from the result |

**Binary files** travel as base64 text in the same `files` object. A file whose extension is `png`, `jpg`, `jpeg`, `webp`, `gif`, `avif` or `pdf` must be the base64 of a file of that type; the kernel checks the leading bytes. Whitespace in the base64 is ignored. Binary files are stored and served (`assets/:name`) but never handed to the sandbox as code.

**File names** match `^[\w./-]+$`, contain no `..`, and are not `costa.js` (the kernel supplies that module).

Checks, in order. The first that fails is the response; nothing is stored.

| Status | `error` | When |
|---|---|---|
| 400 | `files object required` | `files` missing or not an object |
| 400 | `mode must be "replace" or "merge"` | |
| 400 | `delete must be an array of file names` | |
| 400 | `delete requires mode "merge"` | A non-empty `delete` with `replace` |
| 400 | `bad or reserved file name: <name>` | A sent or deleted name breaks the rule |
| 400 | `file too large or not a string: <name>` | Content over 1,000,000 characters, or not a string |
| 400 | `files['piece.js'] required` | The resulting set has no `piece.js` |
| 400 | `too many files (max 64)` | The resulting set has more than 64 files |
| 422 | `<file> must \`export default class extends Piece\` (import { Piece } from "./costa.js")` | `piece.js` or `tasks.js` has no `export default class` |
| 422 | `<name> must be the base64 of a <EXT> file` | A binary file is not what its name says |
| 422 | a message naming `interface.js` | `interface.js` is not valid (section 5) |

A body that is not JSON is a `500`.

When the checks pass, the set is stored as the next version and becomes head, then loaded once to see that it loads.

Success, `200`:

```json
{
  "ok": true,
  "codeVersion": 7,
  "tests": { "total": 3, "passed": 2, "failed": 1,
             "results": [ { "name": "adds", "passed": true },
                          { "name": "fetches", "for": "shows the price", "passed": false,
                            "failure": { "step": 2, "message": "after onData, state.price: expected 3, got 4" } } ] },
  "dangling": [],
  "untested": ["remove"]
}
```

| Field | Meaning |
|---|---|
| `codeVersion` | The new version number. Versions count from 1 |
| `restoredFrom` | Present only on a restore |
| `tests` | The test summary, or `null` when there is no `tests.js` or it did not parse |
| `error` | Present when `tests.js` did not parse: why |
| `dangling` | Strings naming a `then:` continuation that has no method |
| `untested` | Interface methods and tasks that no test reached. Absent when there are no tests |

A deploy never fails on its tests. If the test run itself faults, the `tests`, `dangling` and `untested` fields are absent.

Load failure, `422`:

```json
{ "ok": false, "codeVersion": 7, "loadError": "SyntaxError: Unexpected token ...",
  "reverted": { "codeVersion": 8, "restoredFrom": 6 } }
```

Note the field is `loadError`, not `error`. The version that failed is kept in the history, and its manifest carries the `loadError`. If an earlier version loaded, the kernel puts the most recent one back as a **new** version and makes it head: `reverted.codeVersion` is that new version and `reverted.restoredFrom` the one it copies. The piece keeps running and its data is untouched. `codeVersion` in the reply is still the version that failed. With nothing to go back to (a first deploy), there is no `reverted` and the failed version is head. A control plane that merges partial file sets should know that after a revert, head no longer holds the files that failed: send them again in full.

### `GET files`

```json
{ "files": { "piece.js": "..." }, "meta": { "codeVersion": 7, "updatedAt": 1760000000000, "pinnedVersion": 5 } }
```

`files` is head's set, or `null` before the first deploy. `meta.pinnedVersion` is absent when nothing is pinned. Before the first deploy `meta` is `{"codeVersion":0,"updatedAt":0}`.

### `GET versions`

```json
{ "versions": [ { "version": 7, "files": { "piece.js": "<sha256>" }, "at": 1760000000000, "parent": 6,
                  "restoredFrom": 3, "loadError": "...", "tests": { "total": 3, "passed": 3, "failed": 0 } } ],
  "meta": { "codeVersion": 7, "updatedAt": 1760000000000 } }
```

Newest first. `files` maps each name to the SHA-256 of its content, without the content. `parent` is the version the deploy was built on (0 for the first). `restoredFrom`, `loadError` and `tests` appear only when they apply. Versions are never deleted.

### `GET versions/:n`

The manifest fields of version n, with `files` holding the contents instead of hashes: `{ "version": 3, "files": { "piece.js": "..." }, "at": ..., "parent": 2 }`. `404 {"error":"no version 3"}` when there is none.

### `POST versions/:n/restore`

Deploys version n's files as a new version. The body is ignored. The response is a deploy response with `restoredFrom: n`, including the `422` load failure. State and stored files are untouched. `404` when there is no such version.

A version whose manifest has a `loadError` cannot be restored: `422` with `{"error": "version 5 failed to load and cannot be restored", "loadError": "..."}`, and nothing changes.

### `PUT pin`

Request: `{"version": 5}` to pin, `{"version": null}` (or no `version`) to unpin.

Pinned: everyone runs that version except a ticket with `preview: true` and an `rpc` call with `x-kernel-scope: internal`, which run head. Schedules run the pin. Unpinned: everyone runs head.

| Status | Body |
|---|---|
| 200 | `{"ok": true, "pinnedVersion": 5}` (`null` when unpinned) |
| 400 | `{"error":"version must be an integer or null"}` |
| 404 | `{"error":"no version 5"}` |
| 422 | `{"error":"version 5 cannot be served: it failed to load when deployed"}` |

### `PUT mode`

Request: `{"mode": "shared" | "personal", "wipe": true}`.

- `shared` (the default for a new piece): one state for everyone.
- `personal`: one state per user, keyed by the caller's user id. Reducers cannot tell the difference.

`wipe: true` deletes the shared state and every personal slice, and pushes `null` to connected pages. Without `wipe` nothing is deleted or moved; state kept under the other mode stays stored and unused.

Responses: `200 {"ok": true, "mode": "personal"}`; `400 {"error":"mode must be shared or personal"}`.

### `GET state`

`GET state` or `GET state?user=<id>`.

```json
{ "state": { "count": 3 }, "meta": { "codeVersion": 7, "updatedAt": 1760000000000 }, "mode": "shared" }
```

`state` is `null` when nothing has been saved. On a personal piece `?user=` is required: without it the reply is `422 {"error":"this cell keeps personal state; the call must carry a user"}`.

### `PUT state`

Request: `{"state": <any JSON>}`. Replaces the shared state and pushes it to connected pages. For copying a piece.

| Status | Body |
|---|---|
| 200 | `{"ok": true}` |
| 400 | `{"error":"state required"}` |
| 422 | `{"error":"this cell keeps personal state; state cannot be imported"}` |

### `GET logs`

`GET logs?limit=<n>`. `limit` defaults to 100, at most 500.

```json
{ "lines": ["2026-01-01T00:00:00.000Z info deployed codeVersion=7 (3 files, merge)"] }
```

Oldest first. Each line is `<ISO time> <level> <message>`, at most 1,000 characters. Levels are `info`, `warn`, `error` and `page` (reported by the piece's page). The kernel keeps the last 500 lines per piece.

### `GET describe`

What a caller from outside may invoke.

With an `interface.js`: `{"declared": true, "methods": [{"name": "add", "description": "Adds n", "params": {"n": "how much"}}]}`.

Without one: `{"declared": false, "methods": [{"name": "add", "params": ["n"]}]}`. These names are read from the source of `piece.js`, without the leading state parameter, and are advisory.

It describes the version people run (the pin, when there is one).

### `GET tasks`

`{"tasks": ["refresh", "onStatus"]}`. Method names read from the source of head's `tasks.js`; empty when there is none. Advisory: `task/:name` decides for itself whether a task exists, and it runs the pinned version, which may differ from head.

### `POST tests`

Runs the tests in head's `tests.js`. The body is ignored. Nothing is saved, pushed, timed as usage or sent to the control plane.

| Case | Body |
|---|---|
| Tests ran | `{"tests": {total, passed, failed, results}, "dangling": [...], "untested": [...]}` |
| No `tests.js` | `{"tests": null, "dangling": [...]}` |
| `tests.js` does not parse | `{"tests": null, "error": "...", "dangling": [...]}` |
| Nothing deployed | `409 {"error":"no code deployed"}` |

### `GET usage`

What has been timed but not yet reported. For operators; a control plane never needs it.

```json
{ "pending": [ { "invoker": "42", "task": false, "calls": 3, "ms": 12 } ],
  "inflight": { "batch": "<uuid>", "entries": [ ... ] } }
```

`inflight` is `null` when no batch is waiting to be accepted.

### Stored files

Stored files are data a piece gathers while running: an upload, something a `save:` effect fetched. They live beside the state and are not versioned.

A stored file's id is the first 32 hex characters of the SHA-256 of its bytes, so the same bytes always have the same id, in any piece.

The record, as these routes return it:

| Field | Meaning |
|---|---|
| `id`, `name`, `type`, `bytes` | The reference a reducer keeps in state (a "file ref") |
| `at` | When stored, ms |
| `by` | Who uploaded it or whose call fetched it; `null` for a schedule |
| `source` | The URL it was saved from, when there is one |
| `expires` | ms; absent when kept for good. Expired files are removed on the next write |

The type is read from the bytes, never taken from the name or the caller. Kept types: `png`, `jpg`/`jpeg`, `webp`, `gif`, `avif`, `pdf` (by signature) and `svg`, `csv`, `json`, `txt`, `md` (by extension, and only when the bytes are valid UTF-8 text with no NUL; an `svg` must contain `<svg`). The name is reduced to `[\w.-]`, other characters becoming `_`, and its last 100 characters are kept.

**`GET stored-files`** returns `{"files": [<record>, ...]}`.

**`POST stored-files`** imports one:

```json
{ "name": "logo.png", "base64": "iVBORw0...", "by": "42", "source": "https://example.com/logo.png", "expires": 30 }
```

`name` and `base64` are required. `expires` is a number of days. Reply `{"file": {"id": "...", "name": "logo.png", "type": "image/png", "bytes": 5120}}`.

| Status | `error` |
|---|---|
| 400 | `name and base64 required`, or `a file needs bytes` (empty) |
| 413 | `file too large (max 1 MB)` |
| 415 | `unsupported file type: <name> (pieces keep png, jpg, ...)` |
| 507 | `this piece's file storage is full (500 files, 50 MB)` |

Storing bytes already held keeps the one copy and the longer lifetime; a file kept for good stays so.

**`GET stored-files/:id`** returns `{"file": <record>, "base64": "..."}`, or `404 {"error":"no such file: <id>"}`.

### `POST task/:name`

Runs a method of `tasks.js`. This is the route schedules use, and how a task is run by hand.

Request: `{"runId": "abc", "invoker": "42"}`. Both optional.

| Field | Meaning |
|---|---|
| `runId` | A string. If the last run of this task had the same `runId`, the task is not run again |
| `invoker` | A string or number: the person running it by hand. Absent: the run is background work, effects carry no `invoker`, and usage is recorded as a task |

The task receives the state and no other arguments. It runs the pinned version when there is one. One run of a given task at a time per piece.

| Status | Body |
|---|---|
| 200 | `{"result": <the task's result>}` |
| 200 | `{"result": {"skipped": "already running"}}` or `{"result": {"skipped": "already ran"}}` |
| 400 | `{"error":"invalid task name: <name>"}` (must match `^[a-zA-Z]\w*$`) |
| 404 | `{"error":"this cell has no tasks.js, so there is no task \"<name>\" to run"}` or `{"error":"tasks.js has no method \"<name>\""}` |
| 422 | `{"error":"cell method <name> failed: <message>"}`, and the effect errors listed under `rpc` |

A personal piece cannot run a task without an `invoker` (422): there is no slice to run it on.

### `POST rpc/:method`

Calls a method of `piece.js`. This is the route for callers outside the piece's own page: an agent, another piece, the control plane's tooling.

Request:

```json
{ "args": [2, "x"], "chain": ["pieceA"], "user": "42" }
```

| Field | Meaning |
|---|---|
| `args` | Array of arguments after the state. Default `[]` |
| `chain` | Array of piece ids already visited when this call is part of a piece-to-piece chain. Default `[]`; anything that is not an array of strings is treated as `[]`. Sent back on any `call` effect this call makes (section 6) |
| `user` | A **string**: the person the call is for. It becomes `invoker` on effects and usage, and selects the slice of a personal piece. A non-string is ignored |

**The interface gate.** When the version being served has an `interface.js`, only the methods it names may be called here; anything else is `403`. A piece with no `interface.js` refuses nothing. `x-kernel-scope: internal` skips the gate and runs head. The gate applies to this route only, never to the WebSocket or to tasks.

| Status | Body |
|---|---|
| 200 | `{"result": <value>}`; `null` when the method returned none |
| 400 | `{"error":"invalid method: <name>"}` (must match `^[a-zA-Z]\w*$`) |
| 403 | `{"error":"\"x\" is not in this cell's interface (it offers: a, b)"}` |
| 404 | `{"error":"piece.js has no method \"x\""}` |
| 409 | `{"error":"no code deployed"}` |
| 422 | `{"error":"link chain too long"}` (`chain` longer than 8) |
| 422 | `{"error":"cell method x failed: <message>"}` (the method threw, or exceeded its CPU limit) |
| 422 | `{"error":"this cell keeps personal state; the call must carry a user"}` |
| 422 | `{"error":"effect chain too deep"}`, `{"error":"invalid effect: ..."}`, `{"error":"invalid browser effect: ..."}` |

When a method returns an effect, the response is held until the whole chain of effects and continuations has finished, and `result` is the last continuation's result. A call can therefore take as long as the effects it makes; set the client timeout in minutes, not seconds. State saved by earlier steps of a chain stays saved if a later step fails.

### `POST reload`

Drops the piece's sandboxes; they are rebuilt on the next call. Body ignored. `200 {"ok": true, "codeVersion": 7}`; `409` when nothing is deployed.

### `DELETE` (empty route)

`DELETE /pieces/{piece}` with signed path `/{org}/pieces/{piece}/`. Deletes everything the kernel holds for the piece: files, versions, state, stored files, logs, unreported usage. `200 {"ok": true}`. Not reversible. Schedules are kept elsewhere and are not removed; delete them separately (section 7).

### Ticketed routes

All take `?org=<org>&ticket=<ticket>`. A missing or bad ticket is `401 {"error":"invalid or expired ticket"}`. A ticket with `preview: true` is served head; others the pin.

| Route | Returns |
|---|---|
| `GET connect` | The WebSocket (section 4). Without an `Upgrade: websocket` header: `426 {"error":"websocket upgrade required"}` |
| `GET client` | The piece's page, as HTML. Put this URL in a sandboxed iframe |
| `GET client.js` | The piece's `client.js`, `text/javascript`. `404 {"error":"no such asset: client.js"}` |
| `GET styles.css` | The piece's `styles.css`, `text/css`. `404` likewise |
| `GET boot.js` | A script the kernel supplies to every generated page |
| `POST page-log` | Always `204`, no body |
| `GET files/:id` | A stored file's bytes. `404 {"error":"no such file: <id>"}` |
| `GET assets/:name` | A shipped file's bytes. `404 {"error":"no such asset: <name>"}` |

**`client`** takes two more query parameters:

| Parameter | Values | Default |
|---|---|---|
| `theme` | `openstudio`, `swiss`, `mono` | `openstudio`; an unknown value falls back to it |
| `scheme` | `light`, `dark` | Neither: the page follows the viewer's system setting |

The page is generated: the theme's stylesheet, the kernel's UI kit, the piece's `styles.css` if it ships one, an empty `<div id="app">`, `boot.js`, then `client.js` as a module. Only `org` and `ticket` are carried onto the page's own asset URLs. A piece with no `client.js` gets a built-in console listing its methods and state. A piece with a `client.html` and no `client.js` has that file served whole (an older form). The page is sent with a content security policy of `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self' data:`.

The page finds its WebSocket by replacing `/client` with `/connect` in its own address and keeping the query, so the iframe URL is all a control plane supplies.

When the page has painted it posts `{"type": "cell:ready"}` to its parent window, and sets `window.__cellReady = true`.

**`page-log`** is how `boot.js` reports an uncaught error, a `console.error` or `console.warn`, or something the browser blocked. Body: `{"kind": "error", "message": "..."}`. It is written to the piece's log at level `page`. At most 30 a minute per piece are kept; the body is read to 2,000 characters and the message cut to 600.

**`files/:id` and `assets/:name`** are sent with `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; style-src 'unsafe-inline'; sandbox`, `cache-control: private, max-age=3600` and `access-control-allow-origin: *`. Images, PDFs and plain text are `content-disposition: inline`; everything else is `attachment`. `assets/:name` serves only names whose extension is one of the kept types listed under stored files.

**Static files.** The kernel's origin also serves, with no auth, the files its generated pages load: `/cell-sdk.js`, `/capnweb.js`, `/console.js`, `/ui/kit.css`, `/ui/themes/<theme>.css` and `/vendor/chart.js`. A control plane does nothing with these except leave the kernel's origin reachable from browsers.

### Scheduler routes

Under `/scheduler/:org/`, service auth with signed path `/{org}/scheduler/{route}`. Described in section 7.

| Method and route | Purpose |
|---|---|
| `PUT schedules/:id` | Create or replace a schedule |
| `DELETE schedules/:id` | Remove one |
| `GET schedules` | Every schedule in the org |
| `GET schedules/:id/runs` | One schedule's recent runs |

## 4. The WebSocket session

`GET /pieces/:id/connect?org=..&ticket=..` upgrades to a WebSocket speaking Cap'n Web RPC. The object the client receives has these methods:

| Method | Returns | Notes |
|---|---|---|
| `whoami()` | `{user, role}` | From the ticket |
| `describe()` | `[{name, params: [string]}]` | Method names read from `piece.js` source, minus the state parameter. Advisory |
| `call(method, args = [])` | The method's result | Runs a reducer of `piece.js`, with the ticket's `user` as invoker. Throws `ticket expired` after `exp` |
| `upload(name, bytes)` | A file ref `{id, name, type, bytes}` | `bytes` is a `Uint8Array`. Stores a file; the page passes the ref to a reducer to make it part of the state. Throws `ticket expired` after `exp`, and the stored-file errors of section 3 |
| `subscribe(callback)` | The current state | `callback(state)` is then called on every state change. On a personal piece, the state is the ticket user's slice and only that user's changes are pushed |

Every role may call every method. The interface gate does not apply here: a piece's own page may call any of its methods. A ticket with `preview: true` runs head; any other runs the pin.

Errors reach the client as rejected calls carrying the same messages as the `rpc` route.

A state wipe (`PUT mode` with `wipe`) pushes `null`. `PUT state` pushes the imported state.

## 5. What piece code is

A piece is a set of text files. The kernel gives meaning to these names:

| File | Meaning |
|---|---|
| `piece.js` | Required. The reducers people and other pieces call. `export default class extends Piece` |
| `tasks.js` | Optional. The reducers a schedule calls. Same form |
| `interface.js` | Optional. Data: which `piece.js` methods outside callers may use |
| `tests.js` | Optional. Data: test scenarios |
| `client.js` | Optional. The page's script, run in the browser, never in the sandbox |
| `styles.css` | Optional. The page's stylesheet |
| `client.html` | Optional, older form: a whole page, used only when there is no `client.js` |
| `costa.js` | Reserved. Supplied by the kernel; exports `Piece` |
| anything else | Other modules `piece.js` or `tasks.js` import by relative path, or files served at `assets/:name` |

```js
import { Piece } from "./costa.js";

export default class extends Piece {
  add(state, n) {
    const count = (state?.count ?? 0) + n;
    return { state: { count }, result: count };
  }
  refresh(state) {
    return { effect: { fetch: "https://example.com/data.json", then: "onData" } };
  }
  onData(state, outcome) {
    if (outcome.error) return { state: { ...state, error: outcome.error } };
    return { state: { ...state, data: outcome.json } };
  }
}
```

**Reducers.** Every method is `(state, ...args) -> { state?, result?, effect? }`. Method names match `^[a-zA-Z]\w*$`.

| Returned | The kernel does |
|---|---|
| An object with a `state` key | Saves it as the new state and pushes it to subscribed pages |
| An object with an `effect` | After saving any `state`, performs the effect and calls the continuation. The `result` beside an effect is discarded |
| An object with `state` or `result` and no effect | Answers the caller with `result`, or `null` |
| Anything else | Answers the caller with the value as it is |

**State** is one JSON value per piece (shared mode) or per user (personal mode), `null` until first saved. It is passed in whole and replaced whole.

**Effects** are data. The piece returns `{ effect: { <kind>: ..., then: "<method>" } }`. `then` is required and names a method in the same file (`piece.js` continuations stay in `piece.js`, `tasks.js` in `tasks.js`). The kernel obtains an outcome, then calls `then(state, outcome)` with the state as it now is. A refusal or failure arrives as `{ error: "..." }` in the outcome; it is never thrown into the piece. The continuation may return another effect.

**Chain depth.** One call may perform at most 8 effects in a row. The ninth is refused with `effect chain too deep`.

**CPU limit.** Each call into piece code (the first reducer and every continuation, separately) may use 2,000 ms of CPU. The exact error text when it is exceeded is Not determined; it is reported as `cell method <name> failed: ...`.

**`interface.js`** is `export default { ... }` where the object is strict JSON (quoted keys, no trailing commas; comments are allowed):

```js
export default {
  "add": { "description": "Adds n to the count", "params": { "n": "how much to add" } }
}
```

Each key is a method name; `description` is a required non-empty string; `params` is an optional object of name to description. A malformed file fails the deploy.

**`tests.js`** is `export default [ ... ]`, strict JSON, at most 50 scenarios:

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

| Field | Meaning |
|---|---|
| `name` | Required |
| `for` | Optional text: what the scenario is there to show |
| `module` | `"piece"` (default) or `"tasks"` |
| `state` | The starting state; default `null` |
| `call`, `args` | The method and its arguments |
| `steps` | 1 to 8. Each has `expect` with at least one of `effect`, `state`, `result`, and, on every step but the last, an `outcome` to answer the effect with |

Matching is by subset: an object must have at least the named keys, a list the same length, `null` means absent, and `{"includes": "x"}` matches a string containing `x`. A canned outcome must have the key the real effect answers with (`fetch`: `status`; `search`: `results`; `extract`: `markdown`; `llm`: `text`; `notify`: `sent`; `call` and `mcp`: `result`) or an `error`.

## 6. Callbacks from the kernel to the control plane

There are three. All are `POST` with `content-type: application/json`, an `authorization` header in the service-auth format of section 2, and `x-kernel-org: <org>`.

| Callback | URL | Signed path |
|---|---|---|
| Effect | `{CONTROL_URL}/api/v1/pieces/{piece}/fetch` | `/{org}/pieces/{piece}/fetch` |
| Usage | `{CONTROL_URL}/api/v1/pieces/{piece}/usage` | `/{org}/pieces/{piece}/usage` |
| Schedule paused | `{CONTROL_URL}/api/v1/pieces/schedules/{scheduleId}/status` | `/{org}/pieces/schedules/{scheduleId}/status` |

The signed string is `"<ts>.POST.<signedPath>.<sha256hex(body)>"`. The signed path has no `/api/v1` prefix and begins with the org from the header.

A control plane should verify each callback the way the kernel verifies service auth: header format, timestamp within 60 s, the org header, a signature computed over the raw body bytes compared in constant time, and that the piece (or schedule) belongs to that org. It should answer `401` with `{"error": "..."}` when any of these fails.

**Timeouts.** The kernel sets no timeout on any callback. It waits for the reply for as long as the runtime it is deployed on allows; that ceiling is Not determined from the kernel's source. The control plane should bound its own work and always reply.

### 6.1 The effect callback

Sent once per effect, while the piece's caller waits.

**Request body.** `kind` and the fields for that kind (below), plus:

| Field | Meaning |
|---|---|
| `invoker` | The user the call is for: the ticket's `user`, the `user` of an `rpc`, or the `invoker` of a task run by hand. **Absent** when a schedule started the run, or an `rpc` carried no `user`. A control plane should treat an absent invoker as the piece owner's background work |

**How the kernel treats the reply:**

| Reply | The continuation receives |
|---|---|
| `200` with a JSON object | That object, unchanged (after the extra step for `save` and `preview`) |
| `200` with an `error` field | The same: an object with `error` is how a refusal is delivered |
| `200` with a body that is not JSON | `{"error": "bad response (200)"}` |
| Any non-2xx with JSON `{"error": "x"}` | `{"error": "x"}`. Every other field of the body is dropped |
| Any non-2xx without an `error` | `{"error": "platform fetch failed (<status>)"}` |
| No connection | `{"error": "platform fetch unreachable: <message>"}` |
| `CONTROL_URL` unset | `{"error": "platform effects are not configured"}`, without a request |

So a control plane has two ways to refuse, and the piece sees the same thing for both. Use `200` when the outcome should carry fields beside `error` (for example `{"error": "connect_required", "connect_url": "..."}`), because a non-2xx reply keeps only `error`.

Always reply with a JSON **object**. A `200` whose body is JSON `null` or a bare value makes the kernel fail the piece's call.

The kernel logs each effect to the piece's log as `effect <kind> <target> -> ok` or `-> denied: <error>`.

**What the kernel checks before sending**, for every kind: `then` is a valid method name (else `422 invalid effect: missing continuation reducer name in \`then\``); the chain is under 8 deep; and the effect has one of the shapes below (else `422 invalid effect: expected fetch:, search:, ...`). The kinds are tried in this order and the first that matches is used: `read`, `remove`, `save`/`preview`, `fetch`, `search`, `extract`, `llm`, `mcp`, `call`, `browser`, `notify`. The kernel checks shapes only. Whether the piece may do the thing is entirely the control plane's decision.

In each subsection, "piece returns" is the effect object without `then`; "kernel sends" is the request body without `invoker`; "kernel reads" is what the kernel itself uses from the reply; "should return" is what a control plane should send so that pieces written for one control plane work on another.

#### `fetch`

| | |
|---|---|
| Piece returns | `{fetch: "<url>", method?: "GET"}` |
| Kernel checks | `fetch` is a string |
| Kernel sends | `{"kind": "fetch", "url": "<url>", "method": "GET"}`. `method` is whatever the piece gave, default `"GET"`; it is not validated |
| Kernel reads | Nothing |
| Should return | `{"status": 200, "body": "<text>", "json": <parsed body or null>}` |

A control plane should allow only `GET` and `HEAD`, only `https`, refuse hosts that resolve to private addresses, not follow redirects, and cut the body (1,000,000 bytes is the value pieces are written against).

#### `search`

| | |
|---|---|
| Piece returns | `{search: "<query>", since?: "day" \| "week" \| "month"}` |
| Kernel checks | `search` is a string |
| Kernel sends | `{"kind": "search", "query": "<query>", "since": "week"}`. `since` is present only when the piece gave a string; its value is not validated |
| Kernel reads | Nothing |
| Should return | `{"results": [{"title": "..", "url": "..", "snippet": "..", "published": "2026-01-31"}], "since": "week"}`. `published` (a date) and `since` only when known |

#### `extract`

| | |
|---|---|
| Piece returns | `{extract: "<url>"}` |
| Kernel checks | `extract` is a string |
| Kernel sends | `{"kind": "extract", "url": "<url>"}` |
| Kernel reads | Nothing |
| Should return | `{"markdown": "<the page as markdown>", "title": "<page title or null>"}` |

#### `save`

Fetches files and keeps them in the piece.

| | |
|---|---|
| Piece returns | `{save: "<url>"}` or `{save: ["<url>", ...]}`, with optional `expires: <days>` |
| Kernel checks | 1 to 12 strings (non-strings are dropped first), else `422 invalid effect: save: takes 1 to 12 URLs` |
| Kernel sends | `{"kind": "save", "urls": ["<url>", ...]}` |
| Kernel reads | `files`: an array. Per entry: `url`, `error`, `name`, `base64` |
| Should return | `{"files": [{"url": "..", "name": "photo.jpg", "type": "image/jpeg", "base64": ".."}, {"url": "..", "error": "not found"}]}`, one entry per URL, in order |

The kernel decodes each `base64`, stores it as a stored file (section 3: type read from the bytes, 1 MB per file, piece totals), with `source` set to the entry's `url`, `by` the invoker and the lifetime from `expires`. `type` in the reply is not used. One file failing costs that entry only.

The continuation receives:

- for `save: "<url>"`: `{file: {id, name, type, bytes}}` or `{error: "..."}`
- for `save: [...]`: `{files: [{url, file: {id, name, type, bytes}} | {url, error}]}`

If the whole reply is an error, the continuation receives that `{error}`.

#### `preview`

Fetches each page's own description of itself and keeps its picture.

| | |
|---|---|
| Piece returns | `{preview: ["<url>", ...]}`, with optional `expires: <days>` |
| Kernel checks | An array of 1 to 12 strings |
| Kernel sends | `{"kind": "preview", "urls": ["<url>", ...]}` |
| Kernel reads | `previews`: an array. Per entry: `image` (`name`, `base64`, `url`) and the entry's `url` |
| Should return | `{"previews": [{"url": "..", "title": "..", "description": "..", "site": "example.com", "image": {"url": "..", "name": "og.jpg", "type": "image/jpeg", "base64": ".."}}]}`. `image` is `null` when there is none. An entry that failed is `{"url": "..", "error": ".."}` |

The kernel stores each `image` as a stored file and replaces it with the file ref, or `null` when there was none or it could not be kept. Every other field of an entry passes through. The continuation receives `{previews: [{url, title, description, site, image: {id, name, type, bytes} | null}]}`.

The reply must carry a `previews` array; without one the continuation receives `{files: []}`.

#### `llm`

| | |
|---|---|
| Piece returns | `{llm: {prompt: "<text>", system?: "<text>"}}` |
| Kernel checks | `llm` is an object and `prompt` a string |
| Kernel sends | `{"kind": "llm", "prompt": "<text>", "system": "<text>" \| null}` |
| Kernel reads | Nothing |
| Should return | `{"text": "<the model's answer>"}` |

The piece does not choose the model; the control plane does.

#### `mcp`

Calls a tool on an MCP server the control plane knows.

| | |
|---|---|
| Piece returns | `{mcp: {server: "<name>", tool: "<name>", args?: {..}}}` |
| Kernel checks | `server` and `tool` are strings |
| Kernel sends | `{"kind": "mcp", "server": "<name>", "tool": "<name>", "args": {..}}`. `args` defaults to `{}`; it is named arguments, an object |
| Kernel reads | Nothing |
| Should return | `{"result": <the tool's result>}`; a tool failure as `{"error": "<text>"}`; a user who has not connected an account as `{"error": "connect_required", "server": "<name>", "connect_url": "<url>"}` with status `200` |

By convention the tool name `__describe` lists the server's tools: `{"result": {"server": "<name>", "tools": [...]}}`.

#### `call`

Calls a method of another piece. On the wire the kind is `cell_link`, and in piece code the target is named by the key `cell`.

| | |
|---|---|
| Piece returns | `{call: {cell: "<target>", method: "<name>", args?: [..]}}` |
| Kernel checks | `call.cell` and `call.method` are strings |
| Kernel sends | `{"kind": "cell_link", "target": "<target>", "method": "<name>", "args": [..], "chain": ["<piece id>", ...]}`. `args` defaults to `[]`; it is positional, an array. `chain` is the `chain` the current call arrived with (`[]` for a call from a page or a schedule) |
| Kernel reads | Nothing |
| Should return | `{"result": <the target method's result>}` |

The kernel does not make the call. The control plane resolves `target` to a piece (how pieces are named to one another is the control plane's business), checks that this piece may reach it and that the invoker may use it, and then calls the kernel's `POST /pieces/{target}/rpc/{method}` with `{"args": [...], "chain": [...chain, <calling piece id>], "user": <invoker>}`. It should send no `x-kernel-scope`, so the target's interface gate applies. It should refuse a target already in the chain and cap the chain's length (4 is the value in use); the kernel refuses only a `chain` longer than 8. It should bound the size of `args` and of the result.

By convention the method `__describe` is answered by the control plane without a call into the target's code: `{"result": {"cell": "<name>", "methods": [...]}}`, with `methods` taken from the target's `GET describe`.

#### `browser`

One action per effect, so the control plane can check each. The piece returns `{browser: {...}}`; the sub-shape decides the kind. Renamed on the wire: `format` is sent as `content_format`, `act` as `browser_action`, `fullPage` as `full_page`.

| Piece returns (`browser:`) | Kernel sends | Should return |
|---|---|---|
| `{scrape: "<url>", format?}` | `{"kind": "browser_scrape", "url", "content_format": <format or null>}` | `{"content": "..", "title": "..", "url": ".."}` |
| `{screenshot: "<url>", fullPage?}` | `{"kind": "browser_screenshot", "url", "full_page": true \| false}` | `{"image_url": "..", "url": ".."}` |
| `{session: "create"}` | `{"kind": "browser_session"}` | `{"session": "<id>", "expires_in_minutes": 10}` |
| `{session: "<id>", release: true}` | `{"kind": "browser_session", "session": "<id>", "release": true}` | `{"session": "<id>", "status": ".."}` |
| `{session: "<id>", liveView: true}` | `{"kind": "browser_live_view", "session": "<id>"}` | `{"session": "<id>", "login_url": "..", "expires_in_minutes": 7}` |
| `{session: "<id>", goto: "<url>"}` | `{"kind": "browser_goto", "session": "<id>", "url"}` | `{"url": "<where it landed>", "title": ".."}` |
| `{session: "<id>", read: true, format?}` | `{"kind": "browser_read", "session": "<id>", "content_format": <format or null>}` | `{"url": "..", "title": "..", "content": "..", "truncated": false}` |
| `{session: "<id>", act: {type, selector, text? \| key? \| value?}}` | `{"kind": "browser_act", "session": "<id>", "browser_action": <the act object, unchanged>}` | `{"acted": "<type>", "url_before": "..", "url": ".."}` |

The kernel checks, in this order: `scrape` is a string; `screenshot` is a string; `session` is `"create"`; `session` is a non-empty string with one of `release: true`, `liveView: true`, a string `goto`, `read: true`, or an `act` object with a string `type`. Otherwise `422 invalid browser effect: ...`. It reads nothing from the reply.

Values the kernel passes through without checking, as pieces are written against them: `format` is `markdown` (default), `html` or `readability`; an action's `type` is `click`, `type` (append text), `fill` (replace text), `press` (a key; `selector` optional) or `select` (a `value`). `full_page` is `true` only when the piece gave exactly `true`.

`login_url` is an address a person opens to drive the session themselves (to log in, say). It should be absolute: the piece's page shows it as a link, and the page lives on the kernel's origin.

#### `notify`

Says something to the piece's owner.

| | |
|---|---|
| Piece returns | `{notify: {text: "<message>", via?: "<medium>"}}` |
| Kernel checks | `notify` is an object and `text` a string |
| Kernel sends | `{"kind": "notify", "text": "<message>", "via": "<medium>" \| null}` |
| Kernel reads | Nothing |
| Should return | `{"sent": true, "via": "<medium used>"}`; a message that could not be sent as `{"error": "<why>"}` |

There is no recipient field, on purpose. The control plane sends to the piece's owner, resolved from its own records, so nothing a piece read from the web can redirect a message. `via` names a medium the control plane offers (`sms` and `slack` are the values in use); `null` means the control plane's default.

#### `read` and `remove`

Answered inside the kernel. The control plane is not called.

| Piece returns | The continuation receives |
|---|---|
| `{read: "<file id>"}` | `{text: "..", type: ".."}` for a stored text file (`text/*`, JSON, SVG); otherwise `{error: "no such file: <id>"}` or `{error: "<name> is <type>, which cannot be read as text"}` |
| `{remove: ["<file id>", ...]}` | `{removed: <how many were found and deleted>}` |

### 6.2 The usage callback

Section 8.

### 6.3 The schedule-paused callback

Section 7.

## 7. Schedules

The control plane is the record of which schedules exist. The kernel holds a mirror of the **enabled** ones only, per org, and does the timing. To disable a schedule, delete it from the kernel; to enable it, put it.

### `PUT /scheduler/:org/schedules/:id`

`:id` is the control plane's id for the schedule (any text without `/`).

```json
{ "cellUuid": "p1", "task": "refresh",
  "spec": { "freq": "daily", "timeZone": "America/Chicago", "hour": 8, "minute": 0 } }
```

| Field | Meaning |
|---|---|
| `cellUuid` | The piece id. The field keeps this name on the wire |
| `task` | A method of the piece's `tasks.js`; must match `^[a-zA-Z]\w*$`. Not checked against the piece's code until it fires |
| `spec` | One of the shapes below |

| `freq` | Other fields | Fires |
|---|---|---|
| `"hourly"` | `timeZone`, `minute` 0–59 | At that minute of every hour |
| `"daily"` | `timeZone`, `hour` 0–23, `minute` | At that local time every day |
| `"weekly"` | `timeZone`, `hour`, `minute`, `byDay`: non-empty array of `MO TU WE TH FR SA SU` | At that local time on those days |
| `"interval"` | `timeZone`, `intervalSeconds`: integer, at least 60 | Every that many seconds of elapsed time |

`timeZone` is required in every shape and must be a string (an IANA name such as `America/Chicago`). Wall-clock schedules keep their local time across daylight-saving changes. The kernel checks only that `timeZone` is a string; a name the runtime does not know fails the request with a `500`.

Responses: `200 {"ok": true, "id": "<id>", "nextAt": <ms>}`. `400` with `schedule requires cellUuid`, `schedule requires a tasks.js export name` or `invalid schedule spec`.

Putting a schedule that is identical to the stored one (same piece, task and spec) changes nothing: it keeps its next time and its failure count. Anything different replaces it and resets both. The first firing of a new wall-clock schedule is its next occurrence; the first firing of a new interval schedule is at a random moment within one interval.

### `DELETE /scheduler/:org/schedules/:id`

`200 {"ok": true}`, whether or not it existed. Removes the schedule and its run history.

### `GET /scheduler/:org/schedules`

```json
{ "schedules": [ { "id": "17", "cellUuid": "p1", "task": "refresh", "nextAt": 1760000000000, "failures": 0,
                   "lastRun": { "runId": "17-1759996400000", "startedAt": 1, "finishedAt": 2, "status": "ok" } } ],
  "nextAlarm": 1760000000000 }
```

`lastRun` is `null` before the first run. `nextAlarm` is when the kernel will next wake for this org, or `null`.

### `GET /scheduler/:org/schedules/:id/runs`

```json
{ "id": "17", "nextAt": 1760000000000, "failures": 1,
  "runs": [ { "runId": "17-1759996400000", "startedAt": 1, "finishedAt": 2, "status": "error", "error": "cell method refresh failed: boom" } ] }
```

Oldest first, the last 20. `404 {"error":"no such schedule"}` when the schedule is not in the mirror, which includes one the kernel has paused.

### How the kernel fires

- One timer per org wakes at the earliest `nextAt`. Each pass takes up to 20 due schedules, earliest first, and runs them one after another.
- A run is the piece's `task/:name` route with `{"runId": "<scheduleId>-<nextAt>"}` and no invoker. So effects made by a scheduled run carry no `invoker`, the run uses the pinned version when there is one, and the piece will not run the same `runId` twice or two runs of one task at once.
- A run is `ok` when the task route answers 2xx. That includes a run the piece skipped, and a run whose effects were refused: a refusal reaches the continuation as `{error}` and is not a failure. A run is an `error` when the task is missing, throws, or exceeds a limit.
- After an `ok` run the failure count returns to 0 and the next time is computed from now, not from the slot that ran. Occurrences missed while the kernel was down are skipped, not replayed.

### Backoff and "paused for failures"

After a failed run the schedule is retried after `min(60 s x 2^(failures - 1), 60 min)`: 1, 2, 4 and 8 minutes after the first four consecutive failures.

On the fifth consecutive failure the kernel stops the schedule: it sends the callback below, then removes the schedule from its mirror whether or not the callback succeeded. The schedule does not fire again until the control plane puts it again.

```
POST {CONTROL_URL}/api/v1/pieces/schedules/{scheduleId}/status
signed path: /{org}/pieces/schedules/{scheduleId}/status
```

```json
{ "status": "paused_failures", "reason": "cell method refresh failed: boom" }
```

`status` is always `"paused_failures"`; the kernel reports nothing else. `reason` is the last error, cut to 500 characters.

The kernel ignores the reply entirely: status, body, and failure to connect. It sends this once and does not retry. A control plane should record the schedule as paused and reply `200 {"ok": true}`; it should accept only `paused_failures`, so this callback can never start something running. Because the callback can be lost, a control plane that wants to be sure can compare its enabled schedules with `GET schedules`.

## 8. Usage reporting

The kernel times each call into piece code: the wall time around the reducer, for the first call and each continuation separately. Waiting for effects is not counted. Failed calls are counted. Test runs are not.

Time is added up per piece, one entry per payer:

| Entry | When |
|---|---|
| `{"invoker": "<user>", "task": false}` | A call that named a user |
| `{"invoker": null, "task": false}` | An `rpc` with no `user` |
| `{"invoker": null, "task": true}` | A task run with no invoker (a schedule) |

A task run by hand counts under its invoker with `task: false`.

**Batches.** The kernel sends what has accumulated at most once every 60 seconds while the piece is in use, and at the end of every task run.

```
POST {CONTROL_URL}/api/v1/pieces/{piece}/usage
signed path: /{org}/pieces/{piece}/usage
```

```json
{ "batch": "0b2f6c1e-5d0a-4c58-9b1d-0f8f5f0f6f11",
  "entries": [ { "invoker": "42", "task": false, "calls": 3, "ms": 12 },
               { "invoker": null, "task": true, "calls": 1, "ms": 40 } ] }
```

`batch` is a UUID. `calls` is the number of calls, `ms` their total time.

| Reply | The kernel does |
|---|---|
| 2xx | The batch is done. The body is not read |
| 5xx, or no connection | Keeps the batch and sends **the same batch, with the same id,** again after 60 seconds, until it is taken |
| Any other status | Drops the batch. A refusal (bad signature, unknown piece) would be refused again |

Only one batch is in flight at a time. Time recorded while a batch is waiting goes into the next one.

A control plane should reply `200 {"ok": true}` and treat `(piece, batch, position of the entry)` as an idempotency key, because a batch whose reply was lost arrives again. It should decide who pays: by convention the invoker when it names a user it knows, and the piece's owner otherwise, with `task: true` being the owner's background work.

**What is dropped:** batches refused with a non-5xx status; all usage when `CONTROL_URL` is unset; and whatever was unreported when a piece is destroyed.

## 9. Limits

Enforced by the kernel:

| Limit | Value | Where it applies |
|---|---|---|
| Service auth clock window | ±60 s | Every service-auth request, both directions |
| Org id, piece id | 1–64 characters, `[A-Za-z0-9_-]`, first not `_` or `-` | Every route |
| Files in a piece | 64 | The set that results from a deploy |
| One code file | 1,000,000 characters (base64 length for a binary file) | Each file sent in a deploy |
| Versions kept | No limit; none are deleted | |
| Method, task and continuation names | `^[a-zA-Z]\w*$` | `rpc`, `task`, `call`, `then`, schedules, `interface.js` |
| CPU per call into piece code | 2,000 ms | Each reducer and each continuation |
| Effects in one chain | 8 | One `rpc`, session `call` or task run |
| `chain` length | 8 | `rpc` request body |
| URLs in one `save` or `preview` | 12 | Checked before the callback |
| One stored file | 1,000,000 bytes | Upload, `save`, `preview`, import |
| Stored files per piece | 500 files, 50,000,000 bytes | The same |
| Stored file name | Last 100 characters, `[\w.-]` | The same |
| Log lines kept | 500, each 1,000 characters | Per piece |
| `logs?limit` | Default 100, at most 500 | `GET logs` |
| Page log | 30 a minute; body 2,000 characters; message 600 | `page-log`, per piece |
| Test scenarios | 50, each 1–8 steps | `tests.js` |
| Schedule interval | At least 60 s | `PUT schedules/:id` |
| Due schedules per pass | 20 | Per org |
| Consecutive failures before a schedule stops | 5 | Per schedule |
| Retry delay after a failed run | 60 s doubling, at most 60 min | Per schedule |
| Runs kept | 20 | Per schedule |
| Paused reason | 500 characters | The schedule-paused callback |
| Usage flush | Every 60 s at most; retry after 60 s | Per piece |
| Stored file cache lifetime | 3,600 s, private | `files/:id`, `assets/:name` responses |
| Timeout on callbacks | None set by the kernel | All three callbacks |
| Request and state size | None set by the kernel. Any ceiling comes from the runtime and is Not determined | |

Not enforced by the kernel. A control plane should apply limits of its own to what it performs; these are the values pieces are currently written against:

| Limit | Value |
|---|---|
| `fetch` | `GET` and `HEAD`; `https` only; 10 s; body cut at 1,000,000 bytes; no redirects |
| `search` | Query 2–400 characters; at most 10 results; `since` one of `day`, `week`, `month` |
| `extract` | Markdown cut at 1,000,000 bytes |
| `save`, `preview` | 45 s for the whole list, the rest reported as errors; at most 3 redirects, each checked; a download of at most 5,000,000 bytes, which must be at most 1,000,000 when sent to the kernel; preview text 300 characters |
| `llm` | Prompt 60,000 characters; answer 4,000 tokens |
| `call` | Arguments 64,000 bytes; result 256,000 bytes; 30 s; chain of 4 pieces; no cycles |
| `mcp` | Arguments 64,000 bytes; result 256,000 bytes; 30 s; error text 500 characters |
| `browser` | Content cut at 5,000,000 bytes; a session lasts 10 minutes |
| `notify` | 1,000 characters; 10 messages per piece per day |
| Usage batch | 100 entries read |
| Ticket lifetime | 5 minutes |

## 10. Older names

Pieces were once called cells. The kernel still accepts or sends the following, so a control plane written against the older names keeps working. A new control plane should use none of them.

| Older name | Current name | What the kernel does |
|---|---|---|
| `/cells/:id/...` | `/pieces/:id/...` | Answers both. The signed path uses the word that is in the URL: `/{org}/cells/{id}/{route}` for the one, `/{org}/pieces/{id}/{route}` for the other. A signature made for one is not good for the other |
| Ticket field `cell` | `piece` | Reads `piece`, and `cell` when `piece` is absent |
| `RAILS_URL` | `CONTROL_URL` | When `CONTROL_URL` is unset and `RAILS_URL` is set, callbacks go to `{RAILS_URL}/api/v1/cells/{id}/fetch`, `/api/v1/cells/{id}/usage` and `/api/v1/cells/schedules/{id}/status`, signed as `/{org}/cells/...`. When `CONTROL_URL` is set it is used, with `/pieces/`, whatever `RAILS_URL` holds |
| File `cell.js` | `piece.js` | A deploy that sends `cell.js` has it stored as `piece.js` (ignored if `piece.js` is also sent). `cell.js` in a `delete` list means `piece.js`. A stored set that still holds `cell.js` is read as if it were `piece.js` |
| `Cell` exported by `costa.js` | `Piece` | Both are exported; `Cell` is the same class |

Names that are unchanged, and will stay, because stored data or deployed pieces depend on them:

| Name | Where |
|---|---|
| `cellUuid` | The piece id in schedule requests and responses |
| `cell_link` | The `kind` of the `call` effect on the wire |
| `call: { cell: ... }` | The key naming the target in a piece's `call` effect |
| `cellState`, `cellState:<user>` | The storage keys of shared and personal state |
| `CellHost`, `CELL_HOST`, `cells-kernel` | The registered class, its binding, and the name the kernel is deployed under. Every piece's storage is filed under them |
| `cell:ready`, `window.__cellReady` | The page's "painted" signal |
| `/cell-sdk.js` | The page SDK's address on the kernel origin |
| The word "cell" in error text | Many error messages, for example `bad cell id` and `cell method x failed`. Match on status codes, not on this text |
