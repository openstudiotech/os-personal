// The capnweb-facing API a connected client (browser iframe) gets. Role comes
// from the verified ticket; the PieceHost enforces it again on every invoke.
import { RpcTarget } from "capnweb";
import type { PieceHost } from "./cell_host";
import type { Ticket } from "./auth";

export class PieceSession extends RpcTarget {
  #host: PieceHost;
  #ticket: Ticket;

  constructor(host: PieceHost, ticket: Ticket) {
    super();
    this.#host = host;
    this.#ticket = ticket;
  }

  whoami() {
    return { user: this.#ticket.user, role: this.#ticket.role };
  }

  // What this piece can be asked to do, for the default console. Not a
  // permission boundary: every role may call every method anyway, so this
  // hides nothing that call() would refuse.
  describe() {
    return this.#host.describe(this.#ticket.preview === true);
  }

  call(method: string, args: unknown[] = []) {
    if (Date.now() > this.#ticket.exp) throw new Error("ticket expired");
    return this.#host.invoke(method, args, this.#ticket.role, this.#ticket.user, [], this.#ticket.preview === true);
  }

  // A person puts a file into the piece. Returns the ref the page hands to a
  // reducer, which is what makes the file part of the piece's state. Any role,
  // like call(): using a piece includes giving it things.
  upload(name: string, bytes: Uint8Array) {
    if (Date.now() > this.#ticket.exp) throw new Error("ticket expired");
    return this.#host.storeFile(name, bytes, { by: this.#ticket.user });
  }

  // Register a state-change callback; returns current state. The stub is
  // disposed when this call returns, so dup() to retain (Phase 0 finding).
  // Tagged with the ticket user so personal-mode broadcasts reach only the
  // slice owner's tabs.
  async subscribe(callback: (s: unknown) => unknown) {
    const retained = (callback as any).dup();
    this.#host.subscribers.add({ cb: retained, user: this.#ticket.user });
    return this.#host.currentState(this.#ticket.user);
  }
}
