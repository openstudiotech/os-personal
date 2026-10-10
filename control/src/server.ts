// The pages. One operator and no accounts, but not no lock: nothing is served
// without the secret, and nothing works until the OpenRouter key is in.
import { createHmac, timingSafeEqual } from "node:crypto";
import { Store, APP_KEYS } from "./store.ts";
import {
  accessView, alert, allChats, appFrame, browserGone, browserView, codeView, connect, enterForm, fresh, framed, home, modelForm, notes, notFound, page, piecePage, refused, settings,
  googleApp, servicesPage, setupForm, setupPage, sidebar, talk, type SecretAt,
} from "./views.ts";
import { loadPiece } from "./pieces.ts";
import { checkKey } from "./keys.ts";
import { checkModel, DEFAULT_MODEL } from "./model.ts";
import { PICTURE_MODEL, picturesIn, type Picture } from "./pictures.ts";
import { answerMcp } from "./mcp.ts";
import { loadNotes, remember, say } from "./marcel.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ORG, type Reply } from "./kernel.ts";
import { answerEffect, type Deps } from "./effects.ts";
import { liveView, releaseAll } from "./browser.ts";
import { KEY, serviceAddress, tools } from "./services.ts";
import { begin, finish, type Pending } from "./oauth.ts";
import { CATALOG } from "./catalog.ts";
import { AUTHORIZE, BUILT_IN, GOOGLE, TOKEN } from "./google/index.ts";
import { removeSchedule, runNow, setSchedule, specFrom, timings } from "./schedules.ts";

interface Kernel {
  request(method: string, piece: string, route: string, body?: unknown): Promise<Reply>;
  putFiles(piece: string, files: Record<string, string>): Promise<Reply>;
  scheduler(method: string, route: string, body?: unknown): Promise<Reply>;
  ticket(piece: string, options: { minutes: number }): string;
  pageUrl(piece: string, ticket: string): string;
  verifies(header: string | null, method: string, signedPath: string, body: Uint8Array): boolean;
}

// local: it listens on this machine only. Then there is no secret to type;
// what is refused instead is anything that did not come from this machine's
// own pages.
interface Options { store: Store; secret: string; kernel: Kernel; local?: boolean; origin?: string; secretAt?: SecretAt; reach?: Pick<Deps, "http" | "resolve" | "browser"> }

// The cookie proves the secret was given without being the secret.
export function sessionCookie(secret: string): string {
  return createHmac("sha256", secret).update("session").digest("hex");
}

// What an AI client presents. Made from the secret, so it is not the secret,
// and changing the secret changes it.
export function mcpToken(secret: string): string {
  return createHmac("sha256", secret).update("mcp").digest("hex");
}

type App = ((request: Request) => Promise<Response>) & { idle(): Promise<unknown> };

