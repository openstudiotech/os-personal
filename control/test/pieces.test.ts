import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store.ts";
import { loadPiece } from "../src/pieces.ts";
import { readZip } from "../src/zip.ts";
import { COUNTER, fakeKernel, makeZip, manifest } from "./support.ts";

test("a zip is read whether its files are stored or deflated", () => {
  for (const deflate of [false, true]) {
    const files = readZip(makeZip({ "a.txt": "alpha", "dir/b.txt": "beta ".repeat(200) }, { deflate }));
    assert.equal(files.get("a.txt")?.toString(), "alpha");
    assert.equal(files.get("dir/b.txt")?.toString(), "beta ".repeat(200));
  }
});

test("something that is not a zip is refused plainly", () => {
  assert.throws(() => readZip(Buffer.from("not a zip at all")), /not a zip/);
});

test("a downloaded piece is deployed, and remembered with what it asks for", async () => {
  const store = new Store(":memory:"), kernel = fakeKernel();
  const zip = makeZip({
    "manifest.yml": manifest({ connections: [{ kind: "web", config: { patterns: ["https://example.com/*"] } }] }),
    "files/piece.js": COUNTER,
    "files/client.js": "// page",
  });

  const piece = await loadPiece(zip, { store, kernel });

  const deploy = kernel.calls.find((call) => call.route === "files");
  assert.deepEqual(Object.keys(deploy!.body.files).sort(), ["client.js", "piece.js"]);
  assert.equal(deploy!.piece, piece.id);
  assert.match(piece.id, /^p[0-9a-f]{16}$/);
  assert.equal(store.piece(piece.id)?.name, "Counter");
  assert.deepEqual(store.piece(piece.id)?.wants, [{ kind: "web", config: { patterns: ["https://example.com/*"] } }]);
});

test("a zip wrapped in one folder loads the same", async () => {
  const store = new Store(":memory:"), kernel = fakeKernel();
  const zip = makeZip({ "counter-main/manifest.yml": manifest(), "counter-main/files/piece.js": COUNTER, "counter-main/README.md": "hello" });

  await loadPiece(zip, { store, kernel });

  assert.deepEqual(Object.keys(kernel.calls.find((call) => call.route === "files")!.body.files), ["piece.js"]);
});

test("pictures go to the kernel as base64, and a connection is named by its key", async () => {
  const store = new Store(":memory:"), kernel = fakeKernel();
  const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0x00]);
  const zip = makeZip({
    "manifest.yml": manifest(),
    "files/piece.js": COUNTER + `\n// reaches "{{mcp:google_calendar}}"`,
    "files/logo.png": png,
  });

  await loadPiece(zip, { store, kernel });

  const files = kernel.calls.find((call) => call.route === "files")!.body.files;
  assert.equal(files["logo.png"], Buffer.from(png).toString("base64"));
  assert.match(files["piece.js"], /reaches "google_calendar"/);
});

test("data in the zip is put back: state, and stored files", async () => {
  const store = new Store(":memory:"), kernel = fakeKernel();
  const id = "0123456789abcdef0123456789abcdef";
  const zip = makeZip({
    "manifest.yml": manifest({ data: true }),
    "files/piece.js": COUNTER,
    "data/state.json": JSON.stringify({ count: 7 }),
    "data/files.json": JSON.stringify([{ id, name: "report.pdf", source: "https://example.com/r.pdf" }]),
    [`data/files/${id}`]: "PDFBYTES",
  });

  await loadPiece(zip, { store, kernel });

  assert.deepEqual(kernel.calls.find((call) => call.method === "PUT" && call.route === "state")!.body, { state: { count: 7 } });
  const stored = kernel.calls.find((call) => call.route === "stored-files")!.body;
  assert.equal(stored.name, "report.pdf");
  assert.equal(stored.base64, Buffer.from("PDFBYTES").toString("base64"));
});

test("what is not a piece is refused, and nothing is kept", async () => {
  const cases: Array<[Record<string, string>, RegExp]> = [
    [{ "files/piece.js": COUNTER }, /no manifest\.yml/],
    [{ "manifest.yml": manifest({ format: 9 }), "files/piece.js": COUNTER }, /format/],
    [{ "manifest.yml": manifest({ name: "" }), "files/piece.js": COUNTER }, /no name/],
    [{ "manifest.yml": manifest(), "files/tasks.js": "x" }, /no piece\.js/],
    [{ "manifest.yml": "- just\n- a list\n", "files/piece.js": COUNTER }, /manifest/],
  ];
  for (const [entries, message] of cases) {
    const store = new Store(":memory:"), kernel = fakeKernel();
    await assert.rejects(loadPiece(makeZip(entries), { store, kernel }), message);
    assert.equal(store.pieces().length, 0);
    assert.equal(kernel.calls.length, 0);
  }
});

test("a piece the kernel will not take is not kept", async () => {
  const store = new Store(":memory:");
  const kernel = fakeKernel({ "PUT files": { status: 422, body: { error: "piece.js must export a class that extends Piece" } } });

  await assert.rejects(loadPiece(makeZip({ "manifest.yml": manifest(), "files/piece.js": "nope" }), { store, kernel }), /extends Piece/);
  assert.equal(store.pieces().length, 0);
});
