import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, APP_KEYS } from "../src/store.ts";
import { answerEffect } from "../src/effects.ts";
import { createApp, sessionCookie } from "../src/server.ts";
import { GOOGLE } from "../src/google/index.ts";
import { decode, raw, reply } from "../src/google/gmail.ts";
import { fakeKernel } from "./support.ts";

const b64 = (text: string) => Buffer.from(text).toString("base64url");
const unraw = (text: string) => Buffer.from(text, "base64url").toString("utf8");

// A piece granted Google's three, and a Google that answers from `answers`,
// keyed by the start of the path.
function world(answers: Record<string, unknown> = {}) {
  const store = new Store(":memory:");
  store.addPiece({ id: "pa", name: "Week", description: "", wants: [] });
  const keys = ["google_calendar", "gmail_api", "google_drive"];
  for (const key of keys) {
    store.addService({ key, name: key, url: GOOGLE });
    store.seal(`service:${key}`, "tok");
  }
  store.grant("pa", "mcp", { services: keys });
  const asked: Array<{ method: string; url: URL; body: any; headers: any }> = [];
  const deps = {
    store, kernel: fakeKernel(),
    http: async (url: string, init: any) => {
      const at = new URL(url);
      asked.push({ method: init.method, url: at, body: init.body, headers: init.headers });
      const found = Object.entries(answers).find(([path]) => at.pathname.startsWith(path));
      if (!found) return Response.json({ error: { message: "Not Found" } }, { status: 404 });
      return typeof found[1] === "string" ? new Response(found[1]) : Response.json(found[1]);
    },
  };
  const call = (server: string, tool: string, args?: unknown) => answerEffect(deps, "pa", { kind: "mcp", server, tool, args });
  return { store, asked, deps, call };
}

test("Calendar lists events as OpenStudio's does, and asks Google the same way", async () => {
  const { asked, call } = world({ "/calendar/v3/calendars/primary/events": { items: [
    { id: "e1", summary: "Standup", start: { dateTime: "2026-10-12T09:00:00-07:00" }, etag: "x", attendees: [{ email: "a@example.com", responseStatus: "accepted", id: "hidden" }] },
  ], nextPageToken: "more" } });
  const { result } = await call("google_calendar", "list_events", { time_min: "2026-10-12T00:00:00Z", max_results: 500 });
  assert.deepEqual(result, { events: [{ id: "e1", summary: "Standup", start: { dateTime: "2026-10-12T09:00:00-07:00" }, attendees: [{ email: "a@example.com", responseStatus: "accepted" }] }], next_page_token: "more" });
  const sent = asked[0];
  assert.equal(sent.headers.authorization, "Bearer tok");
  assert.equal(sent.url.searchParams.get("singleEvents"), "true");
  assert.equal(sent.url.searchParams.get("maxResults"), "50", "never more than fifty");
  assert.equal(sent.url.searchParams.get("timeMin"), "2026-10-12T00:00:00Z");
  assert.equal(sent.url.searchParams.has("timeMax"), false);
});

test("an event is made with what was given, and a Meet link when asked", async () => {
  const { asked, call } = world({ "/calendar/v3/calendars/work%40example.com/events": { id: "new", summary: "Review" } });
  const made = await call("google_calendar", "create_event", { calendar_id: "work@example.com", summary: "Review", start: "2026-10-12T10:00:00Z", end: "2026-10-12T11:00:00Z", attendees: ["b@example.com"], add_meet: true });
  assert.deepEqual(made, { result: { id: "new", summary: "Review" } });
  const body = JSON.parse(asked[0].body);
  assert.deepEqual(body.attendees, [{ email: "b@example.com" }]);
  assert.deepEqual(body.start, { dateTime: "2026-10-12T10:00:00Z" });
  assert.equal(body.conferenceData.createRequest.conferenceSolutionKey.type, "hangoutsMeet");
  assert.equal(asked[0].url.searchParams.get("sendUpdates"), "none");
  assert.equal(asked[0].url.searchParams.get("conferenceDataVersion"), "1");
});

test("arguments a tool does not take are refused, and so is a tool that does not exist", async () => {
  const { asked, call } = world();
  assert.equal((await call("google_calendar", "list_events", { calendar: "primary" })).error, "Invalid arguments for list_events");
  assert.equal((await call("google_calendar", "create_event", { summary: "No times" })).error, "Invalid arguments for create_event");
  assert.equal((await call("google_calendar", "respond_to_event", { event_id: "e", response: "maybe" })).error, "Invalid arguments for respond_to_event");
  assert.equal((await call("google_calendar", "drop_calendar", {})).error, "Unknown tool: drop_calendar");
  assert.equal(asked.length, 0);
});

