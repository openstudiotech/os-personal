// The pages. Markup only: what is on each is decided in server.ts.
//
// Classes are Tailwind's, on OpenStudio's theme (src/app.css). After changing
// any class here, run `npm run css`. Every colour has its dark partner.
import { icon } from "./icons.ts";
import { APP_KEYS, type Piece, type Schedule, type Store } from "./store.ts";
import { DEFAULT_MODEL, modelName } from "./model.ts";
import { MAX_PICTURES, PICTURE_MODEL, pictureModel } from "./pictures.ts";
import { describeSpec, nextSaid } from "./schedules.ts";
import { CATALOG } from "./catalog.ts";
import { BUILT_IN } from "./google/index.ts";

const BUTTON = "inline-flex h-[34px] items-center justify-center gap-2 rounded-full bg-gray-950 px-4 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50 dark:bg-white dark:text-gray-950";
const QUIET = "inline-flex h-[30px] items-center justify-center rounded-full border border-gray-300 px-3 text-sm text-gray-600 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-800";
const FIELD = "rounded-md border border-gray-300 bg-transparent px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 focus:border-gray-500 focus:outline-none dark:border-gray-700 dark:text-gray-100 dark:placeholder:text-gray-500 dark:focus:border-gray-400";
const INPUT = `w-full ${FIELD}`;
const LABEL = "text-xs uppercase tracking-[0.24px] text-gray-500 dark:text-gray-400";
const MUTED = "text-gray-500 dark:text-gray-400";
const RULE = "border-gray-200 dark:border-gray-800";
const HEADING = "text-xl font-medium tracking-tight text-gray-950 dark:text-white";
const ROW = "flex h-[36px] items-center gap-2 rounded-full px-2 text-sm tracking-[0.28px] text-gray-950 hover:bg-gray-100 aria-[current]:bg-gray-100 aria-[current]:font-medium dark:text-gray-200 dark:hover:bg-gray-800 dark:aria-[current]:bg-gray-800";
const TAB = "border-b-2 border-transparent py-2 text-sm text-gray-500 hover:text-gray-900 aria-[current]:border-gray-950 aria-[current]:font-medium aria-[current]:text-gray-950 dark:text-gray-400 dark:hover:text-white dark:aria-[current]:border-white dark:aria-[current]:text-white";

export function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// Every page. `side` is the menu, put in for someone who is inside.
export function page(status: number, title: string, body: string, width: "narrow" | "wide" | "full" = "narrow"): Response {
  const measure = { narrow: "max-w-sm pt-[14vh]", wide: "max-w-3xl", full: "max-w-6xl" }[width];
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)}</title>
<link rel="stylesheet" href="/app.css"></head>
<body class="min-h-dvh bg-white font-sans text-sm text-gray-900 antialiased dark:bg-gray-900 dark:text-gray-100"><!--side--><main data-width="${width}" class="mx-auto flex w-full min-w-0 flex-col gap-4 px-6 py-10 ${measure}">${body}</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// The page with the menu down its left.
export function framed(html: string, menu: string): string {
  return html.replace("<!--side-->", menu)
    .replace('<body class="', '<body class="md:grid md:grid-cols-[260px_minmax(0,1fr)] ');
}

export const notFound = (): Response => page(404, "Not found", `<h1 class="${HEADING}">Not found</h1>`);
export const alert = (message: string): string => `<p role="alert" class="text-sm text-gray-600 dark:text-gray-300">${escape(message)}</p>`;
export const refused = (message: string): Response => page(403, "OpenStudio Personal", `<h1 class="${HEADING}">OpenStudio Personal</h1>${alert(message)}`);

// The menu, as OpenStudio's is: a new chat, home, pieces, the chats so far,
// and settings at the foot. Home here is Marcel. On a phone it is a bar
// across the top that stays put, and the rest opens from the button in it.
const RECENT = 30;

export function sidebar(store: Store, here: string): string {
  const at = (...paths: string[]) => (paths.some((path) => here === path || here.startsWith(`${path}/`)) ? ' aria-current="page"' : "");
  const row = (href: string, name: Parameters<typeof icon>[0], label: string, current: string, size = 20) =>
    `<li><a href="${href}"${current} class="${ROW}"><span class="shrink-0 text-gray-400">${icon(name, size)}</span><span class="min-w-0 flex-1 truncate">${label}</span></a></li>`;
  const chats = store.chats(RECENT).map((chat) => row(`/chats/${chat.id}`, "chat-bubble-left", escape(chat.title), at(`/chats/${chat.id}`), 14)).join("");
  return `<aside data-side class="sticky top-0 z-10 flex max-h-dvh flex-col border-b border-edge-subtle bg-nav-secondary md:h-dvh md:border-b-0 md:border-r dark:border-gray-800 dark:bg-gray-950">
    <input id="menu" type="checkbox" aria-label="Menu" class="peer sr-only">
    <header class="flex h-[55px] shrink-0 items-center justify-between border-b border-edge-subtle bg-nav-primary px-3 dark:border-gray-800 dark:bg-gray-900">
      <a href="/new" title="OpenStudio Personal" class="flex w-9 items-center justify-center"><picture><source srcset="/mark-white.svg" media="(prefers-color-scheme: dark)"><img src="/mark-black.svg" alt="OpenStudio Personal" width="24" height="30"></picture></a>
      <div class="flex items-center gap-1 md:hidden">
        <a href="/new" title="New chat" class="flex size-9 items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">${icon("plus")}</a>
        <label for="menu" title="Menu" class="flex size-9 cursor-pointer items-center justify-center rounded-full text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800">${icon("bars-3")}</label>
      </div>
    </header>
    <nav class="hidden min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-2 pt-3 peer-checked:flex md:flex">
      <div class="py-2"><a href="/new" class="flex h-[34px] w-full items-center justify-center gap-2 rounded-full bg-brand-800 text-sm font-medium text-white hover:opacity-90 dark:bg-white dark:text-gray-950">${icon("plus", 16)}<span>New chat</span></a></div>
      <ul role="list" class="space-y-px">${row("/new", "sparkles", "Marcel", at("/new"))}${row("/pieces", "squares-2x2", "Pieces", at("/pieces"))}${row("/services", "bolt", "Services", at("/services"))}</ul>
      <header class="flex items-center px-2 pb-1 pt-4"><p class="flex-1 ${LABEL}">Recent chats</p>${chats ? `<a href="/chats" class="text-xs text-gray-500 hover:text-gray-900 hover:underline dark:text-gray-400 dark:hover:text-white">All</a>` : ""}</header>
      ${chats ? `<ul role="list" data-chats class="max-h-40 min-h-0 space-y-px overflow-y-auto md:max-h-none md:flex-1">${chats}</ul>` : `<p class="px-2 py-1 text-sm ${MUTED}">No chats yet</p>`}
      <ul role="list" class="mt-auto shrink-0 space-y-px pt-3">${row("/settings/memory", "cog-6-tooth", "Settings", at("/settings"))}</ul>
    </nav>
  </aside>`;
}

