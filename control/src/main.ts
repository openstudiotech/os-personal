// Starts the control plane. It listens on this machine only unless told
// otherwise. On this machine alone there is nothing to type to get in. Told
// to listen further afield, it asks for its secret.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { Store } from "./store.ts";
import { createApp } from "./server.ts";
import { listen } from "./listen.ts";
import { reconcile } from "./schedules.ts";
import { KernelClient } from "./kernel.ts";
import type { SecretAt } from "./views.ts";

const data = process.env.OPENSTUDIO_DATA ?? "data";
mkdirSync(data, { recursive: true });

// Railway tells a service which project, service and environment it is, which
// is enough to link to the page holding its variables.
const { RAILWAY_PROJECT_ID: project, RAILWAY_SERVICE_ID: service, RAILWAY_ENVIRONMENT_ID: environment } = process.env;
let secret = process.env.OPENSTUDIO_SECRET ?? "";
let secretAt: SecretAt = {
  variable: "OPENSTUDIO_SECRET",
  link: project && service && environment ? `https://railway.com/project/${project}/service/${service}/variables?environmentId=${environment}` : undefined,
};
if (!secret) {
  const file = `${data}/secret`;
  if (!existsSync(file)) {
    writeFileSync(file, randomBytes(24).toString("base64url"), { mode: 0o600 });

  }
  secret = readFileSync(file, "utf8").trim();
  secretAt = { file };
}

const kernel = new KernelClient({
  url: process.env.KERNEL_URL ?? "http://127.0.0.1:28181",
  secret: process.env.KERNEL_SECRET ?? "dev-secret-change-me",
});
const store = new Store(`${data}/openstudio.sqlite`, secret);
const host = process.env.HOST ?? "127.0.0.1";
// The secret always exists: it seals the keys and makes the AI client's
// token. It is only asked for when this can be reached from elsewhere.
// Under Docker it has to listen on every address for a published port to
// reach it, and cannot see that the port is published to this machine only.
// OPENSTUDIO_UNSAFE_NO_SECRET says so.
const local = process.env.OPENSTUDIO_UNSAFE_NO_SECRET === "1" || ["127.0.0.1", "localhost", "::1"].includes(host);
const port = Number(process.env.PORT ?? 4010);
// The address people reach this at: where a service sends them back after
// they sign in, and where a piece sends them to use its browser. On this
// machine it is known. Anywhere else it has to be said, since behind a
// proxy or a domain name this cannot tell.
// Listening on every address is not an address to visit.
const origin = process.env.OPENSTUDIO_URL?.replace(/\/+$/, "") || (local ? `http://${["0.0.0.0", "::"].includes(host) ? "127.0.0.1" : host}:${port}` : undefined);
const app = createApp({ store, secret, kernel, local, origin, secretAt });

// The kernel may have stopped a schedule while this was not running.
await reconcile({ store, kernel }).catch(() => console.log("The kernel is not answering yet. Start it, then reload."));
await listen(app, port, host);
console.log(`OpenStudio Personal is at ${origin ?? `http://${host}:${port}`}`);
if (!origin) console.log("Set OPENSTUDIO_URL to the address you reach it at (https://studio.example.com), or signing in to services will send you back to the wrong place.");
if (!local) console.log(`It can be reached from other machines, so it will ask for the secret in ${data}/secret, once per browser.`);
