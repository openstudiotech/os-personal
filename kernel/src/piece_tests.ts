// Tests inside a piece. A piece's methods are reducers and
// its effects are data, so a test is the kernel's own loop with two changes:
// the state comes from the test and is never saved, and an effect is answered
// from the test instead of being performed. Scenarios are data, like
// interface.js: there is no test code to run, and nowhere to put a mock.
//
// Pure on purpose (no Durable Object, no loader): PieceHost supplies `invoke`,
// and the unit tests supply plain classes.

export const TESTS_MODULE = "tests.js";
const MAX_SCENARIOS = 50;
const MAX_STEPS = 8; // the effect chain's own bound
const MODULES: Record<string, string> = { piece: "piece.js", tasks: "tasks.js" };

export interface Step {
  expect: { effect?: unknown; state?: unknown; result?: unknown };
  outcome?: unknown;
}

export interface Scenario {
  name: string;
  for?: string; // the acceptance point it covers, in the person's words
  module: string; // piece.js or tasks.js
  state: unknown;
  call: string;
  args: unknown[];
  steps: Step[];
}

export interface ScenarioResult {
  name: string;
  for?: string;
  passed: boolean;
  // Where it went wrong: the step (1-based), and what differed.
  failure?: { step: number; message: string };
}

export interface TestSummary {
  total: number;
  passed: number;
  failed: number;
  results: ScenarioResult[];
}

// Every method a run reached, as "module:method": the calls and the
// continuations they led to.
export type Reached = Set<string>;

// (module, method, state, args) -> what the reducer returned. Throws with a
// caller-facing message when the method is missing or raises.
export type Invoke = (module: string, method: string, state: unknown, args: unknown[]) => Promise<any>;

// What each effect answers with when it works (anything may answer {error}).
// A canned outcome without it is one the platform would never send, and a
// test passing on it proves nothing. Kinds not listed vary too much to check.
const OUTCOME_KEYS: Record<string, string> = {
  fetch: "status", search: "results", extract: "markdown", llm: "text",
  notify: "sent", call: "result", mcp: "result",
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const METHOD_NAME = /^[a-zA-Z]\w*$/;

// Throws with a caller-facing reason. The file is `export default [ ... ]`
// holding plain JSON, the rule interface.js already follows.
export function parseTests(source: string): Scenario[] {
  const body = source
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*export\s+default\s*/, "")
    .replace(/[\s;]+$/, "")
    .trim();
  if (!body.startsWith("[")) throw new Error(`${TESTS_MODULE} must be \`export default [ ... ]\``);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e: any) {
    throw new Error(
      `${TESTS_MODULE} must be plain JSON: quote every key and drop trailing commas (${String(e?.message ?? e)})`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error(`${TESTS_MODULE} must export a list of scenarios`);
  if (parsed.length > MAX_SCENARIOS) throw new Error(`${TESTS_MODULE}: at most ${MAX_SCENARIOS} scenarios`);

  return parsed.map((raw, index) => {
    const where = `${TESTS_MODULE}: scenario ${index + 1}`;
    if (!isObject(raw)) throw new Error(`${where} must be an object`);
    if (typeof raw.name !== "string" || !raw.name.trim()) throw new Error(`${where} needs a name`);
    const named = `${TESTS_MODULE}: "${raw.name}"`;
    if (typeof raw.call !== "string" || !METHOD_NAME.test(raw.call)) throw new Error(`${named} needs \`call\`, a method name`);
    const module = MODULES[typeof raw.module === "string" ? raw.module : "piece"];
    if (!module) throw new Error(`${named}: module must be "piece" or "tasks"`);
    if (raw.args !== undefined && !Array.isArray(raw.args)) throw new Error(`${named}: args must be a list`);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) throw new Error(`${named} needs at least one step`);
    if (raw.steps.length > MAX_STEPS) throw new Error(`${named}: at most ${MAX_STEPS} steps`);
    raw.steps.forEach((step, at) => {
      const expected = isObject(step) ? step.expect : null;
      // A step that checks nothing would pass whatever the piece did.
      if (!isObject(expected) || !["effect", "state", "result"].some((key) => key in expected)) {
        throw new Error(`${named}: step ${at + 1} needs \`expect\` with effect, state or result`);
      }
    });
    if ("outcome" in (raw.steps[raw.steps.length - 1] as object)) {
      throw new Error(`${named}: the last step has an outcome, which leads to a step nothing checks`);
    }
    return {
      name: raw.name, for: typeof raw.for === "string" ? raw.for : undefined, module,
      state: raw.state ?? null, call: raw.call, args: (raw.args as unknown[]) ?? [], steps: raw.steps as Step[],
    };
  });
}