test("a message is built so that nothing typed can add a header", () => {
  const sent = unraw(raw({ to: ["a@example.com", "b@example.com"], cc: ["c@example.com"], bcc: ["d@example.com"], subject: "Réunion", body: "Bonjour\nà tous" }));
  assert.match(sent, /^Bcc: d@example\.com\r\nTo: a@example\.com, b@example\.com\r\nCc: c@example\.com\r\nSubject: =\?UTF-8\?B\?/);
  assert.match(sent, /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n/);
  assert.equal(Buffer.from(sent.split("\r\n\r\n")[1], "base64").toString("utf8"), "Bonjour\nà tous");
  assert.throws(() => raw({ to: ["a@example.com\r\nBcc: thief@example.com"], subject: "x", body: "y" }), /cannot contain newlines/);
  assert.throws(() => raw({ to: ["a@example.com"], subject: "x\nBcc: thief@example.com", body: "y" }), /cannot contain newlines/);
  assert.match(unraw(raw({ to: ["a@example.com"], subject: "x", body: "plain", html_body: "<b>rich</b>" })), /multipart\/alternative; boundary=pieces_[0-9a-f]{32}/);
});

test("a reply lands in the thread, to whoever wrote, and to everyone but you when asked", () => {
  const original = { threadId: "t1", payload: { headers: [
    { name: "From", value: "Ana <ana@example.com>" }, { name: "To", value: "me@example.com, Bo <bo@example.com>" }, { name: "Cc", value: "cy@example.com" },
    { name: "Subject", value: "Plan" }, { name: "Message-ID", value: "<m2@example.com>" }, { name: "References", value: "<m1@example.com>" },
  ] } };
  const one = reply(original, "ok", false);
  assert.equal(one.threadId, "t1");
  const head = unraw(one.raw);
  assert.match(head, /^To: ana@example\.com\r\nSubject: Re: Plan\r\nIn-Reply-To: <m2@example\.com>\r\nReferences: <m1@example\.com> <m2@example\.com>\r\n/);
  const all = unraw(reply(original, "ok", true, "ME@example.com").raw);
  assert.match(all, /^To: ana@example\.com, bo@example\.com\r\nCc: cy@example\.com\r\n/);
  assert.throws(() => reply({ threadId: "t", payload: { headers: [{ name: "From", value: "a@example.com" }] } }, "x", false), /no Message-ID/);
});

test("a message is read as words, with its attachments named and not opened", () => {
  const read = decode({ id: "m", threadId: "t", snippet: "Hi", labelIds: ["INBOX"], payload: { headers: [{ name: "From", value: "a@example.com" }, { name: "Subject", value: "S" }], parts: [
    { mimeType: "text/html", body: { data: b64("<style>p{}</style><p>Hello <b>there</b></p><script>x()</script>") } },
    { mimeType: "application/pdf", filename: "bill.pdf", body: { attachmentId: "a1", size: 900 } },
  ] } });
  assert.equal(read.body, "Hello there");
  assert.deepEqual(read.attachments, [{ filename: "bill.pdf", mime_type: "application/pdf", size: 900 }]);
  assert.equal(read.subject, "S");
  assert.equal(read.truncated, false);
});

