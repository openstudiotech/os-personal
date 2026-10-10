import { randomBytes } from "node:crypto";
import { clamp, compact, part, pick, Refused, STRING, STRINGS, tool, type Ask, type Provider } from "./api.ts";

const MESSAGE = { to: { ...STRINGS, minItems: 1 }, cc: STRINGS, bcc: STRINGS, subject: STRING, body: STRING, html_body: STRING };
const LABELS = { add_label_ids: STRINGS, remove_label_ids: STRINGS };
const SENT = ["id", "threadId", "labelIds"];
const MAX_BODY = 100_000;

const message = (id: string) => `messages/${part(id)}`;
const cut = (value: unknown, length = 1000) => String(value ?? "").slice(0, length);

function headers(mail: any): Record<string, string> {
  return Object.fromEntries((mail?.payload?.headers ?? []).map((each: any) => [String(each.name).toLowerCase(), String(each.value ?? "")]));
}

function about(mail: any): Record<string, any> {
  const fields = headers(mail);
  return { id: mail.id, thread_id: mail.threadId, snippet: cut(mail.snippet), from: cut(fields.from), to: cut(fields.to), subject: cut(fields.subject), date: cut(fields.date) };
}

// A message as words: its plain text, or its HTML with the tags taken off.
export function decode(mail: any): Record<string, any> {
  const fields = headers(mail);
  const plain: string[] = [], html: string[] = [], attachments: any[] = [];
  const pending = mail.payload ? [mail.payload] : [];
  while (pending.length) {
    const each = pending.shift();
    if (each.filename || each.body?.attachmentId) {
      attachments.push({ filename: cut(each.filename, 200), mime_type: each.mimeType, size: each.body?.size });
      continue;
    }
    if (each.body?.data && ["text/plain", "text/html"].includes(each.mimeType)) {
      const type = (each.headers ?? []).find((header: any) => String(header.name).toLowerCase() === "content-type")?.value ?? "";
      const charset = String(type).match(/charset=["']?([^\s;"']+)/i)?.[1] ?? "utf-8";
      let decoder: TextDecoder;
      try { decoder = new TextDecoder(charset); } catch { decoder = new TextDecoder("utf-8"); }
      (each.mimeType === "text/plain" ? plain : html).push(decoder.decode(Buffer.from(each.body.data, "base64url")));
    }
    pending.push(...(each.parts ?? []));
  }
  const body = plain.length ? plain.join("\n")
    : html.join("\n").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/[ \t]+/g, " ").trim();
  const text = Buffer.from(body).subarray(0, MAX_BODY).toString("utf8").replace(/�+$/, "");
  return {
    ...about(mail), to: cut(fields.to), cc: cut(fields.cc), body: text, labels: (mail.labelIds ?? []).slice(0, 100),
    attachments: attachments.slice(0, 25), truncated: text.length < body.length || attachments.length > 25,
  };
}

const word = (value: string) => (/^[\x20-\x7e]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`);
const lines = (value: string) => Buffer.from(value).toString("base64").replace(/(.{76})/g, "$1\r\n");
const section = (type: string, value: string) => `Content-Type: ${type}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${lines(value)}\r\n`;

// A message ready for Gmail. Nothing that goes in a header may hold a line
// break: that is how one header becomes two.
export function raw(mail: { to: string[]; subject: string; body: string; cc?: string[]; bcc?: string[]; html_body?: string; in_reply_to?: string; references?: string }): string {
  const { to, cc = [], bcc = [], subject, body, html_body, in_reply_to, references } = mail;
  for (const value of [...to, ...cc, ...bcc, subject, in_reply_to, references]) if (value && /[\r\n]/.test(value)) throw new Refused("Mail headers cannot contain newlines");
  const head = [
    bcc.length ? `Bcc: ${bcc.join(", ")}` : null, `To: ${to.join(", ")}`, cc.length ? `Cc: ${cc.join(", ")}` : null, `Subject: ${word(subject)}`,
    in_reply_to ? `In-Reply-To: ${in_reply_to}` : null, references ? `References: ${references}` : null, "MIME-Version: 1.0",
  ].filter(Boolean).join("\r\n");
  if (!html_body) return Buffer.from(`${head}\r\n${section("text/plain", body)}`).toString("base64url");
  const boundary = `pieces_${randomBytes(16).toString("hex")}`;
  return Buffer.from(`${head}\r\nContent-Type: multipart/alternative; boundary=${boundary}\r\n\r\n--${boundary}\r\n${section("text/plain", body)}--${boundary}\r\n${section("text/html", html_body)}--${boundary}--\r\n`).toString("base64url");
}

const addresses = (value: string | undefined): string[] => String(value ?? "").match(/[^\s<>,;"']+@[^\s<>,;"']+/g) ?? [];
const without = (list: string[], gone: string[]) => list.filter((each) => !gone.some((other) => other.toLowerCase() === each.toLowerCase()));
const once = (list: string[]) => list.filter((each, i) => list.findIndex((other) => other.toLowerCase() === each.toLowerCase()) === i);

// A reply that lands in the same thread, to whoever wrote, or to everyone.
export function reply(original: any, body: string, all: boolean, me?: string): { threadId: string; raw: string } {
  const fields = headers(original);
  const id = fields["message-id"];
  if (!id) throw new Refused("Original message has no Message-ID; cannot thread reply");
  let to = addresses(fields["reply-to"] || fields.from);
  let cc: string[] = [];
  if (all) {
    to = without([...to, ...addresses(fields.to)], me ? [me] : []);
    cc = without(addresses(fields.cc), me ? [me] : []);
  }
  to = once(to);
  cc = without(once(cc), to);
  if (to.length === 0) throw new Refused("Reply has no recipients");
  const subject = /^Re:/i.test(fields.subject ?? "") ? fields.subject : `Re: ${fields.subject ?? ""}`;
  const references = once(`${fields.references ?? ""} ${id}`.match(/<[^>]+>/g) ?? []).join(" ");
  return { threadId: original.threadId, raw: raw({ to, cc, subject, body, in_reply_to: id, references }) };
}

export const gmail: Provider = {
  tools: [
    tool("search_messages", "Search Gmail query syntax; metadata only, up to 25 messages.", { query: STRING, max_results: { type: "integer", default: 10 }, page_token: STRING }, ["query"], true),
    tool("get_message", "Read decoded message text and attachment metadata; large bodies are truncated.", { message_id: STRING }, ["message_id"], true),
    tool("get_thread", "Read decoded messages in a thread; large threads are truncated.", { thread_id: STRING }, ["thread_id"], true),
    tool("send_message", "Send mail immediately.", MESSAGE, ["to", "subject", "body"], false),
    tool("reply_to_thread", "Send a correctly threaded reply.", { message_id: STRING, body: STRING, reply_all: { type: "boolean", default: false } }, ["message_id", "body"], false),
    tool("create_draft", "Create a draft without sending.", { ...MESSAGE, thread_id: STRING }, ["to", "subject", "body"], false),
    tool("list_labels", "List mailbox labels.", {}, [], true),
    tool("modify_message", "Add or remove labels on one message.", { ...LABELS, message_id: STRING }, ["message_id"], false),
    tool("batch_modify_messages", "Add or remove labels on up to 100 messages.", { ...LABELS, message_ids: { ...STRINGS, minItems: 1, maxItems: 100 } }, ["message_ids"], false),
    tool("trash_message", "Move a message to trash; never permanently delete.", { message_id: STRING }, ["message_id"], false, true),
  ],

  async call(ask: Ask, name, args) {
    switch (name) {
      case "search_messages": {
        const limit = clamp(args.max_results ?? 10, 1, 25);
        const data = await ask("GET", "messages", { query: { q: args.query, maxResults: limit, pageToken: args.page_token } });
        const found = await Promise.all((data.messages ?? []).slice(0, limit).map((each: any) => ask("GET", message(each.id), { query: { format: "metadata" } })));
        return compact({ messages: found.map(about), next_page_token: data.nextPageToken });
      }
      case "get_message": return decode(await ask("GET", message(args.message_id), { query: { format: "full" } }));
      case "get_thread": {
        const data = await ask("GET", `threads/${part(args.thread_id)}`, { query: { format: "full" } });
        const messages: any[] = [];
        for (const each of data.messages ?? []) {
          const decoded = decode(each);
          if (JSON.stringify([...messages, decoded]).length > 230_000) break;
          messages.push(decoded);
        }
        return { id: data.id, messages, truncated: messages.length < (data.messages ?? []).length };
      }
      case "send_message": return pick(await ask("POST", "messages/send", { body: { raw: raw(args as any) } }), SENT);
      case "reply_to_thread": {
        const original = await ask("GET", message(args.message_id), { query: { format: "full" } });
        const me = args.reply_all ? String((await ask("GET", "profile")).emailAddress) : undefined;
        return pick(await ask("POST", "messages/send", { body: reply(original, args.body, args.reply_all, me) }), SENT);
      }
      case "create_draft": {
        const data = await ask("POST", "drafts", { body: { message: compact({ raw: raw(args as any), threadId: args.thread_id }) } });
        return { id: data.id, message: pick(data.message ?? {}, SENT) };
      }
      case "list_labels": return { labels: ((await ask("GET", "labels")).labels ?? []).slice(0, 1000).map((each: any) => pick(each, ["id", "name", "type"])) };
      case "modify_message":
        return pick(await ask("POST", `${message(args.message_id)}/modify`, { body: { addLabelIds: args.add_label_ids ?? [], removeLabelIds: args.remove_label_ids ?? [] } }), SENT);
      case "batch_modify_messages":
        return ask("POST", "messages/batchModify", { body: { ids: args.message_ids, addLabelIds: args.add_label_ids ?? [], removeLabelIds: args.remove_label_ids ?? [] } });
      default: return pick(await ask("POST", `${message(args.message_id)}/trash`, { body: {} }), SENT);
    }
  },
};
