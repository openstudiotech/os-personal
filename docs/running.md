# Running OpenStudio Personal

The short way, the tests and connecting Google are in the [README](../README.md). This is the rest.

## From source

Needs Node 22.18 or later and a celld binary at `.dev/celld-v0.6.2-openstudio.1`.

```sh
cd kernel && npm ci
cd ../control && npm ci
npm run kernel     # the kernel, on http://127.0.0.1:28181, state in kernel/.celld
npm start          # the control plane, on http://127.0.0.1:4010
```

| | |
|---|---|
| `kernel/` | Runs pieces. Each piece's code runs sealed, with no network |
| `control/` | The control plane: your keys, your pieces, what each may reach, and Marcel |

## Who can reach it

It listens on this machine only, and there it asks for nothing: whoever can use this computer can use it. It refuses requests that come from pages on other websites.

Set `HOST` to let other machines reach it. It then asks for a secret, once per browser, which it writes to `control/data/secret` on first start.

In a container it has to listen beyond the container itself, so it would ask for the secret. The command in the README publishes its ports to `127.0.0.1` alone and sets `OPENSTUDIO_UNSAFE_NO_SECRET=1` to say so. Leave that setting out if you publish the ports any other way.

## Settings

All are environment variables, and none is needed on your own machine.

| | Default | |
|---|---|---|
| `HOST` | `127.0.0.1` | Where it listens. `0.0.0.0` lets other machines in |
| `PORT` | `4010` | |
| `OPENSTUDIO_UNSAFE_NO_SECRET` | unset | `1` says only this machine can reach it though `HOST` says otherwise, so it asks for no secret. For a container whose port is published to `127.0.0.1` alone. Never set it on anything other machines can reach |
| `OPENSTUDIO_URL` | `http://127.0.0.1:4010` | The address you reach it at, such as `https://studio.example.com`. Set it whenever that is not the default: services send you back here after you sign in, so it is also the redirect address you give Google |
| `OPENSTUDIO_DATA` | `data` | The folder holding the database and the secret |
| `OPENSTUDIO_SECRET` | made on first start | Seals your keys. Losing it loses them |
| `KERNEL_URL` | `http://127.0.0.1:28181` | Where the kernel is |
| `KERNEL_SECRET` | `dev-secret-change-me` | Shared with the kernel. Change it in both places if anything but you can reach the kernel |

## On Railway

`.railway/railway.ts` describes it for [Railway](https://railway.com): the kernel and the control plane as two services built from the `Dockerfile`, each with a volume. 

1. In a Railway project linked to this repository, run `railway config apply`.
2. Give each service a generated domain. The browser loads pieces straight from the kernel, so it needs one too.
3. Set `KERNEL_SECRET` on the kernel and `OPENSTUDIO_SECRET` on the control plane, each to a long random value. The kernel will not start without its secret.
4. Deploy both, and open the control plane's domain. It asks for `OPENSTUDIO_SECRET`, once per browser, and links to where Railway keeps it.

Anyone who has the address can reach the page that asks for the secret, so the secret is all that keeps them out.