test("Drive searches by words safely, and reads a document as text", async () => {
  const { asked, call } = world({
    "/drive/v3/files/doc1/export": "# Notes\nhello",
    "/drive/v3/files/doc1": { id: "doc1", name: "Notes", mimeType: "application/vnd.google-apps.document", kind: "x" },
    "/drive/v3/files/pic": { id: "pic", mimeType: "image/png" },
    "/drive/v3/files": { files: [{ id: "doc1", name: "Notes", kind: "x" }] },
  });
  assert.deepEqual(await call("google_drive", "search_files", { full_text: "it's \\ here" }), { result: { files: [{ id: "doc1", name: "Notes" }] } });
  assert.equal(asked[0].url.searchParams.get("q"), "fullText contains 'it\\'s \\\\ here'");
  assert.equal(asked[0].url.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.match((await call("google_drive", "search_files", {})).error, /query or full_text/);

  assert.deepEqual(await call("google_drive", "read_file_content", { file_id: "doc1" }), { result: { content: "# Notes\nhello", truncated: false } });
  assert.equal(asked.at(-1)!.url.searchParams.get("mimeType"), "text/markdown");
  assert.equal((await call("google_drive", "read_file_content", { file_id: "pic" })).error, "binary file — no text content");
});

test("what Google says when it refuses is its own short message", async () => {
  const { call } = world();
  assert.deepEqual(await call("google_calendar", "get_event", { event_id: "gone" }), { error: "Not Found" });
});

// Google signs people in to an app the operator made. Its secret is sealed,
// and the sign-in asks for no more than each service needs.
test("Google is connected through the operator's own app", async () => {
  const http = async (url: string, init: any = {}) => {
    if (url === "https://oauth2.googleapis.com/token") {
      const form = new URLSearchParams(init.body);
      if (form.get("client_secret") !== "g-secret" || form.has("resource")) return new Response("{}", { status: 400 });
      return Response.json({ access_token: "ya29", refresh_token: "1//r", expires_in: 3599 });
    }
    return new Response("{}", { status: 200 });
  };
  const store = new Store(":memory:");
  for (const key of APP_KEYS) store.seal(key.name, "set");
  const handle = createApp({ store, secret: "s", kernel: fakeKernel(), origin: "http://127.0.0.1:4010", reach: { http, resolve: async () => ["142.250.0.1"] } });
  const headers = { cookie: `session=${sessionCookie("s")}` };
  const get = (path: string) => handle(new Request(`http://local${path}`, { headers }));
  const post = (path: string, fields: Record<string, string>) => handle(new Request(`http://local${path}`, { method: "POST", headers, body: new URLSearchParams(fields) }));

  // Gmail, Calendar and Drive are in the list with everything else.
  const before = await (await get("/services")).text();
  assert.match(before, /<li data-ready="gmail_api"[\s\S]*?Gmail[\s\S]*?Connect[\s\S]*?<li data-ready="linear"/);

  // The first Connect asks for the app, and says what address to give Google.
  const asks = await post("/services/connect", { catalog: "google_calendar" });
  assert.equal(asks.status, 200);
  const form = await asks.text();
  assert.match(form, /<form data-google[\s\S]*?name="catalog" value="google_calendar"[\s\S]*?http:\/\/127\.0\.0\.1:4010\/services\/callback/);
  assert.match(form, /<details data-help[\s\S]*?Web application[\s\S]*?developers\.google\.com\/workspace\/guides\/create-credentials/, "how to get them is one click away");
  assert.equal((await post("/services/google", { client_id: "only-this", client_secret: "", catalog: "google_calendar" })).status, 422);

  // Saving it carries straight on to Google.
  const saved = await post("/services/google", { client_id: "g-id.apps.googleusercontent.com", client_secret: "g-secret", catalog: "google_calendar" });
  assert.match(saved.headers.get("location")!, /^https:\/\/accounts\.google\.com\//);
  assert.doesNotMatch(await (await get("/services")).text(), /g-secret/);

  const sent = new URL((await post("/services/connect", { catalog: "google_calendar" })).headers.get("location")!);
  assert.equal(sent.origin + sent.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(sent.searchParams.get("client_id"), "g-id.apps.googleusercontent.com");
  assert.equal(sent.searchParams.get("access_type"), "offline");
  assert.equal(sent.searchParams.get("redirect_uri"), "http://127.0.0.1:4010/services/callback");
  assert.match(sent.searchParams.get("scope")!, /calendar\.events /);
  assert.doesNotMatch(sent.searchParams.get("scope")!, /gmail|drive/);
  assert.equal(sent.searchParams.has("resource"), false);

  assert.equal((await get(`/services/callback?code=4/abc&state=${sent.searchParams.get("state")}`)).headers.get("location"), "/services");
  assert.equal(store.service("google_calendar")?.url, GOOGLE);
  assert.equal(store.open("service:google_calendar"), "ya29");
  const after = await (await get("/services")).text();
  assert.match(after, /<li data-service="google_calendar"[\s\S]*?google\.com/);
  assert.doesNotMatch(after, /ya29|1\/\/r|data-ready="google_calendar"/);
  assert.match(after, /<a href="\/services\/google"[^>]*>Google sign-in app<\/a>/, "the app can be replaced later");
});
