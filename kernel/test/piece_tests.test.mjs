// Unit tests for the piece test runner (src/piece_tests.ts): no fleet needed.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseTests, runScenarios, mismatch, outcomeProblem, danglingContinuations, untested,
} from "../dist-test/piece_tests.js";

// A piece as the kernel sees it: reducers that return effects as data.
class Digest {
  morning(state) {
    return { state: { ...state, loading: true }, effect: { fetch: "https://news.example/front", then: "onFront" } };
  }
  onFront(state, outcome) {
    if (outcome.error) return { state: { ...state, loading: false, error: outcome.error } };
    const title = outcome.json.hits[0].title;
    return { state: { ...state, pending: title }, effect: { llm: { prompt: `Judge: ${title}` }, then: "onJudged" } };
  }
  onJudged(state, outcome) {
    const next = { ...state, loading: false, at: Date.now() };
    if (!outcome.text.includes("Y")) return { state: next };
    return { state: next, effect: { notify: { text: `Read: ${state.pending}` }, then: "onSent" } };
  }
  onSent(state) { return { state }; }
  add(state, n) { return { state: { count: (state?.count ?? 0) + n }, result: (state?.count ?? 0) + n }; }
  shout(state) { return { effect: { notify: { text: "hi" } } }; }
}
const piece = new Digest();
const invoke = async (_module, method, state, args) => {
  if (typeof piece[method] !== "function") throw new Error(`no method "${method}"`);
  return piece[method](state, ...args);
};
const run = async (scenario) => (await runScenarios(parseTests(`export default ${JSON.stringify([scenario])};`), invoke)).results[0];

const happy = {
  name: "the digest messages them about a story that matches",
  for: "Messages them each morning",
  state: { criteria: "databases" },
  call: "morning",
  steps: [
    { expect: { effect: { fetch: "https://news.example/front", then: "onFront" }, state: { loading: true } },
      outcome: { status: 200, json: { hits: [{ title: "Postgres 19" }] } } },
    { expect: { effect: { llm: { prompt: { includes: "Postgres 19" } }, then: "onJudged" } },
      outcome: { text: "1 | Y" } },
    { expect: { effect: { notify: { text: { includes: "Postgres 19" } } }, state: { loading: false } } },
  ],
};

test("a scenario follows the chain, feeding each canned outcome to the continuation", async () => {
  assert.deepEqual(await run(happy), { name: happy.name, for: "Messages them each morning", passed: true });
});

test("only what a scenario names is checked: the timestamp in state does not break it", async () => {
  const result = await run(happy);
  assert.equal(result.passed, true); // onJudged sets `at: Date.now()`, never named
});

test("a failure says which step and what differed", async () => {
  const wrong = structuredClone(happy);
  wrong.steps[1].expect.effect.then = "onVerdict";
  const result = await run(wrong);
  assert.equal(result.passed, false);
  assert.equal(result.failure.step, 2);
  assert.match(result.failure.message, /after onFront, effect\.then: expected "onVerdict", got "onJudged"/);
});

test("an error outcome takes the failure path, and null expects no effect", async () => {
  const result = await run({
    name: "a failed fetch is kept and nobody is messaged", call: "morning",
    steps: [
      { expect: { effect: { then: "onFront" } }, outcome: { error: "timed out" } },
      { expect: { effect: null, state: { loading: false, error: "timed out" } } },
    ],
  });
  assert.equal(result.passed, true);
});

test("a call with arguments and a result", async () => {
  const result = await run({ name: "adding", state: { count: 2 }, call: "add", args: [3],
    steps: [{ expect: { result: 5, state: { count: 5 } } }] });
  assert.equal(result.passed, true);
});

test("an outcome the platform would never send fails the scenario", async () => {
  const invented = structuredClone(happy);
  invented.steps[0].outcome = { ok: true, body: "<html>" };
  const result = await run(invented);
  assert.match(result.failure.message, /a fetch effect answers with \{ "status": \.\.\. \}/);
});

