import { randomUUID } from "node:crypto";
import { clamp, compact, part, pick, Refused, STRING, STRINGS, tool, type Args, type Ask, type Provider } from "./api.ts";

const EVENT_FIELDS = ["id", "summary", "description", "start", "end", "status", "attendees", "location", "hangoutLink", "htmlLink", "recurrence", "organizer"];
const CALENDAR_ID = { type: "string", default: "primary" };
const EVENT = {
  calendar_id: CALENDAR_ID, summary: STRING,
  start: { type: "string", description: "RFC3339 start time" }, end: { type: "string", description: "RFC3339 end time" },
  description: STRING, location: STRING, attendees: STRINGS, recurrence: STRINGS,
  add_meet: { type: "boolean" }, send_updates: { type: "string", enum: ["all", "none"], default: "none" },
};
const LISTS = { calendar_id: CALENDAR_ID, time_min: STRING, time_max: STRING };

const events = (id: string, event?: string) => `calendars/${part(id)}/events${event ? `/${part(event)}` : ""}`;

function shape(event: any): Record<string, any> {
  const shaped = pick(event, EVENT_FIELDS);
  if (event.attendees) shaped.attendees = event.attendees.map((each: any) => pick(each, ["email", "displayName", "responseStatus", "self", "optional"]));
  return shaped;
}

function body(args: Args): Record<string, any> {
  return {
    ...compact({
      summary: args.summary, description: args.description, location: args.location, recurrence: args.recurrence,
      start: args.start ? { dateTime: args.start } : null, end: args.end ? { dateTime: args.end } : null,
      attendees: args.attendees?.map((email: string) => ({ email })),
    }),
    ...(args.add_meet ? { conferenceData: { createRequest: { requestId: randomUUID(), conferenceSolutionKey: { type: "hangoutsMeet" } } } } : {}),
  };
}

async function list(ask: Ask, args: Args, query?: string) {
  const limit = clamp(args.max_results ?? 25, 1, 50);
  const data = await ask("GET", events(args.calendar_id), { query: { singleEvents: true, orderBy: "startTime", timeMin: args.time_min, timeMax: args.time_max, maxResults: limit, q: query } });
  return compact({ events: (data.items ?? []).slice(0, limit).map(shape), next_page_token: data.nextPageToken });
}

export const calendar: Provider = {
  tools: [
    tool("list_calendars", "List up to 50 calendars.", {}, [], true),
    tool("list_events", "List expanded events in start-time order.", { ...LISTS, max_results: { type: "integer", default: 25 } }, [], true),
    tool("search_events", "Search events by text.", { ...LISTS, query: STRING }, ["query"], true),
    tool("get_event", "Read one event or recurring instance by ID.", { calendar_id: CALENDAR_ID, event_id: STRING }, ["event_id"], true),
    tool("create_event", "Create an event, optionally with Google Meet.", EVENT, ["summary", "start", "end"], false),
    tool("update_event", "Patch only supplied event fields; use an instance ID to edit one occurrence.", { ...EVENT, event_id: STRING }, ["event_id"], false),
    tool("delete_event", "Delete an event or recurring instance.", { calendar_id: CALENDAR_ID, send_updates: EVENT.send_updates, event_id: STRING }, ["event_id"], false, true),
    tool("get_freebusy", "Read busy intervals and per-calendar errors.", { time_min: STRING, time_max: STRING, calendar_ids: { ...STRINGS, maxItems: 50, default: ["primary"] } }, ["time_min", "time_max"], true),
    tool("respond_to_event", "Respond as the connected attendee.", { calendar_id: CALENDAR_ID, event_id: STRING, response: { type: "string", enum: ["accepted", "declined", "tentative"] } }, ["event_id", "response"], false),
    tool("get_current_time", "Current time in the connected account's timezone.", {}, [], true),
  ],

  async call(ask, name, args) {
    const sending = { sendUpdates: args.send_updates, conferenceDataVersion: args.add_meet ? 1 : null };
    switch (name) {
      case "list_calendars": {
        const data = await ask("GET", "users/me/calendarList", { query: { maxResults: 50 } });
        return compact({ calendars: (data.items ?? []).slice(0, 50).map((each: any) => pick(each, ["id", "summary", "timeZone", "primary", "accessRole"])), next_page_token: data.nextPageToken });
      }
      case "list_events": return list(ask, args);
      case "search_events": return list(ask, { ...args, max_results: 25 }, args.query);
      case "get_event": return shape(await ask("GET", events(args.calendar_id, args.event_id)));
      case "create_event": return shape(await ask("POST", events(args.calendar_id), { query: sending, body: body(args) }));
      case "update_event": return shape(await ask("PATCH", events(args.calendar_id, args.event_id), { query: sending, body: body(args) }));
      case "delete_event": return ask("DELETE", events(args.calendar_id, args.event_id), { query: { sendUpdates: args.send_updates } });
      case "get_freebusy":
        return pick(await ask("POST", "freeBusy", { body: { timeMin: args.time_min, timeMax: args.time_max, items: args.calendar_ids.map((id: string) => ({ id })) } }), ["timeMin", "timeMax", "calendars", "groups"]);
      case "respond_to_event": {
        const event = await ask("GET", events(args.calendar_id, args.event_id));
        const me = (event.attendees ?? []).find((each: any) => each.self);
        if (!me) throw new Refused("Connected account is not an attendee");
        return shape(await ask("PATCH", events(args.calendar_id, args.event_id), { body: { attendeesOmitted: true, attendees: [{ email: me.email, responseStatus: args.response }] } }));
      }
      default: {
        const timezone = String((await ask("GET", "users/me/settings/timezone")).value);
        const now = new Date();
        const offset = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" }).formatToParts(now).find((each) => each.type === "timeZoneName")!.value.replace("GMT", "") || "+00:00";
        const local = new Intl.DateTimeFormat("sv-SE", { timeZone: timezone, dateStyle: "short", timeStyle: "medium" }).format(now).replace(" ", "T");
        return { current_time: `${local}${offset}`, timezone };
      }
    }
  },
};