function tabs(items: Array<[href: string, label: string, current: boolean]>): string {
  return `<nav class="flex gap-5 border-b ${RULE}">${items.map(([href, label, current]) =>
    `<a href="${href}"${current ? ' aria-current="page"' : ""} class="-mb-px ${TAB}">${label}</a>`).join("")}</nav>`;
}

// The box you type in, as OpenStudio's is: one card, and a round button that
// wakes when there is something to send. Enter sends; Shift and Enter makes a
// new line; Enter while a word is still being composed (as when typing
// Japanese) belongs to the keyboard. "/" from anywhere on the page puts you
// in the box.
const composer = (action: string, placeholder: string, compact = false, working = false) => `<form data-say${working ? " data-working" : ""} method="post" action="${action}" enctype="multipart/form-data" onsubmit="this.querySelector('button').disabled = true;"
      class="flex w-full items-end gap-2 border border-gray-300 bg-white text-left focus-within:border-gray-400 dark:border-gray-700 dark:bg-gray-950 dark:focus-within:border-gray-500 ${compact ? "rounded-xl py-2 pl-4 pr-2" : "min-h-[110px] rounded-2xl pb-4 pl-4 pr-3 pt-3"}">
      <input type="hidden" name="zone">
      <div class="flex min-w-0 flex-1 flex-col gap-2 self-stretch">
        <div data-pictures class="flex flex-wrap gap-2 empty:hidden"></div>
        <textarea name="say" rows="${compact ? 1 : 2}" aria-label="Say" placeholder="${placeholder}" autofocus
          class="max-h-48 min-w-0 flex-1 resize-none border-0 [field-sizing:content] bg-transparent p-0 text-sm leading-5 text-gray-950 placeholder:text-gray-400 focus:outline-none dark:text-gray-100 dark:placeholder:text-gray-500"
          onkeydown="if (event.key === 'Enter' &amp;&amp; !event.shiftKey &amp;&amp; !event.isComposing) { event.preventDefault(); if (!this.form.querySelector('button').disabled) this.form.requestSubmit(); }"></textarea>
      </div>
      <label title="Add a picture" class="flex size-[38px] shrink-0 cursor-pointer items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800">${icon("paper-clip")}
        <input name="picture" type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple aria-label="Add a picture" class="sr-only"></label>
      <button disabled aria-label="Send" title="Send" class="flex size-[38px] shrink-0 items-center justify-center rounded-full bg-gray-950 text-white disabled:bg-gray-200 disabled:text-gray-400 dark:bg-white dark:text-gray-950 dark:disabled:bg-gray-800 dark:disabled:text-gray-500">${icon("arrow-up")}</button>
    </form>
    <script>
      document.addEventListener("keydown", (event) => {
        const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName ?? "");
        if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey) { event.preventDefault(); document.querySelector("[data-say] textarea")?.focus(); }
      });
      // Pictures are chosen, or pasted anywhere in the box. The button wakes
      // for words or for a picture, once he is not in the middle of a turn:
      // the box can be typed in while he works, and sent when he is done. A big picture is made smaller here,
      // before it is sent: it is read as well, sooner and for less.
      {
        const form = document.querySelector("[data-say]");
        // So he knows what time it is where you are.
        form.zone.value = Intl.DateTimeFormat().resolvedOptions().timeZone;
        const chosen = form.querySelector("input[type=file]");
        const shown = form.querySelector("[data-pictures]");
        const ready = () => {
          form.querySelector("button").disabled = form.hasAttribute("data-working") || (!form.say.value.trim() && chosen.files.length === 0);
          shown.replaceChildren(...[...chosen.files].map((file) => Object.assign(new Image(), { src: URL.createObjectURL(file), alt: "", className: "size-14 rounded-md border border-gray-200 object-cover dark:border-gray-700" })));
        };
        const EDGE = 1600;
        const smaller = async (file) => {
          const picture = await createImageBitmap(file).catch(() => null);
          if (!picture || (Math.max(picture.width, picture.height) <= EDGE && file.size < 500000)) return file;
          const scale = Math.min(1, EDGE / Math.max(picture.width, picture.height));
          const canvas = Object.assign(document.createElement("canvas"), { width: Math.round(picture.width * scale), height: Math.round(picture.height * scale) });
          const pen = canvas.getContext("2d");
          pen.fillStyle = "#fff";
          pen.fillRect(0, 0, canvas.width, canvas.height);
          pen.drawImage(picture, 0, 0, canvas.width, canvas.height);
          const made = await new Promise((done) => canvas.toBlob(done, "image/jpeg", 0.85));
          return made && (scale < 1 || made.size < file.size) ? new File([made], "picture.jpg", { type: "image/jpeg" }) : file;
        };
        const keep = async (files) => {
          const all = new DataTransfer();
          for (const file of await Promise.all(files.slice(0, ${MAX_PICTURES}).map(smaller))) all.items.add(file);
          chosen.files = all.files;
          ready();
        };
        form.say.addEventListener("input", ready);
        chosen.addEventListener("change", () => keep([...chosen.files]));
        form.addEventListener("paste", (event) => {
          const pasted = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
          if (pasted.length === 0) return;
          event.preventDefault();
          keep([...chosen.files, ...pasted]);
        });
      }
    </script>`;

