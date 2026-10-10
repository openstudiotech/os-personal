// Talking to Google, and the shape a Google service's tools share. The tools
// keep the names and arguments OpenStudio's have, so a piece written there
// runs here unchanged.
export type Http = (url: string, init: any) => Promise<Response>;
type Query = Record<string, string | number | boolean | null | undefined>;
export interface Tool { name: string; description: string; inputSchema: Schema; annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: true } }
interface Schema { type: "object"; properties: Record<string, any>; required: string[]; additionalProperties: false }
export type Args = Record<string, any>;
export type Ask = (method: string, path: string, options?: { query?: Query; body?: unknown; type?: string; text?: boolean }) => Promise<any>;
export interface Provider { tools: Tool[]; call(ask: Ask, tool: string, args: Args): Promise<unknown> }

export const STRING = { type: "string" } as const;
export const STRINGS = { type: "array", items: STRING } as const;

export class Refused extends Error {}
// The token has stopped working: renew it and try once more.
export class Expired extends Error {}

export function tool(name: string, description: string, properties: Record<string, any>, required: string[], read: boolean, destructive = false): Tool {
  return {
    name, description,
    inputSchema: { type: "object", properties, required, additionalProperties: false },
    annotations: { readOnlyHint: read, destructiveHint: destructive, openWorldHint: true },
  };
}

// One request to a Google API under `base`. What Google said is passed on
// only as its own short message.
export function google(http: Http, token: string, base: string): Ask {
  return async (method, path, { query = {}, body, type, text = false } = {}) => {
    const url = new URL(`https://www.googleapis.com${path.startsWith("/") ? path : `${base}/${path}`}`);
    for (const [name, value] of Object.entries(query)) if (value !== null && value !== undefined && value !== "") url.searchParams.set(name, String(value));
    const raw = typeof body === "string";
    const reply = await http(url.href, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { "content-type": type ?? (raw ? "text/plain; charset=UTF-8" : "application/json") }) },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
      redirect: "error", signal: AbortSignal.timeout(60_000),
    });
    if (reply.status === 401) throw new Expired("Google authorization expired; reconnect your account");
    const said = await reply.text();
    if (!reply.ok) {
      let message = "";
      try { message = String(JSON.parse(said)?.error?.message ?? ""); } catch { /* not JSON */ }
      throw new Refused((message || `Google API request failed (${reply.status})`).slice(0, 500));
    }
    if (text) return said;
    try { return said ? JSON.parse(said) : {}; } catch { return said; }
  };
}

// The arguments are what the tool says it takes, and nothing else.
export function check(found: Tool, args: Args): Args {
  const { properties, required } = found.inputSchema;
  const bad = new Refused(`Invalid arguments for ${found.name}`);
  if (args === null || typeof args !== "object" || Array.isArray(args)) throw bad;
  const given: Args = {};
  for (const [name, value] of Object.entries(args)) {
    const wants = properties[name];
    if (!wants) throw bad;
    if (value === null || value === undefined) continue;
    const fits = wants.type === "array" ? Array.isArray(value) && value.every((each) => typeof each === "string")
      : wants.type === "integer" ? Number.isInteger(value) : typeof value === wants.type;
    if (!fits || (wants.enum && !wants.enum.includes(value))) throw bad;
    if (wants.type === "array" && ((wants.minItems && value.length < wants.minItems) || (wants.maxItems && value.length > wants.maxItems))) throw bad;
    given[name] = value;
  }
  for (const name of required) if (given[name] === undefined) throw bad;
  for (const [name, wants] of Object.entries(properties)) if (given[name] === undefined && wants.default !== undefined) given[name] = wants.default;
  return given;
}

export const pick = (from: any, fields: readonly string[]): Record<string, any> =>
  Object.fromEntries(fields.filter((field) => from?.[field] !== undefined).map((field) => [field, from[field]]));
export const compact = (from: Record<string, any>): Record<string, any> =>
  Object.fromEntries(Object.entries(from).filter(([, value]) => value !== null && value !== undefined));
export const part = (value: string): string => encodeURIComponent(value);
export const clamp = (value: number, low: number, high: number): number => Math.min(Math.max(value, low), high);
