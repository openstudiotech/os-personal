// Google's three, built in. Each is a service like any other, under the key
// OpenStudio's pieces name it by, but its tools are run here against
// Google's own APIs and not by an MCP server somewhere else.
import { calendar } from "./calendar.ts";
import { drive } from "./drive.ts";
import { gmail } from "./gmail.ts";
import { check, Expired, google, type Http, type Provider, type Tool } from "./api.ts";

export const GOOGLE = "https://www.googleapis.com/";
export const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
export const TOKEN = "https://oauth2.googleapis.com/token";
const MAX_RESULT = 250 * 1024;

export const BUILT_IN: Record<string, { name: string; base: string; provider: Provider; scopes: string[] }> = {
  gmail_api: { name: "Gmail", base: "/gmail/v1/users/me", provider: gmail, scopes: ["https://www.googleapis.com/auth/gmail.modify"] },
  google_calendar: { name: "Google Calendar", base: "/calendar/v3", provider: calendar, scopes: [
    "https://www.googleapis.com/auth/calendar.events", "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
    "https://www.googleapis.com/auth/calendar.events.freebusy", "https://www.googleapis.com/auth/calendar.settings.readonly",
  ] },
  google_drive: { name: "Google Drive", base: "/drive/v3", provider: drive, scopes: ["https://www.googleapis.com/auth/drive"] },
};

export const builtIn = (service: { key: string; url: string }): boolean => service.url === GOOGLE && service.key in BUILT_IN;
export const builtInTools = (key: string): Tool[] => BUILT_IN[key].provider.tools;

// Run one tool. `token` gives the current token, or a renewed one when asked.
export async function callBuiltIn(http: Http, key: string, token: (renew: boolean) => Promise<string | null>, name: string, args: unknown): Promise<unknown> {
  const { base, provider } = BUILT_IN[key];
  const found = provider.tools.find((each) => each.name === name);
  if (!found) throw new Error(`Unknown tool: ${name}`);
  const given = check(found, (args ?? {}) as Record<string, any>);
  const run = async (renew: boolean) => provider.call(google(http, (await token(renew)) ?? "", base), name, given);
  const result = await run(false).catch((error) => { if (error instanceof Expired) return run(true); throw error; });
  if (JSON.stringify(result ?? null).length > MAX_RESULT) throw new Error("Google result too large; narrow your query");
  return result ?? {};
}