// Where a chat starts, laid out as OpenStudio's front page is: who you are
// talking to, the box, one line on the other way in, and what is left to set
// up. Nothing here says who Marcel is.
export function fresh(store: Store): string {
  const steps: Array<[string, boolean, string]> = [
    ["Add your keys", store.ready(), "/services"],
    ["Connect your AI client", store.setting("client") !== null, "/settings/client"],
    ["Load a piece", store.pieces().length > 0, "/pieces"],
    ["Let a piece reach something", store.anyGrant(), "/pieces"],
    ["Turn on a schedule", store.schedules().some((schedule) => schedule.enabled), "/pieces"],
    ["Tell Marcel how you like something done", store.memories().length > 0, "/settings/memory"],
  ];
  const done = steps.filter(([, finished]) => finished).length;
  const list = steps.map(([title, finished, href]) => finished
    ? `<li data-done class="flex items-center gap-2 text-gray-400 dark:text-gray-500">${icon("check-circle", 16)}<span class="line-through">${title}</span></li>`
    : `<li class="flex items-center gap-2 text-gray-900 dark:text-gray-100">${icon("minus-circle", 16)}<a href="${href}" class="hover:underline">${title}</a></li>`).join("");
  return `<div class="flex flex-col items-center gap-4 pt-[12vh] text-center">
    <img src="/marcel-large.png" alt="" width="80" height="80" class="size-20 rounded-full border border-gray-200 bg-white dark:border-gray-700">
    <h1 class="text-[28px] leading-normal text-gray-950 dark:text-white">What are we doing today?</h1>
    ${composer("/new", "Ask Marcel to check a piece, look something up, or run something...")}
    <p class="pt-2 text-xs text-gray-400 dark:text-gray-500">or <a href="/pieces" class="underline hover:text-gray-600 dark:hover:text-gray-300">load a piece</a></p>
    ${done === steps.length ? "" : `<details data-steps class="w-full max-w-md pt-1 text-sm"${done < 3 ? " open" : ""}>
      <summary class="cursor-pointer select-none list-none text-xs ${MUTED} hover:text-gray-700 dark:hover:text-gray-200">Getting started · ${done} of ${steps.length}</summary>
      <ul class="mt-3 space-y-1.5 text-left">${list}</ul></details>`}
  </div>`;
}

// Every chat, newest first. The menu holds only the recent ones.
export function allChats(store: Store): string {
  const list = store.chats(100000).map((chat) => `<li class="border-t ${RULE}"><a href="/chats/${chat.id}" class="block truncate py-3 text-gray-950 hover:underline dark:text-white">${escape(chat.title)}</a></li>`).join("");
  return `<h1 class="${HEADING}">Chats</h1>${list ? `<ul>${list}</ul>` : `<p class="${MUTED}">None yet.</p>`}`;
}