export function createApp({ store, secret, kernel, local = false, origin, secretAt, reach = {} }: Options): App {
  const session = sessionCookie(secret);

  // Chats Marcel is in the middle of answering. He works after the page has
  // been sent, so nobody waits on a blank screen; the chat's page asks again
  // until he is done.
  const working = new Map<string, Promise<unknown>>();
  // The timezone the browser says it is in, kept if it is a real one, so
  // Marcel can be told the time where the person is.
  const keepZone = (form: FormData): void => {
    const zone = String(form.get("zone") ?? "");
    if (!zone || zone === store.setting("zone")) return;
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      store.setSetting("zone", zone);
    } catch { /* not a timezone */ }
  };
  const turn = (chat: string, said: string, pictures: Picture[]): void => {
    working.set(chat, say({ store, kernel, ...reach }, chat, said, pictures)
      .catch((error) => {
        console.error(error);
        store.addLine(chat, "marcel", "Something went wrong on my side. Say it again and I will try once more.");
      })
      .finally(() => working.delete(chat)));
  };

  // Sign-ins that have been started and not yet come back.
  const signingIn = new Map<string, Pending>();
  const kept = async (key: string, refuse: (error: string) => Response): Promise<Response> => {
    try {
      await tools({ store, ...reach }, store.service(key)!);
    } catch (error) {
      store.removeService(key);
      return refuse(sentence((error as Error).message));
    }
    return redirect("/services");
  };

  const answer = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    const route = `${request.method} ${url.pathname}`;
    // Where a service sends the person back to after they sign in.
    const back = `${origin ?? url.origin}/services/callback`;

    const asset = ASSETS[url.pathname];
    if (asset && request.method === "GET") {
      return new Response(readFileSync(join(import.meta.dirname, "../assets", asset.file)), { headers: { "content-type": asset.type, "cache-control": "no-cache" } });
    }

    // The kernel calling back. It proves itself with its signature, not a
    // cookie, and is answered before anything a browser can reach.
    const callback = url.pathname.match(/^\/api\/v1\/pieces\/([A-Za-z0-9_-]+)\/(fetch|usage)$/);
    if (callback && request.method === "POST") {
      const [, id, what] = callback;
      const body = new Uint8Array(await request.arrayBuffer());
      const signed = request.headers.get("x-kernel-org") === ORG &&
        kernel.verifies(request.headers.get("authorization"), "POST", `/${ORG}/pieces/${id}/${what}`, body);
      if (!signed) return Response.json({ error: "bad signature" }, { status: 401 });
      if (what === "usage") return Response.json({ ok: true }); // nothing is metered here
      let payload: any;
      try {
        payload = JSON.parse(new TextDecoder().decode(body));
      } catch {
        return Response.json({ error: "bad request" });
      }
      return Response.json(await answerEffect({ store, kernel, origin, ...reach }, id, payload ?? {}));
    }

    // The kernel saying it stopped a schedule that kept failing. It can only
    // ever switch one off.
    const stopped = url.pathname.match(/^\/api\/v1\/pieces\/schedules\/([A-Za-z0-9_-]+)\/status$/);
    if (stopped && request.method === "POST") {
      const body = new Uint8Array(await request.arrayBuffer());
      const signed = request.headers.get("x-kernel-org") === ORG &&
        kernel.verifies(request.headers.get("authorization"), "POST", `/${ORG}/pieces/schedules/${stopped[1]}/status`, body);
      if (!signed) return Response.json({ error: "bad signature" }, { status: 401 });
      const said = JSON.parse(new TextDecoder().decode(body) || "{}");
      if (said?.status === "paused_failures" && store.schedule(stopped[1])) store.stop(stopped[1], String(said.reason ?? "It kept failing."));
      return Response.json({ ok: true });
    }

    // An AI client, over MCP. It presents a token, not a cookie. A browser
    // page on another site must not be able to reach this, so a request that
    // says it came from one is refused.
    if (url.pathname === "/mcp") {
      const origin = request.headers.get("origin");
      if (origin && new URL(origin).host !== url.host) return Response.json({ error: "wrong origin" }, { status: 403 });
      if (!same(request.headers.get("authorization") ?? "", `Bearer ${mcpToken(secret)}`)) {
        return Response.json({ error: "a token is needed" }, { status: 401, headers: { "www-authenticate": "Bearer" } });
      }
      if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });
      // So the front page can stop asking for a client to be connected.
      if (!store.setting("client")) store.setSetting("client", "connected");
      let message: any;
      try {
        message = await request.json();
      } catch {
        return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "not JSON" } }, { status: 400 });
      }
      const answer = await answerMcp({ store, kernel }, message);
      return answer ? Response.json(answer) : new Response(null, { status: 202 });
    }

    if (route === "POST /enter") {
      const given = (await request.formData()).get("secret");
      if (!same(String(given ?? ""), secret)) return page(401, "OpenStudio", enterForm("That is not the secret.", secretAt));
      return redirect("/", { "set-cookie": `session=${session}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000` });
    }
    if (local) {
      const why = fromElsewhere(request, url);
      if (why) return refused(why);
    } else if (!same(cookie(request, "session"), session)) {
      return page(401, "OpenStudio", enterForm(undefined, secretAt));
    }

    if (route === "POST /setup") {
      const form = await request.formData();
      const first = !store.ready();
      // A field left empty keeps the key already saved, so one key can be
      // replaced without typing the others again.
      const given = APP_KEYS.map((key) => [key.name, String(form.get(key.name) ?? "").trim(), key.required] as const);
      const wrong: Record<string, string> = {};
      await Promise.all(given.map(async ([name, value, required]) => {
        if (value === "") {
          if (required && !store.has(name)) wrong[name] = "This key is needed.";
        } else {
          const problem = await checkKey(name, value, reach.http);
          if (problem) wrong[name] = problem;
        }
      }));
      // Good keys are kept even when another is wrong: nobody should have to
      // paste a working key twice.
      for (const [name, value] of given) if (value !== "" && !wrong[name]) store.seal(name, value);
      if (Object.keys(wrong).length > 0) {
        return store.ready() ? page(422, "Services", servicesPage(store, setupForm(store, wrong), { back }), "wide") : page(422, "Setup", setupPage(setupForm(store, wrong)));
      }
      // The first time, straight to Marcel. After that the keys are a
      // settings page, and saving one stays on it.
      return redirect(first ? "/new" : "/services");
    }
    if (route === "GET /settings/keys") return redirect("/services");
    if (route === "GET /setup" || route === "GET /services") {
      if (store.ready() && route === "GET /setup") return redirect("/services");
      if (!store.ready() && route !== "GET /setup") return redirect("/setup");
      // Saved keys are asked about each time the page is opened, so one that
      // has stopped working shows here.
      const wrong: Record<string, string> = {};
      await Promise.all(APP_KEYS.map(async (key) => {
        const saved = store.has(key.name) ? store.open(key.name) : null;
        const problem = saved ? await checkKey(key.name, saved, reach.http) : null;
        if (problem) wrong[key.name] = problem;
      }));
      return store.ready() ? page(200, "Services", servicesPage(store, setupForm(store, wrong), { back }), "wide") : page(200, "Setup", setupPage(setupForm(store, wrong)));
    }
    if (!store.ready()) return redirect("/setup");

    // A service is added with a token, or by signing in to it. Either way it
    // is asked what it can do before it is kept, so a wrong address or token
    // is found now and not when a piece first needs it.
    // Google signs people in to an app, and here that app is the operator's
    // own: its ID and secret, made in Google's console, are kept sealed. It
    // is asked for when a Google service is first connected, and saving it
    // carries straight on to signing in.
    const connectGoogle = async (key: string): Promise<Response> => {
      const client = store.open("google:client");
      if (!client) return page(200, "Google sign-in app", googleApp(back, key), "wide");
      if (store.service(key)) return redirect("/services");
      const { to, state, pending } = await begin({ store, ...reach }, { key, name: BUILT_IN[key].name, url: GOOGLE }, back, JSON.parse(client),
        { authorize: AUTHORIZE, token: TOKEN, scopes: BUILT_IN[key].scopes, extra: { access_type: "offline", prompt: "consent" } });
      signingIn.set(state, pending);
      return redirect(to);
    };
    if (route === "GET /services/google") return page(200, "Google sign-in app", googleApp(back), "wide");
    if (route === "POST /services/google") {
      const form = await request.formData();
      const id = String(form.get("client_id") ?? "").trim(), secret = String(form.get("client_secret") ?? "").trim(), catalog = String(form.get("catalog") ?? "");
      if (!id || !secret) return page(422, "Google sign-in app", googleApp(back, catalog, "Google needs both the client ID and the client secret."), "wide");
      store.seal("google:client", JSON.stringify({ id, secret }));
      return catalog in BUILT_IN ? connectGoogle(catalog) : redirect("/services");
    }
    if (route === "POST /services/connect" && String((await request.clone().formData()).get("catalog")) in BUILT_IN) {
      return connectGoogle(String((await request.formData()).get("catalog")));
    }
    if (route === "POST /services" || route === "POST /services/connect") {
      const form = await request.formData();
      const ready = CATALOG.find((entry) => entry.key === form.get("catalog"));
      const values = ready ? { name: ready.name, key: ready.key, url: ready.url }
        : Object.fromEntries(["name", "key", "url"].map((field) => [field, String(form.get(field) ?? "").trim()]));
      const refuse = (error: string, needsClient = false) => page(422, "Services", servicesPage(store, setupForm(store), { error, values: ready ? {} : values, needsClient, back }), "wide");
      if (!values.name) return refuse("Give it a name.");
      if (!KEY.test(values.key) || APP_KEYS.some((key) => key.name === values.key)) return refuse("A key is lowercase letters, numbers and underscores, like google_calendar.");
      if (store.service(values.key)) return refuse(`There is already a service with the key ${values.key}.`);
      const address = serviceAddress(values.url);
      if (!address) return refuse("The address must be https, or on this machine.");
      const service = { key: values.key, name: values.name.slice(0, 60), url: address.href, header: ready?.header ?? null };

      if (route === "POST /services/connect") {
        const client = { id: String(form.get("client_id") ?? "").trim(), secret: String(form.get("client_secret") ?? "").trim() || undefined };
        try {
          const { to, state, pending } = await begin({ store, ...reach }, service, back, client.id ? client : undefined);
          for (const [old, waiting] of signingIn) if (Date.now() > waiting.at + 10 * 60_000) signingIn.delete(old);
          signingIn.set(state, pending);
          return redirect(to);
        } catch (error) {
          return refuse(sentence((error as Error).message), /client ID/.test((error as Error).message));
        }
      }
      const token = String(form.get("token") ?? "").trim();
      if (ready && !token) return refuse(`${ready.name} needs its ${ready.token?.toLowerCase() ?? "token"}.`);
      store.addService(service);
      if (token) store.seal(`service:${service.key}`, token);
      return kept(service.key, refuse);
    }
    // Back from signing in. The state is ours, made a moment ago; anything
    // else is not a sign-in we started.
    if (route === "GET /services/callback") {
      const pending = signingIn.get(url.searchParams.get("state") ?? "");
      signingIn.delete(url.searchParams.get("state") ?? "");
      const refuse = (error: string) => page(422, "Services", servicesPage(store, setupForm(store), { error, back }), "wide");
      if (!pending || Date.now() > pending.at + 10 * 60_000) return refuse("That sign-in has expired. Start it again.");
      if (!url.searchParams.get("code")) return refuse(`${pending.name} did not sign you in.`);
      if (store.service(pending.key)) return refuse(`There is already a service with the key ${pending.key}.`);
      try {
        await finish({ store, ...reach }, pending, url.searchParams.get("code")!);
      } catch (error) {
        return refuse(sentence((error as Error).message));
      }
      store.addService({ key: pending.key, name: pending.name, url: pending.url });
      return kept(pending.key, refuse);
    }
    const [, removed] = url.pathname.match(/^\/services\/([a-z0-9_]+)\/remove$/) ?? [];
    if (removed && request.method === "POST") {
      store.removeService(removed);
      return redirect("/services");
    }


    // Talking to Marcel is the front door. A chat begins with what you say.
    if (route === "GET /") return redirect("/new");
    if (route === "GET /new") return page(200, "New chat", fresh(store), "wide");
    if (route === "POST /new") {
      const form = await request.formData();
      keepZone(form);
      const said = String(form.get("say") ?? "").trim().slice(0, 8_000);
      const pictures = await picturesIn(form);
      if (!said && pictures.length === 0) return redirect("/new");
      const chat = store.addChat(said || "A picture");
      turn(chat, said, pictures);
      return redirect(`/chats/${chat}#latest`);
    }
    if (url.pathname === "/chats" && request.method === "GET") return page(200, "Chats", allChats(store), "wide");

    // A picture is shown only from the chat it was sent in, and only as the
    // kind of picture it was found to be.
    const [, pictureChat, pictureId] = url.pathname.match(/^\/chats\/([A-Za-z0-9]+)\/pictures\/([a-z0-9]+)$/) ?? [];
    if (pictureChat && request.method === "GET") {
      const picture = store.picture(pictureChat, pictureId);
      if (!picture) return notFound();
      return new Response(picture.bytes, { headers: { "content-type": picture.type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=31536000, immutable" } });
    }

    const [, chatId, chatAct] = url.pathname.match(/^\/chats\/([A-Za-z0-9]+)(?:\/(remove|rename))?$/) ?? [];
    if (chatId) {
      const chat = store.chat(chatId);
      if (!chat) return notFound();
      if (request.method === "POST" && chatAct === "remove") {
        store.removeChat(chat.id);
        return redirect("/new");
      }
      if (request.method === "POST" && chatAct === "rename") {
        store.renameChat(chat.id, String((await request.formData()).get("title") ?? ""));
        return redirect(`/chats/${chat.id}`);
      }
      if (request.method === "POST" && !chatAct) {
        const form = await request.formData();
        keepZone(form);
        const said = String(form.get("say") ?? "").trim().slice(0, 8_000);
        const pictures = await picturesIn(form);
        // One turn at a time: what is sent while he is working is not taken.
        if ((said || pictures.length > 0) && !working.has(chat.id)) turn(chat.id, said, pictures);
        return redirect(`/chats/${chat.id}#latest`);
      }
      if (request.method === "GET" && !chatAct) return page(200, chat.title, talk(store, chat, working.has(chat.id)), "wide");
      return notFound();
    }

    if (route === "GET /settings") return redirect("/settings/memory");
    if (route === "GET /settings/memory") return page(200, "Settings", settings("memory", notes(store)), "wide");
    if (route === "GET /marcel" || route === "GET /notes") return redirect(route === "GET /marcel" ? "/new" : "/settings/memory");
    if (route === "POST /notes") {
      const form = await request.formData();
      const file = form.get("file");
      try {
        if (file instanceof File && file.size > 0) {
          const kept = loadNotes(store, await file.text());
          return page(200, "Settings", settings("memory", notes(store, `${kept} ${kept === 1 ? "note" : "notes"} loaded.`)), "wide");
        }
        remember(store, String(form.get("note") ?? ""));
      } catch (error) {
        return page(422, "Settings", settings("memory", notes(store, sentence((error as Error).message))), "wide");
      }
      return redirect("/settings/memory");
    }
    const forgotten = url.pathname.match(/^\/notes\/(\d+)\/forget$/);
    if (forgotten && request.method === "POST") {
      store.forget(Number(forgotten[1]));
      return redirect("/settings/memory");
    }
    if (route === "GET /settings/model") return page(200, "Settings", settings("model", modelForm(store)), "wide");
    if (route === "POST /settings/model") {
      const form = await request.formData();
      const value = String(form.get("model") ?? "").trim() || DEFAULT_MODEL;
      const picture = String(form.get("picture_model") ?? "").trim() || PICTURE_MODEL;
      const error = value === DEFAULT_MODEL ? null : await checkModel(value, reach.http);
      const pictureError = picture === PICTURE_MODEL ? null : await checkModel(picture, reach.http, "pictures");
      if (error || pictureError) return page(422, "Settings", settings("model", modelForm(store, { error, value, pictureError, picture })), "wide");
      store.setSetting("model", value);
      store.setSetting("picture_model", picture);
      return redirect("/settings/model");
    }
    if (route === "GET /connect") return redirect("/settings/client");
    if (route === "GET /settings/client") return page(200, "Settings", settings("client", connect(`${url.protocol}//${url.host}/mcp`, mcpToken(secret))), "wide");
    if (route === "GET /pieces") return page(200, "Pieces", home(store.pieces()), "wide");

    if (route === "POST /pieces") {
      const file = (await request.formData()).get("piece");
      if (!(file instanceof File)) return page(422, "OpenStudio", home(store.pieces(), "Choose a piece to load."));
      try {
        const piece = await loadPiece(new Uint8Array(await file.arrayBuffer()), { store, kernel });
        return redirect(`/pieces/${piece.id}`);
      } catch (error) {
        return page(422, "OpenStudio", home(store.pieces(), (error as Error).message));
      }
    }

    const acted = url.pathname.match(/^\/schedules\/([A-Za-z0-9_-]+)\/(on|off|run|remove)$/);
    if (acted && request.method === "POST") {
      const schedule = store.schedule(acted[1]);
      if (!schedule) return notFound();
      try {
        if (acted[2] === "run") await runNow({ store, kernel }, schedule.id);
        else if (acted[2] === "remove") await removeSchedule({ store, kernel }, schedule.id);
        else await setSchedule({ store, kernel }, schedule.id, acted[2] === "on");
      } catch (error) {
        return page(422, "Schedule", `${alert((error as Error).message)}<a href="/pieces/${schedule.piece}/access" class="underline">Back</a>`);
      }
      return redirect(`/pieces/${schedule.piece}/access`);
    }

    // The browser a piece opened, for the person to sign in to something
    // themselves. What they type goes to that browser, never through here.
    const [, shownPiece, shown] = url.pathname.match(/^\/pieces\/([A-Za-z0-9_-]+)\/browser\/(b[a-f0-9]+)$/) ?? [];
    if (shown && request.method === "GET") {
      const piece = store.piece(shownPiece);
      const frame = piece && await liveView({ store, kernel, ...reach }, piece.id, shown).catch(() => null);
      if (!piece || !frame) return page(404, "Browser", browserGone(), "wide");
      return page(200, piece.name, browserView(piece, frame), "full");
    }

    const [, id, view, version] = url.pathname.match(/^\/pieces\/([A-Za-z0-9_-]+)(?:\/(code|access|activity|state|logs|remove|grant|revoke|schedules|restore)(?:\/(\d+))?)?$/) ?? [];
    const piece = id ? store.piece(id) : null;
    if (!piece) return notFound();

    if (request.method === "POST" && view === "schedules") {
      const form = await request.formData();
      try {
        const task = String(form.get("task") ?? "");
        if (!/^[a-zA-Z]\w*$/.test(task)) throw new Error("Name the task to run");
        store.addSchedule({ piece: piece.id, task, spec: specFrom({
          freq: form.get("freq"), timeZone: form.get("timeZone"), hour: form.get("hour"), minute: form.get("minute"),
          days: form.getAll("days").map(String), every: form.get("every"),
        }) });
      } catch (error) {
        return page(422, piece.name, piecePage(piece, "access", alert((error as Error).message)), "full");
      }
      return redirect(`/pieces/${piece.id}/access`);
    }
    if (request.method === "POST" && view === "restore" && version) {
      const { status, body } = await kernel.request("POST", piece.id, `versions/${version}/restore`);
      if (status !== 200) return page(422, piece.name, piecePage(piece, "code", alert(body?.error ?? body?.loadError ?? "That version could not be put back.")), "full");
      return redirect(`/pieces/${piece.id}/code`);
    }
    if (request.method === "POST" && view === "remove") {
      for (const schedule of store.schedules(piece.id)) await kernel.scheduler("DELETE", `schedules/${schedule.id}`);
      await releaseAll({ store, kernel, ...reach }, piece.id);
      await kernel.request("DELETE", piece.id, "");
      store.removePiece(piece.id);
      return redirect("/pieces");
    }
    if (request.method === "POST" && (view === "grant" || view === "revoke")) {
      const form = await request.formData();
      const kind = String(form.get("kind"));
      if (!KINDS.includes(kind)) return page(422, piece.name, piecePage(piece, "access", alert("That cannot be granted.")), "full");
      if (view === "revoke") store.revoke(piece.id, kind);
      else if (kind === "web") store.grant(piece.id, kind, { hosts: listed(form.get("hosts")) });
      else if (kind === "mcp") store.grant(piece.id, kind, { services: form.getAll("service").map(String).filter((key) => store.service(key)) });
      else if (kind === "link") store.grant(piece.id, kind, { pieces: form.getAll("piece").map(String).filter((other) => other !== piece.id && store.piece(other)) });
      else store.grant(piece.id, kind, {});
      return redirect(`/pieces/${piece.id}/access`);
    }
    if (request.method !== "GET" || ["remove", "grant", "revoke", "schedules", "restore"].includes(view ?? "")) return notFound();
    // Its log and its raw state are not shown, as in OpenStudio: they are for
    // whoever is writing the piece, and an AI client reads them over MCP.
    if (view === "state" || view === "logs" || view === "activity") return redirect(`/pieces/${piece.id}`);

    // A piece has three sides, as in OpenStudio: the app itself, its code,
    // and what it may reach and when it runs.
    if (view === "code") {
      const [code, history] = await Promise.all([kernel.request("GET", piece.id, "files"), kernel.request("GET", piece.id, "versions")]);
      return page(200, piece.name, piecePage(piece, "code", codeView(piece, code.body?.files ?? {}, code.body?.version, history.body?.versions ?? [], url.searchParams.get("file"))), "full");
    }
    if (view === "access") {
      const tasks = (await kernel.request("GET", piece.id, "tasks")).body?.tasks ?? [];
      return page(200, piece.name, piecePage(piece, "access", accessView(piece, store, await timings({ kernel }), tasks)), "full");
    }
    const frame = kernel.pageUrl(piece.id, kernel.ticket(piece.id, { minutes: 60 }));
    return page(200, piece.name, piecePage(piece, "app", appFrame(piece, frame)), "full");
  };

  // Every page a signed-in person sees has the menu down its left side.
  return Object.assign(async (request: Request) => {
    const reply = await answer(request);
    if (!reply.headers.get("content-type")?.startsWith("text/html")) return reply;
    const inside = local ? reply.status !== 403 : same(cookie(request, "session"), session);
    if (!inside || !store.ready()) return reply;
    return new Response(framed(await reply.text(), sidebar(store, new URL(request.url).pathname)), { status: reply.status, headers: reply.headers });
  }, { idle: () => Promise.all(working.values()) });
}


// What can be granted here. Each is off until someone turns it on.
const KINDS = ["web", "search", "llm", "link", "mcp"];

function listed(value: unknown): string[] {
  return String(value ?? "").split(/[\s,]+/).map((host) => host.trim().toLowerCase()).filter(Boolean).slice(0, 50);
}

function sentence(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1) + (message.endsWith(".") ? "" : ".");
}

