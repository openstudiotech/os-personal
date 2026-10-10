// Blessed piece template (v1 reducer contract).
//
// Rules the kernel enforces:
// - default export must be `class extends Piece` (from ./costa.js, injected
//   by the platform)
// - each method receives the persisted state as its first argument and returns
//   { state, result } to update state (broadcast to all viewers) or
//   { result } to read without writing
// - every role may call any method; sharing as viewer means "can use the
//   app, cannot see or modify what's underneath"
// - no network access: fetch() will throw. Talk to the outside world only
//   through effects mediated by the platform.
import { Piece } from "./costa.js";

export default class extends Piece {
  viewState(state) {
    return { result: state ?? {} };
  }

  setGreeting(state, name) {
    const greeting = `Hello, ${name}!`;
    return { state: { ...state, greeting }, result: greeting };
  }
}
