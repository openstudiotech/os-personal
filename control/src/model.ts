// The model Marcel and your pieces use: one setting, one way of asking, and
// a check that a model named in settings is one OpenRouter has.
import type { Store } from "./store.ts";

type Http = (url: string, init: any) => Promise<Response>;

const OPENROUTER = "https://openrouter.ai/api/v1";
export const DEFAULT_MODEL = "openrouter/auto";

export const modelName = (store: Store): string => store.setting("model") ?? DEFAULT_MODEL;

// One request to the model. Only providers that do not collect what is sent
// are used.
export function complete(store: Store, http: Http, body: Record<string, unknown>): Promise<Response> {
  return http(`${OPENROUTER}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${store.open("openrouter")}`, "content-type": "application/json" },
    body: JSON.stringify({ model: modelName(store), provider: { data_collection: "deny" }, ...body }),
    signal: AbortSignal.timeout(120_000),
  });
}

// What is wrong with a model's name, or null when OpenRouter has it and it
// can do what it is wanted for: call tools, which Marcel cannot work
// without, or read pictures.
export async function checkModel(name: string, http: Http = fetch, wanted: "tools" | "pictures" = "tools"): Promise<string | null> {
  try {
    const reply = await http(`${OPENROUTER}/models`, { signal: AbortSignal.timeout(15_000) });
    const listed: any[] | undefined = reply.ok ? (await reply.json())?.data : undefined;
    if (!Array.isArray(listed)) return "OpenRouter could not check that model just now.";
    const found = listed.find((each) => each?.id === name);
    if (!found) return `OpenRouter has no model called ${name}.`;
    if (wanted === "pictures") return found.architecture?.input_modalities?.includes("image") ? null : `${name} cannot read pictures.`;
    if (!found.supported_parameters?.includes("tools")) return `${name} cannot use tools, which Marcel needs.`;
    return null;
  } catch {
    return "OpenRouter could not be reached to check that model.";
  }
}
