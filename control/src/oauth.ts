// Signing in to a service that asks for it. This is the flow MCP servers
// use: find out where the service's sign-in lives, introduce this app to it,
// send the person there, and trade what comes back for a token. The token
// and what renews it are sealed; neither is ever shown.
import { createHash, randomBytes } from "node:crypto";
import { address, type Deps } from "./effects.ts";

type Reach = Pick<Deps, "store" | "http" | "resolve">;
const OWN = /^(localhost|127\.0\.0\.1|\[::1\])$/;

export interface Client { id: string; secret?: string }
export interface Pending { key: string; name: string; url: string; verifier: string; client: Client; token: string; redirect: string; at: number; resource: boolean }
// A sign-in whose addresses are known beforehand, as Google's are.
export interface Known { authorize: string; token: string; scopes: string[]; extra?: Record<string, string> }
interface Plan { authorize: string; token: string; register: string | null; scopes: string[] }

// Where the person is sent to sign in, and what to remember until they are
// back. `given` is a client the operator registered by hand, for a service
// that will not let an app introduce itself.
export async function begin(deps: Reach, service: { key: string; name: string; url: string }, redirect: string, given?: Client, known?: Known): Promise<{ to: string; state: string; pending: Pending }> {
  const plan = known ? { ...known, register: null } : await discover(deps, new URL(service.url));
  const client = given?.id ? given : await introduce(deps, plan, service, redirect);
  const verifier = randomBytes(32).toString("base64url");
  const state = randomBytes(16).toString("base64url");
  const to = new URL(plan.authorize);
  for (const [name, value] of Object.entries({
    response_type: "code", client_id: client.id, redirect_uri: redirect, state, ...(known ? known.extra : { resource: service.url }),
    code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256",
    ...(plan.scopes.length ? { scope: plan.scopes.join(" ") } : {}),
  })) to.searchParams.set(name, value);
  return { to: to.href, state, pending: { ...service, verifier, client, token: plan.token, redirect, at: Date.now(), resource: !known } };
}

// Back from signing in: trade the code for a token and keep it.
export async function finish(deps: Reach, pending: Pending, code: string): Promise<void> {
  const granted = await trade(deps, pending.token, pending.url, pending.client, {
    grant_type: "authorization_code", code, redirect_uri: pending.redirect, code_verifier: pending.verifier,
  }, pending.resource);
  keep(deps, pending.key, { client: pending.client, token: pending.token, url: pending.url, resource: pending.resource }, granted);
}

// The token to send, renewed first if it has run out. `force` renews it
// whatever its age, for a service that has just refused it.
export async function bearer(deps: Reach, key: string, force = false): Promise<string | null> {
  const kept = deps.store.open(`oauth:${key}`);
  if (!kept) return deps.store.open(`service:${key}`);
  const signed = JSON.parse(kept);
  if (signed.refresh && (force || (signed.expires && Date.now() > signed.expires - 60_000))) {
    const granted = await trade(deps, signed.token, signed.url, signed.client, { grant_type: "refresh_token", refresh_token: signed.refresh }, signed.resource !== false);
    keep(deps, key, signed, { refresh_token: signed.refresh, ...granted });
  }
  return deps.store.open(`service:${key}`);
}

export const signedIn = (deps: Pick<Deps, "store">, key: string): boolean => deps.store.has(`oauth:${key}`);

function keep({ store }: Reach, key: string, signed: { client: Client; token: string; url: string; resource?: boolean }, granted: any): void {
  store.seal(`service:${key}`, String(granted.access_token));
  store.seal(`oauth:${key}`, JSON.stringify({
    client: signed.client, token: signed.token, url: signed.url, resource: signed.resource !== false, refresh: granted.refresh_token ?? null,
    expires: Number(granted.expires_in) > 0 ? Date.now() + Number(granted.expires_in) * 1000 : null,
  }));
}

