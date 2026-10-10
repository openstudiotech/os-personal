// Services ready to connect, under the keys OpenStudio's pieces name them by.
// `signin` sends the person to the service to sign in; `token` asks for a
// key made on the service's own site.
export interface Entry { key: string; name: string; url: string; auth: "signin" | "token"; token?: string; header?: string }

export const CATALOG: Entry[] = [
  { key: "linear", name: "Linear", url: "https://mcp.linear.app/mcp", auth: "signin" },
  { key: "attio", name: "Attio", url: "https://mcp.attio.com/mcp", auth: "signin" },
  { key: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", auth: "token", token: "Personal access token" },
  { key: "google_maps", name: "Google Maps", url: "https://mapstools.googleapis.com/mcp", auth: "token", token: "API key", header: "X-Goog-Api-Key" },
];