// A chat, laid out as OpenStudio's is: what you said is a card on the
// right, what he said is prose on the page, and what he did is a line
// between. The box stays at the foot of the window. What he did is always
// shown, since nothing asks before he does it.
export function talk(store: Store, chat: { id: string; title: string }, working = false): string {
  const lines = store.conversation(chat.id);
  const said = lines.map((line, i) => {
    const last = "";
    if (line.role === "did") return `<p data-did${last} class="flex items-center gap-1.5 text-xs ${MUTED} before:size-1.5 before:shrink-0 before:rounded-full before:bg-gray-400 dark:before:bg-gray-500">${escape(line.text)}</p>`;
    if (line.role === "you") {
      const pictures = line.pictures.map((id) => `<a href="/chats/${chat.id}/pictures/${id}" target="_blank"><img src="/chats/${chat.id}/pictures/${id}" alt="" class="max-h-48 max-w-full rounded-xl border border-gray-200 dark:border-gray-700"></a>`).join("");
      const words = line.text.trim() ? `<div class="w-fit max-w-[85%] whitespace-pre-wrap break-words rounded-2xl bg-gray-100 px-3.5 py-2 text-sm leading-6 text-gray-950 dark:bg-gray-800 dark:text-gray-100">${escape(line.text.trim())}</div>` : "";
      return `<div data-line="you"${last} class="flex flex-col items-end gap-2">${pictures}${words}</div>`;
    }
    return `<div data-line="${line.role}"${last} class="whitespace-pre-wrap break-words text-sm leading-6 text-gray-950 dark:text-gray-100">${escape(line.text.trim())}</div>`;
  }).join("");
  const pill = "inline-flex items-center gap-1.5 rounded-full border border-gray-300 py-1.5 text-sm text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800";
  return `<div class="flex min-h-[calc(100dvh-5rem-56px)] flex-col md:min-h-[calc(100dvh-5rem)]">
    <header class="flex items-center justify-between">
      <a href="/chats" class="${pill} pl-2 pr-3.5">${icon("arrow-left", 16)}All chats</a>
      <form method="post" action="/chats/${chat.id}/remove"><button class="${pill} px-3.5">Delete</button></form>
    </header>
    <div class="mt-6 flex min-w-0 items-center gap-2.5">
      <img src="/marcel.png" alt="" width="36" height="36" class="size-9 shrink-0 rounded-full border border-gray-200 bg-white dark:border-gray-700">
      <form method="post" action="/chats/${chat.id}/rename" class="min-w-0 flex-1"><h1>
        <input name="title" value="${escape(chat.title)}" aria-label="Title" title="Click to rename" maxlength="60" required autocomplete="off"
          class="-mx-1.5 w-full truncate rounded-md bg-transparent px-1.5 py-0.5 text-lg font-medium text-gray-950 hover:bg-gray-100 focus:bg-transparent focus:outline-none focus:ring-1 focus:ring-gray-400 dark:text-white dark:hover:bg-gray-800 dark:focus:bg-transparent"
          onkeydown="if (event.key === 'Escape') { this.value = this.defaultValue; this.blur(); }" onblur="this.value = this.defaultValue;"></h1></form>
    </div>
    <div data-transcript${working ? " data-working" : ""} class="flex-1 space-y-5 pt-6">${said}${working ? `<p data-did class="flex animate-pulse items-center gap-1.5 text-xs ${MUTED} before:size-1.5 before:shrink-0 before:rounded-full before:bg-gray-400 dark:before:bg-gray-500">Marcel is working</p>` : ""}</div>
    <div class="sticky bottom-0 bg-white pb-2 pt-6 dark:bg-gray-900">${composer(`/chats/${chat.id}`, "Ask Marcel something...", true, working)}</div>
    <span id="latest"></span>
    ${working ? `<script>
      // He is still working: ask for the chat again until he is done, and
      // show each thing he does as it lands.
      (async function again() {
        await new Promise((wait) => setTimeout(wait, 1000));
        const reply = await fetch(location.pathname).catch(() => null);
        const next = reply?.ok ? new DOMParser().parseFromString(await reply.text(), "text/html").querySelector("[data-transcript]") : null;
        if (!next) return again();
        // Only the lines that are new or different are put on the page, so
        // nothing already there flickers, and the page glides to its foot
        // when something lands. While he is only thinking, nothing moves.
        const shown = document.querySelector("[data-transcript]");
        let changed = false;
        const lines = [...next.children];
        lines.forEach((line, at) => {
          const old = shown.children[at];
          if (old?.outerHTML === line.outerHTML) return;
          changed = true;
          if (old) old.replaceWith(line); else shown.append(line);
        });
        while (shown.children.length > lines.length) shown.lastElementChild.remove();
        shown.toggleAttribute("data-working", next.hasAttribute("data-working"));
        if (changed) scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
        if (shown.hasAttribute("data-working")) return again();
        // What was typed while he worked can now be sent.
        const form = document.querySelector("[data-say]");
        form.removeAttribute("data-working");
        form.say.dispatchEvent(new Event("input"));
      })();
    </script>` : ""}
  </div>`;
}

// Settings: what Marcel remembers, the model, and connecting an AI client.
export function settings(tab: "memory" | "model" | "client", body: string): string {
  return `<h1 class="${HEADING}">Settings</h1>
    ${tabs([["/settings/memory", "Memory", tab === "memory"], ["/settings/model", "Model", tab === "model"], ["/settings/client", "AI client", tab === "client"]])}
    ${body}`;
}

// The model Marcel and every piece use, and the one that reads pictures.
// Left empty, each is its default.
export function modelForm(store: Store, said: { error?: string | null; value?: string; pictureError?: string | null; picture?: string } = {}): string {
  const field = (name: string, label: string, hint: string, value: string, placeholder: string, error?: string | null) => `<label for="${name}" class="${LABEL} mt-2">${label}</label>
      <p class="text-xs text-gray-400 dark:text-gray-500">${hint}</p>
      <input id="${name}" name="${name}" value="${escape(value)}" placeholder="${placeholder}" autocomplete="off" spellcheck="false" class="${INPUT} font-mono">
      ${error ? alert(error) : ""}`;
  return `<form method="post" action="/settings/model" class="flex flex-col gap-2">
      ${field("model", "Model", `Marcel and your pieces use it, and only through providers that do not collect what is sent. <a href="https://openrouter.ai/models" target="_blank" rel="noreferrer" class="underline">Models on OpenRouter</a>`, said.value ?? modelName(store), DEFAULT_MODEL, said.error)}
      ${field("picture_model", "Model that reads pictures", "It describes a picture you send, so Marcel can answer about it.", said.picture ?? pictureModel(store), PICTURE_MODEL, said.pictureError)}
      <button class="${BUTTON} mt-3 self-start">Save</button></form>`;
}

// What Marcel remembers. Each note can be deleted, and a file of them loaded.
export function notes(store: Store, message?: string): string {
  const list = store.memories().map((note) => `<form data-note method="post" action="/notes/${note.id}/forget" class="flex items-center justify-between gap-3 border-t ${RULE} py-2">
      <span class="min-w-0">${escape(note.text)}</span><button class="${QUIET}">Delete</button></form>`).join("");
  return `${message ? alert(message) : ""}
    <div>${list || `<p class="${MUTED}">Nothing yet.</p>`}</div>
    <form method="post" action="/notes" class="flex flex-col gap-2"><label for="note" class="${LABEL}">Add a note</label>
      <div class="flex gap-2"><input id="note" name="note" maxlength="300" required class="${INPUT}"><button class="${BUTTON}">Add</button></div></form>
    <form method="post" action="/notes" enctype="multipart/form-data" class="flex flex-col gap-2"><label for="file" class="${LABEL}">Load notes from a file</label>
      <div class="flex gap-2"><input id="file" name="file" type="file" accept=".json,.txt,text/plain,application/json" required class="${INPUT}"><button class="${BUTTON}">Load</button></div></form>`;
}

