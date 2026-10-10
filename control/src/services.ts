// Services a piece can use beyond the ones this app has keys for: anything
// that speaks MCP, added by the operator with an address and a token. A
// piece names a service by its key (`google_calendar`), so a piece written
// elsewhere works here once a service with that key exists and is granted.
import { notGranted, type Deps, type Outcome } from "./effects.ts";
import { bearer, signedIn } from "./oauth.ts";
import { builtIn, builtInTools, callBuiltIn } from "./google/index.ts";

const VERSION = "2025-03-26";
const OWN = /^(localhost|127\.0\.0\.1|\[::1\])$/;
export const KEY = /^[a-z][a-z0-9_]{1,39}$/;

// Where a service may live: anywhere over https, or this machine over http.
// The operator typed it, so a private address is theirs to choose.
export function serviceAddress(given: string): URL | null {
  let url: URL;
  try { url = new URL(given.trim()); } catch { return null; }
  if (url.protocol === "https:" || (url.protocol === "http:" && OWN.test(url.hostname))) return url;
  return null;
}

export async function answerService(deps: Deps, piece: string, { server, tool, args }: Outcome): Promise<Outcome> {
  const key = String(server ?? "");
  const granted: string[] = deps.store.granted(piece, "mcp")?.services ?? [];
  if (!granted.includes(key)) return notGranted(key || "that service");
  const service = deps.store.service(key);
  if (!service) return { error: `there is no service called ${key} here` };
  if (tool === "__describe") return { result: { server: key, tools: await tools(deps, service) } };
  if (builtIn(service)) return { result: await callBuiltIn(deps.http ?? fetch, key, (renew) => bearer(deps, key, renew), String(tool), args) };
  const reply = await ask(deps, service, "tools/call", { name: String(tool), arguments: args ?? {} });
  const text = (Array.isArray(reply?.content) ? reply.content : []).filter((part: any) => part?.type === "text").map((part: any) => String(part.text)).join("\n");
  if (reply?.isError) return { error: (text || "the tool failed").slice(0, 500) };
  return { result: text };
}

type Listed = { name: string; description: string; inputSchema: unknown };

// What a service can do. Also how a remote service is checked when added.
export async function tools(deps: Pick<Deps, "store" | "http" | "resolve">, service: Service): Promise<Listed[]> {
  if (builtIn(service)) return builtInTools(service.key).map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
  const reply = await ask(deps, service, "tools/list", {});
  return (Array.isArray(reply?.tools) ? reply.tools : []).slice(0, 200).map((tool: any) => ({
    name: String(tool.name), description: String(tool.description ?? "").slice(0, 600), inputSchema: tool.inputSchema ?? null,
  }));
}

// One request to the service, after the handshake MCP asks for. What the
// service said when it refused is not passed on: it may repeat the token.
async function ask(deps: Pick<Deps, "store" | "http" | "resolve">, service: Service, method: string, params: unknown, renewed = false): Promise<any> {
  const { http = fetch } = deps;
  const token = await bearer(deps, service.key, renewed);
  let session: string | null = null;
  const send = async (body: Record<string, unknown>): Promise<any> => {
    const reply = await http(service.url, {
      method: "POST",
      headers: {
        "content-type": "application/json", accept: "application/json, text/event-stream",
        ...(token ? (service.header ? { [service.header]: token } : { authorization: `Bearer ${token}` }) : {}), ...(session ? { "mcp-session-id": session } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
    if (reply.status === 401 && !renewed && signedIn(deps, service.key)) throw new Renew();
    if (!reply.ok) throw new Error(reply.status === 401 || reply.status === 403 ? `${service.key} did not accept its token` : `${service.key} failed (${reply.status})`);
    session = reply.headers.get("mcp-session-id") ?? session;
    if (body.id === undefined) return null;
    const answer = answered(await reply.text(), reply.headers.get("content-type") ?? "");
    if (!answer) throw new Error(`${service.key} did not answer as an MCP server does`);
    if (answer.error) throw new Error(`${service.key} refused: ${String(answer.error.message ?? "no reason given").slice(0, 200)}`);
    return answer.result;
  };
  try {
    await send({ id: 1, method: "initialize", params: { protocolVersion: VERSION, capabilities: {}, clientInfo: { name: "openstudio-personal", version: "0.1.0" } } });
  } catch (error) {
    // A token it has stopped accepting is renewed once, then tried again.
    if (error instanceof Renew) return ask(deps, service, method, params, true);
    throw error;
  }
  await send({ method: "notifications/initialized" }).catch(() => null);
  return send({ id: 2, method, params });
}

class Renew extends Error {}
interface Service { key: string; url: string; header?: string | null }

// The answer, whether it came as JSON or as a stream of events.
function answered(text: string, type: string): any {
  const candidates = type.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim())
    : [text];
  for (const each of candidates.reverse()) {
    try {
      const message = JSON.parse(each);
      if (message && typeof message === "object" && message.id !== undefined) return message;
    } catch { /* not this line */ }
  }
  return null;
}
