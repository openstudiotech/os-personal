// Asking each service whether a key is good, with a request that costs
// nothing. A key is checked when it is saved, so a wrong one is found at
// setup and not the first time a piece needs it.
const CHECKS: Record<string, { service: string; url: string; headers: (key: string) => Record<string, string> }> = {
  openrouter: { service: "OpenRouter", url: "https://openrouter.ai/api/v1/key", headers: (key) => ({ authorization: `Bearer ${key}` }) },
  steel: { service: "Steel", url: "https://api.steel.dev/v1/sessions?limit=1", headers: (key) => ({ "steel-api-key": key }) },
};

type Http = (url: string, init: any) => Promise<Response>;

// What is wrong with the key, or null when the service accepts it. What the
// service said is not repeated: it may contain the key.
export async function checkKey(name: string, key: string, http: Http = fetch): Promise<string | null> {
  const check = CHECKS[name];
  if (!check) return null;
  try {
    const reply = await http(check.url, { headers: check.headers(key), signal: AbortSignal.timeout(15_000) });
    if (reply.ok) return null;
    if (reply.status === 401 || reply.status === 403) return `${check.service} did not accept that key.`;
    return `${check.service} could not check that key just now (${reply.status}).`;
  } catch {
    return `${check.service} could not be reached to check that key.`;
  }
}