// The token is shown here because this is where it is needed.
export function connect(address: string, token: string): string {
  const block = "overflow-x-auto rounded-md border border-gray-200 p-3 font-mono text-xs dark:border-gray-800";
  const copied = (title: string, text: string) => `<div class="flex items-center justify-between"><p class="${LABEL}">${title}</p>
      <button type="button" class="${QUIET}" onclick="navigator.clipboard.writeText(this.parentElement.nextElementSibling.textContent); this.textContent = 'Copied';">Copy</button></div>
    <pre class="${block}">${escape(text)}</pre>`;
  return `<p>Pieces are written and changed from your own AI client. It can read, change, create, test and call pieces. It cannot grant a piece anything or see your keys.</p>
    ${copied("Claude Code", `claude mcp add --transport http openstudio-personal ${address} --header "Authorization: Bearer ${token}"`)}
    ${copied("Codex", `export OPENSTUDIO_PERSONAL_TOKEN=${token}\ncodex mcp add openstudio-personal --url ${address} --bearer-token-env-var OPENSTUDIO_PERSONAL_TOKEN`)}
    <p class="text-xs text-gray-400 dark:text-gray-500">Codex reads the token from that variable each time it starts, so keep the first line in your shell profile.</p>
    ${copied("Any other client", `Address  ${address}\nHeader   Authorization: Bearer ${token}`)}`;
}

// Where the secret is kept, never what it is. On Railway the link opens the
// variable itself, for whoever can sign in to the project.
export type SecretAt = { file: string } | { variable: string; link?: string };

export function enterForm(error?: string, secretAt?: SecretAt): string {
  const where = !secretAt ? ""
    : "file" in secretAt ? `It is in <code>${escape(secretAt.file)}</code>.`
    : `It is the value of <code>${escape(secretAt.variable)}</code>${secretAt.link ? ` in <a href="${escape(secretAt.link)}" class="underline hover:text-gray-600 dark:hover:text-gray-300">this service's variables on Railway</a>` : ""}.`;
  return `<h1 class="${HEADING}">OpenStudio Personal</h1>
    <form method="post" action="/enter" class="flex flex-col gap-2">
      <label for="secret" class="${LABEL}">Secret</label>
      <input id="secret" name="secret" type="password" autocomplete="current-password" autofocus required class="${INPUT}">
      ${where ? `<p class="text-xs text-gray-400 dark:text-gray-500">${where}</p>` : ""}
      ${error ? alert(error) : ""}
      <button class="${BUTTON} mt-2">Enter</button>
    </form>`;
}

// Enough of a key to tell which one it is, as most places show them: its
// first six and last four. A short one shows nothing.
export function masked(key: string | null): string {
  return key && key.length >= 20 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "";
}

// A saved key is never shown back whole: the field says which key it is and
// how it stands, and stays empty. A key that is missing or not working says
// what it is for and where one is made.
export function setupForm(store: Store, wrong: Record<string, string> = {}): string {
  const stands = (name: string) => [masked(store.open(name)), wrong[name] ? "Saved, but not working" : "Saved and working"].filter(Boolean).join(" · ");
  const fields = APP_KEYS.map((key) => `
      <label for="${key.name}" class="${LABEL} mt-2">${escape(key.label)}${key.required ? "" : " · optional"}</label>
      ${store.has(key.name) && !wrong[key.name] ? "" : `<p class="text-xs text-gray-400 dark:text-gray-500">${key.does} <a href="${key.url}" target="_blank" rel="noreferrer" class="underline">Make one at ${key.site}</a></p>`}
      <input id="${key.name}" name="${key.name}" type="password" autocomplete="off" class="${INPUT} aria-[invalid]:border-gray-900 dark:aria-[invalid]:border-gray-100"
             placeholder="${store.has(key.name) ? escape(stands(key.name)) : ""}"
             ${store.has(key.name) || !key.required ? "" : "required"} ${wrong[key.name] ? 'aria-invalid="true"' : ""}>
      ${wrong[key.name] ? alert(wrong[key.name]) : ""}`).join("");
  return `<form method="post" action="/setup" class="flex flex-col gap-2">${fields}
      <button class="${BUTTON} mt-3 self-start">Save</button>
    </form>`;
}

// The first page a new person sees, so Marcel says who he is and what he
// needs. He does not do it again.
export const setupPage = (form: string): string => `<div class="flex flex-col items-center gap-2 pb-4">
      <picture><source srcset="/mark-white.svg" media="(prefers-color-scheme: dark)"><img src="/mark-black.svg" alt="" width="32" height="40"></picture>
      <h1 class="${HEADING}">OpenStudio</h1>
    </div>
    <div class="flex items-start gap-4">
      <img src="/marcel-large.png" alt="" width="64" height="64" class="size-16 shrink-0 rounded-full border border-gray-200 bg-white dark:border-gray-700">
      <div class="flex flex-col gap-2 pt-1"><p>Hi 👋 I'm Marcel, your personal agent. I get things done for you.</p>
        <p>I need at least one key to think with. A second gives me a browser.</p></div>
    </div>${form}`;