// On this machine there is no secret, so the danger is a page on some other
// website quietly sending requests here from your browser. Two things stop
// it: the request must be addressed to this machine by its own name (which
// defeats a name made to point here), and anything that changes something
// must say it came from one of this app's own pages.
const OWN_NAMES = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

function fromElsewhere(request: Request, url: URL): string | null {
  if (!OWN_NAMES.test(request.headers.get("host") ?? url.host)) return "This is only answered at localhost.";
  if (request.method === "GET" || request.method === "HEAD") return null;
  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin ? new URL(origin).host !== url.host : site !== null && site !== "same-origin" && site !== "none") {
    return "That came from another site, so it was not done.";
  }
  return null;
}

// What the pages load. None of it is secret, so it is served to anyone: the
// page that asks for the secret needs its stylesheet too.
const ASSETS: Record<string, { file: string; type: string }> = {
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/marcel.png": { file: "marcel-96.png", type: "image/png" },
  "/marcel-large.png": { file: "marcel-512.png", type: "image/png" },
  "/mark-black.svg": { file: "mark-black.svg", type: "image/svg+xml" },
  "/mark-white.svg": { file: "mark-white.svg", type: "image/svg+xml" },
};

function redirect(to: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location: to, ...headers } });
}

function cookie(request: Request, name: string): string {
  const found = (request.headers.get("cookie") ?? "").split(/;\s*/).find((part) => part.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : "";
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
