import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, APP_KEYS } from "../src/store.ts";
import { createApp, sessionCookie } from "../src/server.ts";
import { fakeKernel } from "./support.ts";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const headers = { cookie: `session=${sessionCookie("let-me-in")}` };

// The picture model describes; the chat model is scripted. What each was
// sent is kept.
function world(replies: Array<Record<string, unknown>>) {
  const store = new Store(":memory:");
  for (const key of APP_KEYS) store.seal(key.name, "set");
  const looked: any[] = [];
  const sent: any[] = [];
  const http = async (url: string, init: any) => {
    if (url.endsWith("/models")) return Response.json({ data: [
      { id: "some/seer", architecture: { input_modalities: ["text", "image"] } },
      { id: "some/reader", architecture: { input_modalities: ["text"] } },
    ] });
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages.at(-1).content)) {
      looked.push(body);
      return Response.json({ choices: [{ message: { content: looked.length === 1 ? "A receipt for two coffees, $9.50." : "The date on it is 4 March." } }] });
    }
    sent.push(body);
    return Response.json({ choices: [{ message: { role: "assistant", ...(replies.shift() ?? { content: "Done." }) } }] });
  };
  const handle = createApp({ store, secret: "let-me-in", kernel: fakeKernel(), reach: { http } });
  const send = (path: string, say: string, files: Array<[string, Uint8Array]>) => {
    const form = new FormData();
    form.set("say", say);
    for (const [name, bytes] of files) form.append("picture", new File([bytes], name));
    return handle(new Request(`http://local${path}`, { method: "POST", headers, body: form }));
  };
  return { store, looked, sent, handle, send };
}

test("a picture sent in a chat is kept, shown, and described to Marcel in words", async () => {
  const { store, looked, sent, handle, send } = world([{ content: "Two coffees, $9.50." }]);
  const reply = await send("/new", "what is this?", [["receipt.png", PNG], ["notes.txt", new TextEncoder().encode("not a picture")]]);
  assert.equal(reply.status, 303);
  await handle.idle();

  const [chat] = store.chats();
  const [you] = store.conversation(chat.id);
  assert.equal(you.pictures.length, 1, "what is not a picture is not kept");

  assert.equal(looked[0].model, "z-ai/glm-5.3-flash");
  assert.deepEqual(looked[0].provider, { data_collection: "deny" });
  assert.equal(looked[0].messages.at(-1).content[1].image_url.url, `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`);

  const shown = sent[0].messages.filter((message: any) => message.role === "user");
  assert.deepEqual(shown, [{ role: "user", content: "what is this?" }, { role: "user", content: `[Picture ${you.pictures[0]}: A receipt for two coffees, $9.50.]` }]);

  const page = await (await handle(new Request(`http://local/chats/${chat.id}`, { headers }))).text();
  assert.match(page, new RegExp(`<img src="/chats/${chat.id}/pictures/${you.pictures[0]}"`));
  assert.doesNotMatch(page, /A receipt for two coffees/, "the description is for him, not for the page");

  const served = await handle(new Request(`http://local/chats/${chat.id}/pictures/${you.pictures[0]}`, { headers }));
  assert.equal(served.headers.get("content-type"), "image/png");
  assert.equal(served.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(new Uint8Array(await served.arrayBuffer()), PNG);
  assert.equal((await handle(new Request(`http://local/chats/${chat.id}/pictures/${you.pictures[0]}`))).status, 401, "not for strangers");
  assert.equal((await handle(new Request(`http://local/chats/cother/pictures/${you.pictures[0]}`, { headers }))).status, 404, "nor from another chat");

  await handle(new Request(`http://local/chats/${chat.id}/remove`, { method: "POST", headers }));
  assert.equal(store.picture(chat.id, you.pictures[0]), null, "a deleted chat takes its pictures with it");
});

test("a picture alone is enough to send, and Marcel can ask it a question", async () => {
  const { store, looked, sent, handle, send } = world([]);
  await send("/new", "", [["receipt.png", PNG]]);
  await handle.idle();
  const [chat] = store.chats();
  assert.equal(chat.title, "A picture");
  const [id] = store.conversation(chat.id)[0].pictures;

  const ask = (picture: string) => ({ content: null, tool_calls: [{ id: "c0", type: "function", function: { name: "look_at_picture", arguments: JSON.stringify({ picture, question: "What date is on it?" }) } }] });
  const { say } = await import("../src/marcel.ts");
  const deps = { store, kernel: fakeKernel(), http: (url: string, init: any) => scripted(url, init) };
  const replies = [ask(id), { content: "4 March." }, ask("pnothere"), { content: "No such picture." }];
  const scripted = async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages.at(-1).content)) { looked.push(body); return Response.json({ choices: [{ message: { content: "The date on it is 4 March." } }] }); }
    sent.push(body);
    return Response.json({ choices: [{ message: { role: "assistant", ...replies.shift() } }] });
  };

  await say(deps, chat.id, "what date?");
  assert.equal(looked.at(-1).messages.at(-1).content[0].text, "What date is on it?");
  assert.match(sent.at(-1).messages.at(-1).content, /The date on it is 4 March/);

  await say(deps, chat.id, "and the other?");
  assert.match(sent.at(-1).messages.at(-1).content, /no picture pnothere in this chat/);
});

test("a picture that cannot be read is tried twice, then left for Marcel to look at himself", async () => {
  const store = new Store(":memory:");
  store.seal("openrouter", "set");
  const sent: any[] = [];
  let looks = 0;
  const http = async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    if (Array.isArray(body.messages.at(-1).content)) { looks++; throw new TypeError("fetch failed"); }
    sent.push(body);
    return Response.json({ choices: [{ message: { role: "assistant", content: "I could not see it." } }] });
  };
  const { say } = await import("../src/marcel.ts");
  const chat = store.addChat("a chat");
  await say({ store, kernel: fakeKernel(), http }, chat, "what is this?", [{ type: "image/png", bytes: PNG }]);
  assert.equal(looks, 2);
  assert.match(sent[0].messages.at(-1).content, /has not been read yet\. Look at it with look_at_picture/);
});

test("the model that reads pictures is set beside the other, and must be able to read them", async () => {
  const { store, handle } = world([]);
  const save = (picture_model: string) => handle(new Request("http://local/settings/model", { method: "POST", headers, body: new URLSearchParams({ model: "", picture_model }) }));

  const page = await (await handle(new Request("http://local/settings/model", { headers }))).text();
  assert.match(page, /name="picture_model" value="z-ai\/glm-5\.3-flash"/);

  const wrong = await save("some/reader");
  assert.equal(wrong.status, 422);
  assert.match(await wrong.text(), /some\/reader cannot read pictures\./);
  assert.equal(store.setting("picture_model"), null);

  assert.equal((await save("some/seer")).status, 303);
  assert.equal(store.setting("picture_model"), "some/seer");
});