// What pieces can be given to use. The keys this app itself uses come
// first; below them, anything that speaks MCP, added by address and token.
// A token is never shown back.
export function servicesPage(store: Store, keys: string, said: { error?: string; values?: Record<string, string>; needsClient?: boolean; back?: string } = {}): string {
  const value = (name: string) => escape(said.values?.[name] ?? "");
  const list = store.services().map((service) => {
    const used = store.usedBy(service.key).map((piece) => `<a href="/pieces/${piece.id}/access" class="underline">${escape(piece.name)}</a>`).join(", ");
    return `<li data-service="${service.key}" class="flex flex-wrap items-center gap-x-4 gap-y-1 border-t ${RULE} py-3">
      <span class="font-medium text-gray-950 dark:text-white">${escape(service.name)}</span>
      <span class="font-mono text-xs ${MUTED}">${service.key}</span>
      <span class="min-w-0 flex-1 truncate ${MUTED}">${escape(new URL(service.url).host.replace(/^www\.googleapis\.com$/, "google.com"))}${used ? ` · ${used}` : ""}</span>
      <form method="post" action="/services/${service.key}/remove"><button class="${QUIET}">Remove</button></form></li>`;
  }).join("");
  // What is ready to connect and not yet connected: one click, or one key.
  // Google's three sit in the same list. They sign in through an app of the
  // operator's own, which is asked for the first time one is connected.
  const listed: Array<{ key: string; name: string; auth: string; token?: string }> = [
    ...Object.entries(BUILT_IN).map(([key, each]) => ({ key, name: each.name, auth: "signin" })), ...CATALOG,
  ];
  const ready = listed.filter((entry) => !store.service(entry.key)).map((entry) => `<li data-ready="${entry.key}" class="border-t ${RULE} py-2">
      <form method="post" action="${entry.auth === "signin" ? "/services/connect" : "/services"}" class="flex flex-wrap items-center gap-3">
        <input type="hidden" name="catalog" value="${entry.key}">
        <span class="w-32 shrink-0 font-medium text-gray-950 dark:text-white">${entry.name}</span>
        <span class="min-w-0 flex-1">${entry.auth === "token" ? `<input name="token" type="password" autocomplete="off" aria-label="${entry.token}" placeholder="${entry.token}" required class="${INPUT}">` : ""}</span>
        <button class="${BUTTON}">${entry.auth === "signin" ? "Connect" : "Add"}</button>
      </form></li>`).join("");
  return `<h1 class="${HEADING}">Services</h1>
    ${keys}
    <p class="${LABEL} mt-4">Connected</p>
    ${list ? `<ul>${list}</ul>` : `<p class="${MUTED}">None yet.</p>`}
    ${said.error ? alert(said.error) : ""}
    ${ready ? `<p class="${LABEL} mt-4">Connect</p><ul>${ready}</ul>` : ""}
    ${store.has("google:client") ? `<p><a href="/services/google" class="text-xs ${MUTED} underline">Google sign-in app</a></p>` : ""}
    <form method="post" action="/services" class="mt-4 grid gap-2 sm:grid-cols-2">
      <p class="${LABEL} sm:col-span-2">Another MCP server</p>
      <input name="name" aria-label="Name" placeholder="Name" value="${value("name")}" maxlength="60" required class="${INPUT}">
      <input name="key" aria-label="Key" placeholder="Key, like google_calendar" value="${value("key")}" pattern="[a-z][a-z0-9_]{1,39}" required class="${INPUT} font-mono">
      <input name="url" aria-label="Address" placeholder="https://mcp.example.com/mcp" value="${value("url")}" required class="${INPUT} font-mono sm:col-span-2">
      <input name="token" aria-label="Token" placeholder="Token" type="password" autocomplete="off" class="${INPUT} sm:col-span-2">
      ${said.needsClient ? `<input name="client_id" aria-label="Client ID" placeholder="Client ID" autocomplete="off" class="${INPUT} font-mono">
      <input name="client_secret" aria-label="Client secret" placeholder="Client secret" type="password" autocomplete="off" class="${INPUT}">` : ""}
      <div class="flex gap-2 sm:col-span-2"><button class="${BUTTON}">Add</button><button formaction="/services/connect" class="${QUIET} h-[34px] px-4">Sign in</button></div>
    </form>`;
}

// Google signs people in to an app, and here that app is the operator's own.
// Asked for when a Google service is first connected; `catalog` is the one
// being connected, so saving carries straight on to signing in.
export function googleApp(back: string, catalog = "", error?: string): string {
  return `<a href="/services" class="text-xs ${MUTED} hover:underline">Services</a>
    <div class="flex items-center gap-2"><h1 class="${HEADING}">Google sign-in app</h1>
      <details data-help class="group relative">
        <summary title="How to get these" aria-label="How to get these" class="flex size-5 cursor-pointer select-none list-none items-center justify-center rounded-full border border-gray-300 text-xs ${MUTED} hover:text-gray-900 dark:border-gray-600 dark:hover:text-white">?</summary>
        <div class="absolute left-0 top-7 z-10 w-80 max-w-[80vw] rounded-xl border border-gray-300 bg-white p-4 text-sm shadow-lg dark:border-gray-700 dark:bg-gray-950">
          <ol class="list-decimal space-y-1.5 pl-4">
            <li>In the <a href="https://console.cloud.google.com/" target="_blank" rel="noopener" class="underline">Google Cloud console</a>, create a project.</li>
            <li>Enable the Gmail, Google Calendar and Google Drive APIs.</li>
            <li>Set up the consent screen and add yourself as a test user.</li>
            <li>Create an OAuth client of type "Web application", with the redirect address below.</li>
            <li>Copy its client ID and client secret here.</li>
          </ol>
          <p class="pt-3"><a href="https://developers.google.com/workspace/guides/create-credentials" target="_blank" rel="noopener" class="underline">Google's guide</a></p>
        </div>
      </details></div>
    <form data-google method="post" action="/services/google" class="flex flex-col gap-2">
      <input type="hidden" name="catalog" value="${escape(catalog)}">
      <label for="client_id" class="${LABEL}">Client ID</label>
      <input id="client_id" name="client_id" autocomplete="off" required autofocus class="${INPUT} font-mono">
      <label for="client_secret" class="${LABEL} mt-2">Client secret</label>
      <input id="client_secret" name="client_secret" type="password" autocomplete="off" required class="${INPUT}">
      <p class="${LABEL} mt-2">Redirect address</p>
      <p class="select-all font-mono text-xs">${escape(back)}</p>
      ${error ? alert(error) : ""}
      <button class="${BUTTON} mt-3 self-start">Save</button>
    </form>`;
}

