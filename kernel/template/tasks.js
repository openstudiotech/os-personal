// Optional companion to piece.js: the work that runs on a schedule.
//
// Anything a schedule can trigger lives here, and only here. That is
// deliberate — "what does this cell do when nobody is watching?" should be
// answerable by opening one file, not by reading every reducer looking for
// one that a timer happens to point at.
//
// Same contract as piece.js: default export `class extends Piece`, each method
// takes the persisted state first and returns { state, result } to write or
// { result } to read. Effects work exactly as they do interactively, and a
// `then:` continuation resolves against THIS file.
//
// Two things differ from an interactive call:
// - There is no viewer. The tick runs as the cell's owner, so it can only
//   reach what the owner could reach.
// - Nothing is waiting for the return value. Write what matters into state,
//   or send it somewhere (Slack, email) with an effect.
//
// Timing is not set here. A person configures it on the cell's connections
// tab, where they can also see the last runs and any failures.
import { Piece } from "./costa.js";

export default class extends Piece {
  // A task takes no arguments beyond state.
  refresh(state) {
    return { state: { ...state, lastRunAt: Date.now() } };
  }

  // Tasks can use effects. The continuation is a method on this class.
  checkStatus(state) {
    return {
      effect: { fetch: "https://example.com/status.json", then: "onStatus" },
    };
  }

  onStatus(state, outcome) {
    // Denials and failures arrive as { error }, never as an exception.
    if (outcome.error) return { state: { ...state, lastError: outcome.error } };
    return { state: { ...state, status: outcome.json, checkedAt: Date.now() } };
  }
}