async function trade(deps: Reach, endpoint: string, resource: string, client: Client, fields: Record<string, string>, named = true): Promise<any> {
  const { http = fetch } = deps;
  const reply = await http((await safe(deps, endpoint, resource)).href, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ ...fields, client_id: client.id, ...(client.secret ? { client_secret: client.secret } : {}), ...(named ? { resource } : {}) }).toString(),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const granted: any = await reply.json().catch(() => null);
  // What it said is not repeated: it may hold the code or a token.
  if (!reply.ok || !granted?.access_token) throw new Error("the sign-in was not accepted");
  return granted;
}

async function introduce(deps: Reach, plan: Plan, service: { name: string; url: string }, redirect: string): Promise<Client> {
  if (!plan.register) throw new Error(`${service.name} needs a client ID. Register an app with it, with ${redirect} as its redirect address, and enter the ID here`);
  const { http = fetch } = deps;
  const reply = await http((await safe(deps, plan.register, service.url)).href, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "OpenStudio Personal", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: "none",
    }),
    redirect: "error", signal: AbortSignal.timeout(30_000),
  });
  const made: any = await reply.json().catch(() => null);
  if (!reply.ok || !made?.client_id) throw new Error(`${service.name} would not let this app introduce itself (${reply.status})`);
  return { id: String(made.client_id), ...(made.client_secret ? { secret: String(made.client_secret) } : {}) };
}

// Where the service says its sign-in lives. It is asked first; then the
// well-known places are tried.
async function discover(deps: Reach, url: URL): Promise<Plan> {
  const { http = fetch } = deps;
  const read = async (candidate: string): Promise<any> => {
    try {
      const reply = await http((await safe(deps, candidate, url.href)).href, { headers: { accept: "application/json" }, redirect: "error", signal: AbortSignal.timeout(15_000) });
      return reply.ok ? await reply.json() : null;
    } catch { return null; }
  };
  const path = url.pathname.replace(/\/$/, "");
  const probe = await http(url.href, {
    method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "openstudio-personal", version: "0.1.0" } } }),
    redirect: "error", signal: AbortSignal.timeout(15_000),
  }).catch(() => null);
  const named = probe?.headers.get("www-authenticate")?.match(/resource_metadata="([^"]+)"/)?.[1];

  let resource: any = null;
  for (const candidate of [named, `${url.origin}/.well-known/oauth-protected-resource${path}`, `${url.origin}/.well-known/oauth-protected-resource`]) {
    if (candidate && (resource = await read(candidate))?.authorization_servers?.length) break;
  }
  const issuer = new URL(String(resource?.authorization_servers?.[0] ?? url.origin));
  const under = issuer.pathname.replace(/\/$/, "");
  for (const candidate of [
    `${issuer.origin}/.well-known/oauth-authorization-server${under}`, `${issuer.origin}/.well-known/openid-configuration${under}`,
    `${issuer.origin}${under}/.well-known/openid-configuration`, `${issuer.origin}/.well-known/oauth-authorization-server`,
  ]) {
    const found = await read(candidate);
    if (!found?.authorization_endpoint || !found?.token_endpoint) continue;
    await safe(deps, found.authorization_endpoint, url.href);
    return {
      authorize: String(found.authorization_endpoint), token: String(found.token_endpoint),
      register: found.registration_endpoint ? String(found.registration_endpoint) : null,
      scopes: Array.isArray(resource?.scopes_supported) ? resource.scopes_supported.map(String) : [],
    };
  }
  throw new Error("that service does not offer a sign-in");
}

// An address the service handed us. It chose it, not the operator, so it
// must be public https, unless the service itself is on this machine.
async function safe(deps: Reach, given: string, service: string): Promise<URL> {
  const url = new URL(given);
  if (OWN.test(new URL(service).hostname) && OWN.test(url.hostname)) return url;
  const found = await address(deps, url.href, ["*"]);
  if (!(found instanceof URL)) throw new Error("that service pointed somewhere it may not");
  return found;
}