// Subset match: only what the scenario names is checked, so a timestamp or a
// field it does not care about cannot break it. Returns null on a match, or
// where and how it differed.
//   null                 -> absent
//   { "includes": "x" }  -> a string containing x
//   [ ... ]              -> a list of the same length, matched item by item
//   { ... }              -> an object with at least these keys
export function mismatch(expected: unknown, actual: unknown, path = ""): string | null {
  const at = path || "value";
  const show = (value: unknown) => (value === undefined ? "nothing" : JSON.stringify(value)).slice(0, 200);
  if (expected === null) return actual == null ? null : `${at}: expected nothing, got ${show(actual)}`;
  if (isObject(expected) && typeof expected.includes === "string" && Object.keys(expected).length === 1) {
    return typeof actual === "string" && actual.includes(expected.includes)
      ? null : `${at}: expected text including ${show(expected.includes)}, got ${show(actual)}`;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${at}: expected a list, got ${show(actual)}`;
    if (actual.length !== expected.length) return `${at}: expected ${expected.length} items, got ${actual.length}`;
    for (let i = 0; i < expected.length; i++) {
      const found = mismatch(expected[i], actual[i], `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return `${at}: expected an object, got ${show(actual)}`;
    for (const key of Object.keys(expected)) {
      const found = mismatch(expected[key], actual[key], path ? `${path}.${key}` : key);
      if (found) return found;
    }
    return null;
  }
  return expected === actual ? null : `${at}: expected ${show(expected)}, got ${show(actual)}`;
}

// Why a canned outcome could not have come from the platform, or null.
export function outcomeProblem(effect: Record<string, unknown>, outcome: unknown): string | null {
  if (!isObject(outcome)) return "outcome must be an object";
  if (typeof outcome.error === "string") return null;
  const kind = Object.keys(OUTCOME_KEYS).find((key) => key in effect);
  if (!kind || OUTCOME_KEYS[kind] in outcome) return null;
  return `a ${kind} effect answers with { "${OUTCOME_KEYS[kind]}": ... } or { "error": "..." }`;
}

async function runScenario(scenario: Scenario, invoke: Invoke, reached: Reached): Promise<ScenarioResult> {
  const failed = (step: number, message: string): ScenarioResult =>
    ({ name: scenario.name, for: scenario.for, passed: false, failure: { step, message } });
  let state = scenario.state;
  let method = scenario.call;
  let args = scenario.args;

  for (let at = 0; at < scenario.steps.length; at++) {
    const step = scenario.steps[at];
    let returned: any;
    reached.add(`${scenario.module}:${method}`);
    try {
      returned = await invoke(scenario.module, method, state, args);
    } catch (e: any) {
      return failed(at + 1, `${method} failed: ${String(e?.message ?? e)}`);
    }
    const shaped = isObject(returned);
    if (shaped && "state" in returned) state = returned.state;
    const effect = shaped && isObject(returned.effect) ? returned.effect : null;
    const result = shaped && ("state" in returned || "result" in returned || "effect" in returned)
      ? returned.result ?? null : returned ?? null;

    const actual: Record<string, unknown> = { effect, state, result };
    for (const key of ["effect", "state", "result"] as const) {
      if (!(key in step.expect)) continue;
      const found = mismatch(step.expect[key], actual[key], key);
      if (found) return failed(at + 1, `after ${method}, ${found}`);
    }

    // Checked on the last step too: the platform refuses an effect that
    // names no continuation, whether or not the scenario follows it.
    if (effect && (typeof effect.then !== "string" || !METHOD_NAME.test(effect.then))) {
      return failed(at + 1, `${method} returned an effect with no \`then\`: the platform refuses it`);
    }
    if (at === scenario.steps.length - 1) break;
    if (!effect) return failed(at + 2, `${method} returned no effect, so there is no step ${at + 2}`);
    if (!("outcome" in step)) return failed(at + 1, `step ${at + 1} needs an outcome for the effect ${method} returned`);
    const problem = outcomeProblem(effect, step.outcome);
    if (problem) return failed(at + 1, `outcome is not one the platform sends: ${problem}`);
    method = effect.then as string;
    args = [step.outcome];
  }
  return { name: scenario.name, for: scenario.for, passed: true };
}

export async function runScenarios(scenarios: Scenario[], invoke: Invoke, reached: Reached = new Set()): Promise<TestSummary> {
  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) results.push(await runScenario(scenario, invoke, reached));
  const passed = results.filter((r) => r.passed).length;
  return { total: results.length, passed, failed: results.length - passed, results };
}

// Continuations a file names (`then: "onData"`) that it has no method for.
// The platform would call them and find nothing, with nobody watching. Needs
// no scenario: it reads the source.
export function danglingContinuations(source: string | undefined, methods: string[]): string[] {
  if (!source) return [];
  const named = [...source.matchAll(/\bthen\s*:\s*["'`]([a-zA-Z]\w*)["'`]/g)].map((m) => m[1]);
  return [...new Set(named)].filter((name) => !methods.includes(name));
}

// Methods no scenario reached, by call or as a continuation: what a person
// or a schedule can start, and nothing checks.
export function untested(reached: Reached, entries: { module: string; method: string }[]): string[] {
  return entries.filter((e) => !reached.has(`${e.module}:${e.method}`)).map((e) => e.method);
}
