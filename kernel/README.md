# The kernel

The kernel of OpenStudio Personal. It runs pieces. It is a worker deployed to celld: one Durable Object per piece (name
`${org}:${pieceId}`), with the piece's code in a Worker Loader isolate that has
`globalOutbound: null`, so piece code has no network at all. Everything a piece
wants from outside itself it asks the control plane for.

## Auth (a secret shared with the control plane: `KERNEL_SECRET`)

- **Service auth** (the control plane → kernel): `Authorization: Kernel v1.<ts>.<hmac>` where the
  HMAC covers `ts.method./{org}/pieces/{piece}/{route}.sha256(body)`. The org is inside the
  signed path, so it can't be forged; ±60s replay window.
- **Session tickets** (browser → `/connect`): the control plane mints
  `base64url({org,piece,user,role,exp,preview?}).hmac`, passed as `?ticket=`. Every role
  may call any method: a role says what someone may change, and changing a piece is the
  control plane's to allow before it mints a ticket. The page is told the role so it can
  show what fits. `preview: true` runs head on a pinned piece; anything else runs the pin.

## Kernel API (`/pieces/:pieceId/...`)

| Route | Auth | Purpose |
|---|---|---|
| `PUT files` | service | Deploy piece code (validates the contract, smoke-loads) |
| `GET files`, `GET state`, `GET logs` | service | Inspect code / state / log ring buffer |
| `GET versions`, `GET versions/:n` | service | Every deploy's manifest (newest first) / one version's files |
| `POST versions/:n/restore` | service | Deploy version n again as a new version (`restoredFrom: n`); data untouched |
| `PUT pin` | service | `{version}` serves that version to everyone but previewers; `{version: null}` serves head |
| `POST rpc/:method` | service | Call a piece's method |
| `POST reload` | service | Drop and reload the isolate |
| `DELETE` | service | Destroy the piece (storage wiped) |
| `GET connect` | ticket | WebSocket → Cap'n Web RPC session (`whoami`, `call`, `subscribe`) |

## Older names

Pieces were once called cells. These still work, so a control plane that has
not changed keeps working:

- `/cells/:id/...` is answered as `/pieces/:id/...`. A call signed for one is not good for the other.
- A ticket may name its piece as `cell`.
- A control plane set as `RAILS_URL` and not `CONTROL_URL` is called back at `/api/v1/cells/...` and not `/api/v1/pieces/...`.

Some names stay as they were because stored data hangs on them: the Durable
Object is registered as `CellHost`, the worker is deployed as `cells-kernel`,
and storage keys such as `cellState` are unchanged.

## What a piece's code is

`export default class extends Piece` (from `./costa.js`, which the kernel supplies); each
method is a reducer `(state, ...args) -> {state?, result?}`. Returning `state`
saves it and pushes it to every subscribed page. No network in piece code.

## Running it

```sh
npm ci
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" ../.dev/celld-v0.6.2-openstudio.1 dev . --port 28181
```

`celld dev` keeps its state on local disk and needs no bucket. It watches this
folder and rebuilds when a file changes.

`KERNEL_SECRET` and `CONTROL_URL` are `vars` in `wrangler.jsonc`: the secret shared with the
control plane, and where the kernel sends what pieces ask for. Health: `/.well-known/celld/health`.

## A deploy that will not load

It is kept in the history with why it failed, and answered with `422`. If an earlier
version did load, that one is put back as a new version, so the piece keeps running and
head is always the newest. A version that failed to load cannot be restored or pinned.

## Testing it

```sh
npm run test:unit
CELLS_KERNEL_TEST_URL=http://127.0.0.1:28181 node --test --test-force-exit test/integration.test.mjs
CELLS_KERNEL_TEST_URL=http://127.0.0.1:28181 node --test --test-force-exit test/scheduler.test.mjs
```

Run the unit tests before starting the kernel, or separately. Their build
rewrites `dist-test/`, the kernel sees that and rebuilds, and integration tests
that are running at that moment fail.

## celld

This runs on celld from a fork (`github.com/openstudiotech/celld`): v0.6.2 plus the fix
for denoland/celld#258, which hangs every Cap'n Web call that reaches the Worker
Loader. Drop the fork once an upstream release carries the fix; the websocket
integration tests prove it.

## Thanks

To the cloudflare-os team. None of their code is here, but their work opened our minds to some of the ideas in this kernel.
