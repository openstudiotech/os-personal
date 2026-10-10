// Puts the app on a port. The app speaks Request and Response; this is the
// little that Node's own server needs between.
import { createServer, type Server } from "node:http";

export function listen(app: (request: Request) => Promise<Response>, port: number, host: string): Promise<Server> {
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = [];
    for await (const chunk of incoming) chunks.push(chunk as Buffer);
    const hasBody = incoming.method !== "GET" && incoming.method !== "HEAD";
    // One request going wrong is that request's problem. It does not take
    // the app down with it.
    const reply = await app(new Request(`http://${incoming.headers.host ?? host}${incoming.url}`, {
      method: incoming.method,
      headers: incoming.headers as Record<string, string>,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    })).catch((error) => {
      console.error(error);
      return new Response("Something went wrong here. Go back and try again.", { status: 500 });
    });
    outgoing.writeHead(reply.status, Object.fromEntries(reply.headers));
    outgoing.end(Buffer.from(await reply.arrayBuffer()));
  });
  return new Promise((resolve, reject) => server.once("error", reject).listen(port, host, () => resolve(server)));
}
