import { randomBytes } from "node:crypto";
import { clamp, compact, part, pick, Refused, STRING, tool, type Args, type Ask, type Provider } from "./api.ts";

const FILE_FIELDS = ["id", "name", "mimeType", "description", "size", "modifiedTime", "webViewLink", "parents", "trashed", "owners"];
const EXPORTS: Record<string, string> = {
  "application/vnd.google-apps.document": "text/markdown",
  "application/vnd.google-apps.spreadsheet": "text/csv",
  "application/vnd.google-apps.presentation": "text/plain",
};
const TEXT_TYPES = ["application/json", "application/xml", "application/javascript", "application/x-yaml"];
const ID = { file_id: STRING };
const PARENT = { parent_folder_id: STRING };
const MAX_TEXT = 200 * 1024;

const file = (id: string) => `files/${part(id)}`;
const quoted = (value: string) => value.replace(/[\\']/g, (character) => `\\${character}`);
const isText = (mime: string) => mime.startsWith("text/") || TEXT_TYPES.includes(mime);
// Export and drives.get take no supportsAllDrives; only a listing takes
// includeItemsFromAllDrives.
const everywhere = (method: string, path: string) => ({
  ...(path.endsWith("/export") ? {} : { supportsAllDrives: true }), ...(method === "GET" && path === "files" ? { includeItemsFromAllDrives: true } : {}),
});

async function search(ask: Ask, args: Args) {
  if (Boolean(args.query) === Boolean(args.full_text)) throw new Refused("Provide query or full_text, not both");
  const limit = clamp(args.max_results ?? 25, 1, 50);
  const data = await ask("GET", "files", { query: {
    ...everywhere("GET", "files"), q: args.query ?? `fullText contains '${quoted(args.full_text)}'`, pageSize: limit,
    pageToken: args.page_token, orderBy: args.order_by, fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS.join(",")})`,
  } });
  return compact({ files: (data.files ?? []).slice(0, limit).map((each: any) => pick(each, FILE_FIELDS)), next_page_token: data.nextPageToken, incomplete_search: data.incompleteSearch });
}

const metadata = async (ask: Ask, id: string) => pick(await ask("GET", file(id), { query: { ...everywhere("GET", file(id)), fields: FILE_FIELDS.join(",") } }), FILE_FIELDS);
const change = async (ask: Ask, method: string, path: string, body: unknown, query = {}) => pick(await ask(method, path, { query: { ...everywhere(method, path), ...query }, body }), FILE_FIELDS);

export const drive: Provider = {
  tools: [
    tool("search_files", "Search using Drive q syntax or literal full text; returns up to 50 files.", { query: STRING, full_text: STRING, max_results: { type: "integer", default: 25 }, page_token: STRING, order_by: STRING }, [], true),
    tool("list_folder", "List a folder's non-trashed children, including shared drives.", { folder_id: { type: "string", default: "root" }, page_token: STRING }, [], true),
    tool("get_file_metadata", "Read file metadata.", ID, ["file_id"], true),
    tool("read_file_content", "Read or export text; truncates at 200 KB. Binary files are unsupported.", { ...ID, export_mime_type: STRING }, ["file_id"], true),
    tool("create_file", "Upload text, optionally converting to a Google document or spreadsheet.", { ...PARENT, name: STRING, content: STRING, mime_type: { type: "string", default: "text/plain" }, convert_to: { type: "string", enum: ["document", "spreadsheet"] } }, ["name", "content"], false),
    tool("update_file_content", "Replace a file's text content.", { ...ID, content: STRING }, ["file_id", "content"], false),
    tool("create_folder", "Create a folder.", { ...PARENT, name: STRING }, ["name"], false),
    tool("move_file", "Move a file from its existing parents to a new parent.", { ...ID, new_parent_id: STRING }, ["file_id", "new_parent_id"], false),
    tool("rename_file", "Rename a file.", { ...ID, new_name: STRING }, ["file_id", "new_name"], false),
    tool("copy_file", "Copy a file with an optional name and parent.", { ...ID, ...PARENT, name: STRING }, ["file_id"], false),
    tool("trash_file", "Move a file to trash; never permanently delete.", ID, ["file_id"], false, true),
    tool("share_file", "Grant access to one email address or anyone with the link.", { ...ID, email: STRING, anyone: { type: "boolean", default: false }, role: { type: "string", enum: ["reader", "commenter", "writer"] }, send_notification: { type: "boolean", default: false } }, ["file_id", "role"], false),
  ],

  async call(ask, name, args) {
    const parents = args.parent_folder_id ? [args.parent_folder_id] : null;
    switch (name) {
      case "search_files": return search(ask, args);
      case "list_folder": return search(ask, { query: `'${quoted(args.folder_id)}' in parents and trashed = false`, page_token: args.page_token });
      case "get_file_metadata": return metadata(ask, args.file_id);
      case "read_file_content": {
        const mime = String((await metadata(ask, args.file_id)).mimeType ?? "");
        const target = EXPORTS[mime] ? args.export_mime_type ?? EXPORTS[mime] : mime;
        if (!isText(target)) throw new Refused("binary file — no text content");
        const path = EXPORTS[mime] ? `${file(args.file_id)}/export` : file(args.file_id);
        const content: string = await ask("GET", path, { query: { ...everywhere("GET", path), ...(EXPORTS[mime] ? { mimeType: target } : { alt: "media" }) }, text: true });
        const kept = Buffer.from(content).subarray(0, MAX_TEXT).toString("utf8").replace(/�+$/, "");
        return { content: kept, truncated: kept.length < content.length };
      }
      case "create_file": {
        if (!/^[\w.+-]+\/[\w.+-]+$/.test(args.mime_type)) throw new Refused("Invalid MIME type");
        const boundary = `pieces_${randomBytes(16).toString("hex")}`;
        const about = compact({ name: args.name, mimeType: args.convert_to ? `application/vnd.google-apps.${args.convert_to}` : args.mime_type, parents });
        const sent = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(about)}\r\n--${boundary}\r\nContent-Type: ${args.mime_type}\r\n\r\n${args.content}\r\n--${boundary}--\r\n`;
        return pick(await ask("POST", "/upload/drive/v3/files", { query: { uploadType: "multipart", supportsAllDrives: true }, body: sent, type: `multipart/related; boundary=${boundary}` }), FILE_FIELDS);
      }
      case "update_file_content":
        return pick(await ask("PATCH", `/upload/drive/v3/${file(args.file_id)}`, { query: { uploadType: "media", supportsAllDrives: true }, body: String(args.content) }), FILE_FIELDS);
      case "create_folder": return change(ask, "POST", "files", compact({ name: args.name, mimeType: "application/vnd.google-apps.folder", parents }));
      case "move_file": {
        const from: string[] = (await metadata(ask, args.file_id)).parents ?? [];
        return change(ask, "PATCH", file(args.file_id), {}, { addParents: args.new_parent_id, removeParents: from.filter((each) => each !== args.new_parent_id).join(",") });
      }
      case "rename_file": return change(ask, "PATCH", file(args.file_id), { name: args.new_name });
      case "copy_file": return change(ask, "POST", `${file(args.file_id)}/copy`, compact({ name: args.name, parents }));
      case "trash_file": return change(ask, "PATCH", file(args.file_id), { trashed: true });
      default: {
        if (Boolean(args.email) === Boolean(args.anyone)) throw new Refused("Provide email or anyone, not both");
        const path = `${file(args.file_id)}/permissions`;
        return pick(await ask("POST", path, {
          query: { ...everywhere("POST", path), sendNotificationEmail: args.anyone ? null : args.send_notification },
          body: compact({ type: args.anyone ? "anyone" : "user", role: args.role, emailAddress: args.email }),
        }), ["id", "type", "role", "emailAddress"]);
      }
    }
  },
};