test("an effect with no continuation fails, even on the last step", async () => {
  const result = await run({ name: "shout", call: "shout", steps: [{ expect: { effect: { notify: { text: "hi" } } } }] });
  assert.match(result.failure.message, /no `then`: the platform refuses it/);
});

test("a chain that ends early, a missing outcome and a missing method all fail plainly", async () => {
  const early = await run({ name: "early", state: { count: 0 }, call: "add", args: [1],
    steps: [{ expect: { result: 1 }, outcome: { status: 200 } }, { expect: { effect: null } }] });
  assert.match(early.failure.message, /returned no effect, so there is no step 2/);

  const silent = structuredClone(happy);
  delete silent.steps[0].outcome;
  assert.match((await run(silent)).failure.message, /step 1 needs an outcome/);

  const missing = await run({ name: "missing", call: "nope", steps: [{ expect: { effect: null } }] });
  assert.match(missing.failure.message, /nope failed: no method "nope"/);
});

test("the summary counts", async () => {
  const broken = { ...structuredClone(happy), name: "broken" };
  broken.steps[2].expect.state.loading = true;
  const summary = await runScenarios(parseTests(`export default ${JSON.stringify([happy, broken])};`), invoke);
  assert.deepEqual([summary.total, summary.passed, summary.failed], [2, 1, 1]);
});

test("the file is plain JSON, and a scenario must check something", () => {
  assert.throws(() => parseTests("export default [{ name: 'x' }];"), /must be plain JSON/);
  assert.throws(() => parseTests("export default {};"), /export default \[/);
  assert.throws(() => parseTests('export default [{"name":"x","call":"a","steps":[{"expect":{}}]}];'),
    /step 1 needs `expect` with effect, state or result/);
  assert.throws(() => parseTests('export default [{"name":"x","call":"a","steps":[{"expect":{"result":1},"outcome":{}}]}];'),
    /last step has an outcome/);
  assert.throws(() => parseTests('export default [{"name":"x","call":"a","module":"client","steps":[{"expect":{"result":1}}]}];'),
    /module must be "piece" or "tasks"/);
  const parsed = parseTests('// header\nexport default [{"name":"x","call":"a","module":"tasks","steps":[{"expect":{"result":1}}]}];\n');
  assert.equal(parsed[0].module, "tasks.js");
});

test("matching: subset objects, exact lists, includes, and nothing", () => {
  assert.equal(mismatch({ a: 1 }, { a: 1, b: 2 }), null);
  assert.match(mismatch({ a: { b: 2 } }, { a: { b: 3 } }), /a\.b: expected 2, got 3/);
  assert.equal(mismatch(["x"], ["x"]), null);
  assert.match(mismatch(["x"], ["x", "y"]), /expected 1 items, got 2/);
  assert.equal(mismatch({ includes: "gres" }, "Postgres"), null);
  assert.equal(mismatch(null, undefined), null);
  assert.match(mismatch(null, { fetch: "x" }), /expected nothing/);
});

test("outcome shapes per effect kind", () => {
  assert.equal(outcomeProblem({ llm: { prompt: "x" } }, { text: "y" }), null);
  assert.equal(outcomeProblem({ llm: { prompt: "x" } }, { error: "down" }), null);
  assert.match(outcomeProblem({ notify: { text: "x" } }, { ok: true }), /"sent"/);
  assert.equal(outcomeProblem({ browser: {} }, { anything: 1 }), null);
});

test("continuations a file names without having, and entry points nothing calls", () => {
  const source = 'a(s) { return { effect: { fetch: "u", then: "onData" } }; }\n b(s) { return { effect: { llm: {}, then: \'onGone\' } }; }';
  assert.deepEqual(danglingContinuations(source, ["a", "b", "onData"]), ["onGone"]);
});

test("a method reached as a continuation counts as tested; one nothing reaches does not", async () => {
  const reached = new Set();
  await runScenarios(parseTests(`export default ${JSON.stringify([happy])};`), invoke, reached);
  const entries = ["morning", "onFront", "onJudged", "add"].map((method) => ({ module: "piece.js", method }));
  assert.deepEqual(untested(reached, [...entries, { module: "tasks.js", method: "morning" }]), ["add", "morning"]);
});