// Your pieces, and the way to load another.
export function home(pieces: Piece[], error?: string): string {
  const list = pieces.map((piece) => `<li class="flex items-baseline justify-between gap-4 border-t ${RULE} py-3">
      <a href="/pieces/${piece.id}" class="font-medium text-gray-950 hover:underline dark:text-white">${escape(piece.name)}</a><span class="min-w-0 truncate ${MUTED}">${escape(piece.description)}</span></li>`).join("");
  return `<h1 class="${HEADING}">Pieces</h1>
    ${list ? `<ul>${list}</ul>` : `<p class="${MUTED}">None yet.</p>`}
    <form method="post" action="/pieces" enctype="multipart/form-data" class="flex flex-col gap-2">
      <label for="piece" class="${LABEL}">Load a piece</label>
      <div class="flex gap-2"><input id="piece" name="piece" type="file" accept=".zip,application/zip" required class="${INPUT}"><button class="${BUTTON}">Load</button></div>
      ${error ? alert(error) : ""}
    </form>`;
}

// One piece, with its three sides as tabs over a single window, so it is
// plain where the piece begins and ends. Everything above the window is this
// app talking about the piece; everything inside is the piece.
export function piecePage(piece: Piece, tab: "app" | "code" | "access", body: string): string {
  return `<div class="flex min-w-0 flex-col">
    <header class="flex items-end justify-between gap-4">
      <div class="min-w-0"><a href="/pieces" class="text-xs ${MUTED} hover:underline">Pieces</a>
        <h1 class="${HEADING}">${escape(piece.name)}</h1>${piece.description ? `<p class="${MUTED}">${escape(piece.description)}</p>` : ""}</div>
      <form method="post" action="/pieces/${piece.id}/remove"><button class="${QUIET}">Remove</button></form>
    </header>
    <div class="mt-4">${tabs([[`/pieces/${piece.id}`, "App", tab === "app"], [`/pieces/${piece.id}/code`, "Code", tab === "code"], [`/pieces/${piece.id}/access`, "Access", tab === "access"]])}</div>
    <section data-window="${tab}" class="mt-4 min-w-0 overflow-hidden rounded-xl border border-gray-300 dark:border-gray-700 ${tab === "app" ? "" : "flex flex-col gap-4 p-5"}">${body}</section>
  </div>`;
}

export const appFrame = (piece: Piece, frame: string): string =>
  `<iframe title="${escape(piece.name)}" src="${escape(frame)}" class="block h-[74vh] w-full border-0 bg-white"></iframe>`;

// The browser a piece opened, shown so the person can sign in themselves.
export const browserView = (piece: Piece, frame: string): string => `<div class="flex min-w-0 flex-col gap-4">
    <header><a href="/pieces/${piece.id}" class="text-xs ${MUTED} hover:underline">${escape(piece.name)}</a><h1 class="${HEADING}">Sign in, then go back to ${escape(piece.name)}</h1></header>
    <iframe title="Browser" src="${escape(frame)}" class="block h-[78vh] w-full rounded-xl border border-gray-300 bg-white dark:border-gray-700"></iframe>
  </div>`;

export const browserGone = (): string => `<h1 class="${HEADING}">That browser has closed</h1>`;

const PICTURE = /\.(png|jpe?g|webp|gif|avif|pdf)$/i;

// The files it is made of, one shown at a time, and every version there has
// been. A version that would not load is listed and cannot be put back.
export function codeView(piece: Piece, files: Record<string, string>, head: number | undefined, versions: any[], wanted: string | null): string {
  const names = Object.keys(files).sort((a, b) => Number(b === "piece.js") - Number(a === "piece.js") || a.localeCompare(b));
  const open = wanted && files[wanted] !== undefined ? wanted : names[0];
  const list = names.map((name) => `<li><a href="/pieces/${piece.id}/code?file=${encodeURIComponent(name)}"${name === open ? ' aria-current="page"' : ""}
      class="block rounded-md px-2 py-1 font-mono text-xs text-gray-700 hover:bg-gray-100 aria-[current]:bg-gray-100 aria-[current]:text-gray-950 dark:text-gray-300 dark:hover:bg-gray-800 dark:aria-[current]:bg-gray-800 dark:aria-[current]:text-white">${escape(name)}</a></li>`).join("");
  const shown = open === undefined ? `<p class="${MUTED}">No code yet.</p>`
    : PICTURE.test(open) ? `<p class="${MUTED}">${escape(open)} is a picture.</p>`
      : `<pre class="min-w-0 overflow-x-auto rounded-md border border-gray-200 p-4 font-mono text-xs leading-relaxed dark:border-gray-800">${escape(files[open])}</pre>`;
  // The newest version is the one running: a deploy that would not load is
  // followed at once by the last good one, put back.
  const current = head ?? versions[0]?.version;
  const history = versions.map((each) => {
    const tests = each.tests ? `${each.tests.passed} of ${each.tests.total} tests pass` : "";
    const note = each.loadError ? "Would not load" : each.restoredFrom ? `Put back from v${each.restoredFrom}` : "";
    const when = each.at ? new Date(each.at).toISOString().slice(0, 16).replace("T", " ") : "";
    const act = each.version === current ? `<span class="${MUTED}">Current</span>`
      : each.loadError ? "" : `<form method="post" action="/pieces/${piece.id}/restore/${each.version}"><button class="${QUIET}">Put back</button></form>`;
    return `<li data-version="${each.version}" class="grid grid-cols-[3rem_9rem_minmax(0,1fr)_auto] items-center gap-3 border-t ${RULE} py-2">
      <span>v${each.version}</span><span class="${MUTED}">${when}</span><span class="${MUTED}">${escape([note, tests].filter(Boolean).join(". "))}</span>${act}</li>`;
  }).join("");
  return `<div class="grid items-start gap-4 md:grid-cols-[12rem_minmax(0,1fr)]"><ul class="space-y-px">${list}</ul>${shown}</div>
    <p class="${LABEL}">Versions</p><ul>${history || `<li class="${MUTED}">None yet.</li>`}</ul>`;
}

