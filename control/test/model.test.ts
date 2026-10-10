import { test } from "node:test";
import assert from "node:assert/strict";
import { Store, APP_KEYS } from "../src/store.ts";
import { createApp, sessionCookie } from "../src/server.ts";
import { checkModel, complete } from "../src/model.ts";
import { fakeKernel } from "./support.ts";

const listed = async () => Response.json({ data: [
  { id: "openai/gpt-6-luna", supported_parameters: ["tools", "max_tokens"] },
  { id: "some/talker", supported_parameters: ["max_tokens"] },
] });

test("every model call names the model in settings and refuses providers that collect what is sent", async () => {
  const store = new Store(":memory:");
  store.seal("openrouter", "sk-or-test");
  const sent: any[] = [];
  const http = async (url: string, init: any) => { sent.push({ url, ...JSON.parse(init.body), authorization: init.headers.authorization }); return Response.json({}); };

  await complete(store, http, { messages: [] });
  store.setSetting("model", "openai/gpt-6-luna");
  await complete(store, http, { messages: [] });

  assert.deepEqual(sent.map((each) => each.model), ["openrouter/auto", "openai/gpt-6-luna"]);
  for (const each of sent) {
    assert.equal(each.url, "https://openrouter.ai/api/v1/chat/completions");
    assert.deepEqual(each.provider, { data_collection: "deny" });
    assert.equal(each.authorization, "Bearer sk-or-test");
  }
});

test("a model is checked against the ones OpenRouter has", async () => {
  assert.equal(await checkModel("openai/gpt-6-luna", listed), null);
  assert.equal(await checkModel("openai/gpt-6-lunar", listed), "OpenRouter has no model called openai/gpt-6-lunar.");
  assert.equal(await checkModel("some/talker", listed), "some/talker cannot use tools, which Marcel needs.");
  assert.equal(await checkModel("x", async () => new Response("no", { status: 500 })), "OpenRouter could not check that model just now.");
  assert.equal(await checkModel("x", async () => { throw new Error("down"); }), "OpenRouter could not be reached to check that model.");
});

test("the model is changed in one place in settings, and a wrong one is not saved", async () => {
  const store = new Store(":memory:");
  for (const key of APP_KEYS) store.seal(key.name, "set");
  const handle = createApp({ store, secret: "let-me-in", kernel: fakeKernel(), reach: { http: listed } });
  const headers = { cookie: `session=${sessionCookie("let-me-in")}` };
  const save = (model: string) => handle(new Request("http://local/settings/model", { method: "POST", headers, body: new URLSearchParams({ model }) }));
  const shown = async () => (await handle(new Request("http://local/settings/model", { headers }))).text();

  assert.match(await shown(), /name="model" value="openrouter\/auto"/);

  const wrong = await save("openai/gpt-6-lunar");
  assert.equal(wrong.status, 422);
  const page = await wrong.text();
  assert.match(page, /OpenRouter has no model called openai\/gpt-6-lunar\./);
  assert.match(page, /name="model" value="openai\/gpt-6-lunar"/, "what was typed is still there to fix");
  assert.equal(store.setting("model"), null);

  assert.equal((await save(" openai/gpt-6-luna ")).status, 303);
  assert.match(await shown(), /name="model" value="openai\/gpt-6-luna"/);

  assert.equal((await save("")).status, 303, "empty goes back to the default, which is not looked up");
  assert.match(await shown(), /name="model" value="openrouter\/auto"/);
});
