import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Store } from "../src/store.ts";
import { begin, bearer, finish } from "../src/oauth.ts";
import { tools } from "../src/services.ts";

const SERVICE = { key: "linear", name: "Linear", url: "https://mcp.linear.example/mcp" };
const BACK = "http://127.0.0.1:4010/services/callback";

// A service that asks for a sign-in, the way MCP servers do.
function world({ register = true, meta = {} as Record<string, unknown> } = {}) {
  const store = new Store(":memory:");
  const asked: Array<{ url: string; init: any }> = [];
  let issued = 0;
  const http = async (url: string, init: any = {}) => {
    asked.push({ url, init });
    const auth = init.headers?.authorization;
    if (url === SERVICE.url) {
      if (auth !== `Bearer access-${issued}`) return new Response("no", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.linear.example/.well-known/oauth-protected-resource/mcp"' } });
      const body = JSON.parse(init.body);
      return body.id === undefined ? new Response(null, { status: 202 }) : Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "list_issues" }] } });
    }
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) return Response.json({ authorization_servers: ["https://auth.linear.example"], scopes_supported: ["read"] });
    if (url === "https://auth.linear.example/.well-known/oauth-authorization-server") {
      return Response.json({ authorization_endpoint: "https://auth.linear.example/authorize", token_endpoint: "https://auth.linear.example/token",
        ...(register ? { registration_endpoint: "https://auth.linear.example/register" } : {}), ...meta });
    }
    if (url === "https://auth.linear.example/register") return Response.json({ client_id: "made-client" }, { status: 201 });
    if (url === "https://auth.linear.example/token") {
      const form = new URLSearchParams(init.body);
      if (form.get("grant_type") === "authorization_code" && form.get("code") !== "good-code") return Response.json({ error: "invalid_grant", code: form.get("code") }, { status: 400 });
      issued += 1;
      return Response.json({ access_token: `access-${issued}`, refresh_token: `refresh-${issued}`, expires_in: 3600 });
    }
    return new Response("not found", { status: 404 });
  };
  const deps = { store, http, resolve: async (host: string) => (host.startsWith("inside") ? ["10.0.0.9"] : ["93.184.216.34"]) };
  return { store, asked, deps };
}

test("signing in: the service is found, this app introduces itself, and the person is sent to sign in", async () => {
  const { deps, asked } = world();
  const { to, state, pending } = await begin(deps, SERVICE, BACK);
  const sent = new URL(to);
  assert.equal(sent.origin + sent.pathname, "https://auth.linear.example/authorize");
  assert.equal(sent.searchParams.get("client_id"), "made-client");
  assert.equal(sent.searchParams.get("redirect_uri"), BACK);
  assert.equal(sent.searchParams.get("state"), state);
  assert.equal(sent.searchParams.get("resource"), SERVICE.url);
  assert.equal(sent.searchParams.get("scope"), "read");
  assert.equal(sent.searchParams.get("code_challenge"), createHash("sha256").update(pending.verifier).digest("base64url"));
  assert.doesNotMatch(to, new RegExp(pending.verifier), "the verifier stays here");
  const registered = JSON.parse(asked.find((each) => each.url.endsWith("/register"))!.init.body);
  assert.deepEqual(registered.redirect_uris, [BACK]);
});

test("back from signing in, the code is traded for a token, which is sealed and used", async () => {
  const { deps, store, asked } = world();
  const { pending } = await begin(deps, SERVICE, BACK);
  await assert.rejects(finish(deps, pending, "stolen"), /^Error: the sign-in was not accepted$/);
  assert.equal(store.has("service:linear"), false);

  await finish(deps, pending, "good-code");
  const traded = new URLSearchParams(asked.findLast((each) => each.url.endsWith("/token"))!.init.body);
  assert.equal(traded.get("code_verifier"), pending.verifier);
  assert.equal(traded.get("client_id"), "made-client");
  store.addService(SERVICE);
  assert.deepEqual((await tools(deps, SERVICE)).map((tool) => tool.name), ["list_issues"]);
});

test("a token that has run out, or is refused, is renewed without anyone signing in again", async () => {
  const { deps, store } = world();
  const { pending } = await begin(deps, SERVICE, BACK);
  await finish(deps, pending, "good-code");
  store.addService(SERVICE);
  assert.equal(await bearer(deps, "linear"), "access-1");

  const signed = JSON.parse(store.open("oauth:linear")!);
  store.seal("oauth:linear", JSON.stringify({ ...signed, expires: Date.now() - 1 }));
  assert.equal(await bearer(deps, "linear"), "access-2");

  // The service moves on without telling us: the next call is refused once.
  store.seal("service:linear", "stale");
  assert.equal((await tools(deps, SERVICE)).length, 1);
  assert.equal(store.open("service:linear"), "access-3");
});

test("a service that will not be introduced to needs a client the operator registered", async () => {
  const { deps } = world({ register: false });
  await assert.rejects(begin(deps, SERVICE, BACK), /Linear needs a client ID.*http:\/\/127\.0\.0\.1:4010\/services\/callback/);
  const { to } = await begin(deps, SERVICE, BACK, { id: "typed-in" });
  assert.equal(new URL(to).searchParams.get("client_id"), "typed-in");
});

test("a service cannot point this app at a private address", async () => {
  const { deps, asked } = world({ meta: { token_endpoint: "https://inside.linear.example/token" } });
  const { pending } = await begin(deps, SERVICE, BACK);
  await assert.rejects(finish(deps, pending, "good-code"), /pointed somewhere it may not/);
  assert.equal(asked.some((each) => each.url.includes("inside.")), false);

  const plain = world({ meta: { authorization_endpoint: "http://auth.linear.example/authorize" } });
  await assert.rejects(begin(plain.deps, SERVICE, BACK), /does not offer a sign-in|pointed somewhere/);
});