// What it asks for, what it may reach, and when it runs.
export function accessView(piece: Piece, store: Store, held: Map<string, any>, tasks: string[]): string {
  // A service is asked for by its key, so it is plain which one to add.
  const asks = piece.wants.flatMap((want: any) => want?.kind === "mcp" && Array.isArray(want.config?.catalog_keys) ? want.config.catalog_keys.map(String) : [String(want?.kind ?? "unknown")]);
  const wants = asks.map((ask) => `<li class="rounded-full border border-gray-300 px-2.5 py-0.5 text-xs dark:border-gray-700">${escape(ask)}</li>`).join("");
  return `${wants ? `<p class="${LABEL}">Asks for</p><ul data-wants class="flex flex-wrap gap-2">${wants}</ul>` : ""}
    ${reaches(piece, store)}
    ${runs(piece, store.schedules(piece.id), held, tasks)}`;
}

// Each kind of reach is off until someone turns it on.
function reaches(piece: Piece, store: Store): string {
  const web = store.granted(piece.id, "web"), link = store.granted(piece.id, "link"), mcp = store.granted(piece.id, "mcp");
  const services = store.services().map((service) => `<label class="inline-flex items-center gap-1.5"><input type="checkbox" name="service" value="${service.key}" ${mcp?.services?.includes(service.key) ? "checked" : ""}> ${escape(service.name)}</label>`).join("");
  const others = store.pieces().filter((other) => other.id !== piece.id);
  const row = (kind: string, name: string, on: boolean, fields: string) => `
    <form data-reach="${kind}" method="post" action="/pieces/${piece.id}/grant" class="flex flex-wrap items-center gap-3 border-t ${RULE} py-2">
      <input type="hidden" name="kind" value="${kind}">
      <span class="w-32 shrink-0">${name}</span><span class="min-w-0 flex-1">${fields}</span>
      ${on && !fields ? "" : `<button class="${BUTTON}">${on ? "Save" : "Grant"}</button>`}
      ${on ? `<button class="${QUIET}" formaction="/pieces/${piece.id}/revoke">Take away</button>` : ""}
    </form>`;
  const pieces = others.map((other) => `<label class="inline-flex items-center gap-1.5"><input type="checkbox" name="piece" value="${other.id}" ${link?.pieces?.includes(other.id) ? "checked" : ""}> ${escape(other.name)}</label>`).join("");
  return `<p class="${LABEL}">Reaches</p><div>
    ${row("web", "The web", !!web, `<input name="hosts" aria-label="Hosts" placeholder="example.com *.example.org" value="${escape((web?.hosts ?? []).join(" "))}" class="${INPUT}">`)}
    ${row("search", "Web search", !!store.granted(piece.id, "search"), "")}
    ${row("llm", "The model", !!store.granted(piece.id, "llm"), "")}
    ${others.length ? row("link", "Other pieces", !!link, `<span class="flex flex-wrap gap-3">${pieces}</span>`) : ""}
    ${services ? row("mcp", "Services", !!mcp, `<span class="flex flex-wrap gap-3">${services}</span>`) : ""}</div>`;
}

// A schedule is off until someone turns it on, and one the kernel stopped
// says why.
function runs(piece: Piece, schedules: Schedule[], held: Map<string, any>, tasks: string[]): string {
  const rows = schedules.map((schedule) => {
    const timing = held.get(schedule.id);
    const state = schedule.enabled ? `Next ${timing?.nextAt ? escape(nextSaid(timing.nextAt, schedule.spec.timeZone)) : "soon"}`
      : schedule.stopped ? `Stopped. ${escape(schedule.stopped)}` : "Off";
    const act = (what: string, label: string, plain = true) => `<button class="${plain ? QUIET : BUTTON}" formaction="/schedules/${schedule.id}/${what}">${label}</button>`;
    return `<form data-schedule method="post" class="flex flex-wrap items-center gap-3 border-t ${RULE} py-2">
      <span class="w-32 shrink-0 font-medium">${escape(schedule.task)}</span><span>${escape(describeSpec(schedule.spec))}</span><span class="flex-1 ${MUTED}">${state}</span>
      ${schedule.enabled ? act("off", "Turn off") : act("on", "Turn on", false)}${act("run", "Run now")}${act("remove", "Remove")}</form>`;
  }).join("");
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const small = `${FIELD} w-20`;
  const add = tasks.length === 0 ? "" : `<form method="post" action="/pieces/${piece.id}/schedules" class="flex flex-wrap items-center gap-2 border-t ${RULE} py-2">
      <select name="task" aria-label="Task" class="${FIELD}">${tasks.map((task) => `<option>${escape(task)}</option>`).join("")}</select>
      <select name="freq" aria-label="How often" class="${FIELD}"><option value="daily">Every day</option><option value="weekly">Weekly</option><option value="hourly">Every hour</option><option value="interval">Every so many minutes</option></select>
      <input name="hour" aria-label="Hour" type="number" min="0" max="23" value="8" class="${small}">
      <input name="minute" aria-label="Minute" type="number" min="0" max="59" value="0" class="${small}">
      <input name="every" aria-label="Minutes between runs" type="number" min="1" value="60" class="${small}">
      <span class="flex flex-wrap gap-2 text-xs">${["MO", "TU", "WE", "TH", "FR", "SA", "SU"].map((day) => `<label class="inline-flex items-center gap-1"><input type="checkbox" name="days" value="${day}"> ${day}</label>`).join("")}</span>
      <input name="timeZone" aria-label="Time zone" value="${escape(zone)}" class="${FIELD} w-48">
      <button class="${BUTTON}">Add</button>
    </form>`;
  return rows || add ? `<p class="${LABEL}">Runs</p><div>${rows}${add}</div>` : "";
}
