// For the operator's own AI client, over MCP: read pieces, change them, make
// new ones, test and call them. This is how a piece is written in this
// version.
//
// It cannot grant a piece anything, show a key, or set anything running on a
// timer. Those stay with the person, in the browser: a client that writes a
// piece's code must not be able to hand that code its own permissions.
import { tools } from "./services.ts";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Store, Piece } from "./store.ts";
import type { Reply } from "./kernel.ts";

interface Kernel {
  request(method: string, piece: string, route: string, body?: unknown, headers?: Record<string, string>): Promise<Reply>;
}
interface Deps { store: Store; kernel: Kernel }

const VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const BINARY = /\.(png|jpe?g|webp|gif|avif|pdf)$/i;
const piece = { type: "string", description: "The piece's name or id" };
const files = { type: "object", description: "File name to content, as text", additionalProperties: { type: "string" } };

export const TOOLS = [
  { name: "read_guide", description: "How to write a piece: its files, methods, effects, tests and page. Read this before writing any piece code.", inputSchema: { type: "object", properties: {} } },
  { name: "list_pieces", description: "The pieces here.", inputSchema: { type: "object", properties: {} } },
  { name: "list_services", description: "The MCP servers a piece can be granted here, each with its key and its tools. A piece calls one with the mcp effect, naming it by key.", inputSchema: { type: "object", properties: {} } },
  { name: "read_piece", description: "A piece's files, its methods and its tasks, and any errors its page has had since it was last deployed.", inputSchema: { type: "object", properties: { piece }, required: ["piece"] } },
  { name: "write_piece_files", description: "Change a piece: the files sent are written over what is there, and the result is deployed and its tests run. Send only what changes.",
    inputSchema: { type: "object", properties: { piece, files, delete: { type: "array", items: { type: "string" }, description: "File names to remove" } }, required: ["piece", "files"] } },
  { name: "create_piece", description: "Make a new piece from a complete set of files. It starts able to reach nothing; its owner decides that in the browser.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, description: { type: "string" }, files }, required: ["name", "files"] } },
  { name: "run_tests", description: "Run a piece's tests.js.", inputSchema: { type: "object", properties: { piece }, required: ["piece"] } },
  { name: "call_piece", description: "Call one of a piece's methods, as its owner.", inputSchema: { type: "object", properties: { piece, method: { type: "string" }, args: { type: "array", description: "Arguments after the state" } }, required: ["piece", "method"] } },
  { name: "read_state", description: "A piece's saved state.", inputSchema: { type: "object", properties: { piece }, required: ["piece"] } },
  { name: "read_logs", description: "A piece's recent log lines: deploys, test runs, what its effects were refused, and errors from its page (lines marked `page`) once someone has opened it.", inputSchema: { type: "object", properties: { piece }, required: ["piece"] } },
];

// One JSON-RPC message in, one out; null for a notification.
export async function answerMcp(deps: Deps, message: any): Promise<object | null> {
  const { id, method, params } = message ?? {};
  if (id === undefined) return null;
  const result = (value: unknown) => ({ jsonrpc: "2.0", id, result: value });
  if (method === "initialize") {
    return result({
      protocolVersion: VERSIONS.includes(params?.protocolVersion) ? params.protocolVersion : VERSIONS[0],
      capabilities: { tools: {} },
      serverInfo: { name: "openstudio-personal", version: "0.1.0" },
      instructions: "This is OpenStudio Personal. Pieces are small apps this person runs. Call read_guide before writing piece code. You cannot grant a piece access to anything; say what it needs and the person will decide.",
    });
  }
  if (method === "ping") return result({});
  if (method === "tools/list") return result({ tools: TOOLS });
  if (method === "tools/call") {
    try {
      const done = await run(deps, String(params?.name), params?.arguments ?? {});
      return result({ content: [{ type: "text", text: typeof done === "string" ? done : JSON.stringify(done, null, 2) }] });
    } catch (error) {
      return result({ content: [{ type: "text", text: JSON.stringify({ error: (error as Error).message }) }], isError: true });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `no such method: ${method}` } };
}

async function run({ store, kernel }: Deps, tool: string, args: Record<string, any>): Promise<unknown> {
  const found = (): Piece => {
    const wanted = String(args.piece ?? "").toLowerCase();
    const match = store.pieces().find((each) => each.id === args.piece || each.name.toLowerCase() === wanted);
    if (!match) throw new Error(`There is no piece called ${args.piece}. list_pieces shows what there is.`);
    return match;
  };
  const ask = async (method: string, id: string, route: string, body?: unknown, headers?: Record<string, string>) => {
    const reply = await kernel.request(method, id, route, body, headers);
    if (reply.status !== 200) throw new Error(explain(reply));
    return reply.body;
  };

  switch (tool) {
    case "read_guide":
      return readFileSync(join(import.meta.dirname, "../../docs/writing-a-piece.md"), "utf8");
    case "list_services":
      return Promise.all(store.services().map(async ({ key, name }) => ({
        key, name, tools: await tools({ store }, store.service(key)!).catch((error) => `could not be read: ${(error as Error).message}`),
      })));
    case "list_pieces":
      return store.pieces().map(({ id, name, description }) => ({ id, name, description }));
    case "read_piece": {
      const { id, name } = found();
      const code = await ask("GET", id, "files");
      const shown = Object.fromEntries(Object.entries(code?.files ?? {}).map(([file, content]) => [file, BINARY.test(file) ? "(a picture; not shown)" : content]));
      const [described, tasks, logs] = await Promise.all([kernel.request("GET", id, "describe"), kernel.request("GET", id, "tasks"), kernel.request("GET", id, "logs")]);
      return { id, name, version: code?.version, files: shown, methods: described.body?.methods ?? [], tasks: tasks.body?.tasks ?? [], page_errors: pageErrors(logs.body?.lines) };
    }
    case "write_piece_files": {
      const { id } = found();
      const reply = await ask("PUT", id, "files", { files: args.files, mode: "merge", ...(Array.isArray(args.delete) && args.delete.length ? { delete: args.delete } : {}) });
      return args.files?.["client.js"] ? { ...reply, page: PAGE_NOTE } : reply;
    }
    case "create_piece": {
      const name = String(args.name ?? "").trim().slice(0, 100);
      if (!name) throw new Error("A piece needs a name.");
      const id = `p${randomBytes(8).toString("hex")}`;
      const reply = await kernel.request("PUT", id, "files", { files: args.files });
      if (reply.status !== 200) {
        await kernel.request("DELETE", id, "");
        throw new Error(explain(reply));
      }
      store.addPiece({ id, name, description: String(args.description ?? "").slice(0, 2_000), wants: [] });
      return { id, name, ...reply.body, note: "It has been granted nothing. Tell the person what it needs to reach; they grant it on the piece's page.", ...(args.files?.["client.js"] ? { page: PAGE_NOTE } : {}) };
    }
    case "run_tests":
      return ask("POST", found().id, "tests");
    case "call_piece": {
      const method = String(args.method ?? "");
      if (!/^[a-zA-Z]\w*$/.test(method)) throw new Error("Name the method to call.");
      return ask("POST", found().id, `rpc/${method}`, { args: Array.isArray(args.args) ? args.args : [] }, { "x-kernel-scope": "internal" });
    }
    case "read_state":
      return (await ask("GET", found().id, "state"))?.state ?? null;
    case "read_logs":
      return (await ask("GET", found().id, "logs"))?.lines ?? [];
    default:
      throw new Error(`There is no tool called ${tool}.`);
  }
}

// Nothing checks a page until a browser runs it, so a client is told where
// to look once one has.
const PAGE_NOTE = "client.js has not been run: the tests do not cover it, and only a browser does. Ask the person to open the piece, then call read_logs: an error in the page is a line marked `page`.";

// What has gone wrong in the page since the piece was last deployed.
function pageErrors(lines: unknown): string[] {
  const all = Array.isArray(lines) ? lines.map(String) : [];
  return all.slice(all.findLastIndex((line) => / info deployed /.test(line)) + 1).filter((line) => / page /.test(line));
}

// Why the kernel said no, in words a client can act on.
function explain({ status, body }: Reply): string {
  if (body?.loadError) {
    const back = body.reverted ? ` The last version that loaded (v${body.reverted.restoredFrom}) has been put back, so your files are no longer the current ones: fix this and send your whole change again.` : "";
    return `It would not load: ${body.loadError}.${back}`;
  }
  return body?.error ?? `The kernel answered ${status}.`;
}
