/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const ts = require("typescript");

require.extensions[".ts"] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, filename);
};
const { buildWanRequest, WAN_DEFAULTS } = require(path.join(__dirname, "..", "src", "lib", "wan.ts"));
const { selectWanIncoming } = require(path.join(__dirname, "..", "src", "lib", "wan-connections.ts"));

const image = "data:image/png;base64,aGVsbG8=";
const inspectedImage = {
  local: true, dataUrl: image, type: "image/png", size: 5,
  width: 1024, height: 1024, hasAlpha: false,
};
const node = { params: { ...WAN_DEFAULTS, task: "image-to-video" } };

test("Wan accepts a generated local image as both inspected frames", () => {
  for (const value of [image, inspectedImage]) {
    const request = buildWanRequest(node, { prompt: "Animate the image", image: value, last_image: value });
    assert.deepEqual(request.errors, []);
    assert.equal(request.body.image, "[local file uploaded during generation]");
    assert.equal(request.body.last_image, "[local file uploaded during generation]");
    assert.equal(JSON.stringify(request.body).includes(image), false);
  }
});

test("Wan accepts inspected local reference images and rejects invalid metadata", () => {
  const referenceNode = { params: { ...WAN_DEFAULTS, task: "reference-to-video" } };
  const reference = buildWanRequest(referenceNode, {
    prompt: "Animate the image",
    references: [{ type: "image", value: inspectedImage }],
  });
  assert.deepEqual(reference.errors, []);
  assert.deepEqual(reference.body.refers, [{ type: "image", url: "[local file uploaded during generation]" }]);

  const invalid = buildWanRequest(node, {
    prompt: "Animate the image",
    image: { ...inspectedImage, hasAlpha: true },
  });
  assert.ok(invalid.errors.some((error) => error.includes("transparency")));
});

test("Wan still requires a prompt and a valid first frame", () => {
  const request = buildWanRequest(node, { prompt: "", image: "http://localhost/image.png" });
  assert.ok(request.errors.some((error) => error.includes("Prompt")));
  assert.ok(request.errors.some((error) => error.includes("private URLs")));
});

test("manual frame connections take precedence over auto-created inputs in either order", () => {
  const nodes = [
    { id: "automatic", data: { type: "input/image", autoCreatedFor: "wan" } },
    { id: "generated", data: { type: "google/gemini-image", outputs: { image } } },
  ];
  const automatic = { source: "automatic", target: "wan", targetHandle: "image" };
  const generated = { source: "generated", target: "wan", targetHandle: "image" };
  for (const edges of [[automatic, generated], [generated, automatic]]) {
    const selected = selectWanIncoming(edges, nodes, "wan").get("image");
    assert.equal(selected, generated);
    const source = nodes.find((candidate) => candidate.id === selected.source);
    assert.deepEqual(buildWanRequest(node, {
      prompt: "Animate the image", image: source.data.outputs.image, last_image: source.data.outputs.image,
    }).errors, []);
  }
  assert.equal(selectWanIncoming([automatic], nodes, "wan").get("image"), automatic);
});
