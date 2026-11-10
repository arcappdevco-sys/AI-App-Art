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
const { trackPatch, interpolateTrack, reachesCompositorNode, zoomViewerAt, compositorMediaSource, compositorBypassInput, compositorRange, nextCompositorTime, COMPOSITOR_INPUTS } = require(path.join(__dirname, "..", "src", "lib", "compositor.ts"));
const { applyColorCorrection, curveTable, getCurve } = require(path.join(__dirname, "..", "src", "lib", "compositor-color.ts"));
const { COMPOSITOR_NODE_OPTIONS, COMPOSITOR_TEMPLATES, createCompositorNode, createCompositorTemplate } = require(path.join(__dirname, "..", "src", "lib", "compositor-templates.ts"));
const { applyCompositorKeyer } = require(path.join(__dirname, "..", "src", "lib", "compositor-keyer.ts"));
const { CompositorHistory, compositorHistoryShortcut } = require(path.join(__dirname, "..", "src", "lib", "compositor-history.ts"));

test("timeline ranges default, clamp and recover from an unusable range", () => {
  const empty = { inPoint: null, outPoint: null };
  assert.deepEqual(compositorRange(empty, 10), { start: 0, end: 10 });
  assert.deepEqual(compositorRange({ inPoint: 2, outPoint: 8 }, 10), { start: 2, end: 8 });
  assert.deepEqual(compositorRange({ inPoint: 2, outPoint: 8 }, 5), { start: 2, end: 5 });
  assert.deepEqual(compositorRange({ inPoint: 8, outPoint: 9 }, 5), { start: 0, end: 5 });
  assert.deepEqual(compositorRange({ inPoint: 8, outPoint: 9 }, 10), { start: 8, end: 9 });
  assert.deepEqual(compositorRange({ inPoint: -1, outPoint: Infinity }, 5), { start: 0, end: 5 });
  assert.deepEqual(compositorRange(empty, 0), { start: 0, end: 0 });
});

test("timeline playback restarts at In at and beyond the Out boundary", () => {
  assert.equal(nextCompositorTime(0, 2, 4), 2);
  assert.equal(nextCompositorTime(4, 2, 4), 2);
  assert.equal(nextCompositorTime(3.9, 2, 4), 2);
  assert.equal(nextCompositorTime(2, 2, 4), 2.1);
});

test("disabled node bypass uses image inputs or the Merge background", () => {
  for (const kind of ["transform", "key", "mask", "color"]) assert.equal(compositorBypassInput(kind), "image");
  assert.equal(compositorBypassInput("merge"), "background");
  for (const kind of ["media", "viewer", "tracker"]) assert.equal(compositorBypassInput(kind), null);
});

test("media source modes retain legacy file defaults and support transparent backgrounds", () => {
  assert.equal(compositorMediaSource({}), "file");
  assert.equal(compositorMediaSource({ sourceMode: "file" }), "file");
  assert.equal(compositorMediaSource({ sourceMode: "solid" }), "solid");
  assert.equal(compositorMediaSource({ sourceMode: "transparent" }), "transparent");
});

test("compositor undo shortcuts respect modifiers, composition and ordinary text editing", () => {
  const event = { key: "z", ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false, isComposing: false };
  assert.equal(compositorHistoryShortcut(event, false), "undo");
  assert.equal(compositorHistoryShortcut({ ...event, key: "Z", shiftKey: true }, false), "redo");
  assert.equal(compositorHistoryShortcut({ ...event, key: "y" }, false), "redo");
  assert.equal(compositorHistoryShortcut({ ...event, ctrlKey: false, metaKey: true }, false), "undo");
  assert.equal(compositorHistoryShortcut(event, true), null);
  for (const change of [{ altKey: true }, { defaultPrevented: true }, { isComposing: true }, { ctrlKey: false }, { key: "x" }]) {
    assert.equal(compositorHistoryShortcut({ ...event, ...change }, false), null);
  }
});

test("compositor history restores in order, bounds entries and clears redo after a new edit", () => {
  const history = new CompositorHistory(2);
  assert.equal(history.canUndo, false);
  history.record("a"); history.record("b"); history.record("c");
  assert.equal(history.peek("undo"), "c");
  history.complete("undo", "d");
  assert.equal(history.peek("undo"), "b");
  history.complete("undo", "c");
  assert.equal(history.canUndo, false);
  assert.equal(history.peek("redo"), "c");
  history.complete("redo", "b");
  assert.equal(history.peek("undo"), "b");
  history.record("replacement");
  assert.equal(history.canRedo, false);
  assert.throws(() => history.complete("redo", "current"), /history is empty/);
});

test("keyer neutral controls exactly preserve legacy output", () => {
  const pixels = new Uint8ClampedArray(4 * 500);
  for (let i = 0; i < pixels.length; i++) pixels[i] = (i * 73 + Math.floor(i / 7) * 31) % 256;
  for (const params of [{}, { color: "#123456", tolerance: 61, softness: 117 }]) {
    const expected = pixels.slice(), actual = pixels.slice();
    const color = params.color ?? "#00ff00";
    const rgb = [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
    for (let i = 0; i < expected.length; i += 4) {
      const distance = Math.hypot(expected[i] - rgb[0], expected[i + 1] - rgb[1], expected[i + 2] - rgb[2]);
      expected[i + 3] *= Math.max(0, Math.min(1, (distance - (params.tolerance ?? 100)) / (params.softness ?? 35)));
    }
    applyCompositorKeyer(actual, 500, 1, params);
    assert.deepEqual(actual, expected);
  }
});

test("keyer clip, refinement and spill preserve input transparency", () => {
  const pixels = new Uint8ClampedArray([255, 0, 0, 0, 255, 0, 0, 64, 0, 255, 0, 255]);
  applyCompositorKeyer(pixels, 3, 1, { edgeChoke: -1, edgeFeather: 1, clipWhite: 50, spillSuppression: 100 });
  assert.equal(pixels[3], 0);
  assert.ok(pixels[7] <= 64);
  const edge = new Uint8ClampedArray([80, 200, 80, 255]);
  const original = edge.slice();
  applyCompositorKeyer(edge, 1, 1, { tolerance: 100, softness: 100, spillSuppression: 100 });
  assert.ok(edge[1] < original[1]);
  assert.ok(edge[3] > 0 && edge[3] < 255);
  assert.throws(() => applyCompositorKeyer(edge, 1, 1, { clipBlack: 80, clipWhite: 30 }), /Clip white/);
});

test("keyer clipping, choke, expansion and feather change the matte", () => {
  const partial = new Uint8ClampedArray([0, 155, 0, 255]);
  applyCompositorKeyer(partial, 1, 1, { tolerance: 0, softness: 200, clipBlack: 60 });
  assert.equal(partial[3], 0);
  const stripe = new Uint8ClampedArray([0, 255, 0, 255, 255, 0, 0, 255, 0, 255, 0, 255]);
  const eroded = stripe.slice(), expanded = stripe.slice(), feathered = stripe.slice();
  applyCompositorKeyer(eroded, 3, 1, { edgeChoke: 1 });
  applyCompositorKeyer(expanded, 3, 1, { edgeChoke: -1 });
  applyCompositorKeyer(feathered, 3, 1, { edgeFeather: 1 });
  assert.deepEqual([eroded[3], eroded[7], eroded[11]], [0, 0, 0]);
  assert.deepEqual([expanded[3], expanded[7], expanded[11]], [255, 255, 255]);
  assert.ok(feathered[3] > 0 && feathered[7] < 255);
});

test("viewer zoom stays anchored to the pointer and respects limits", () => {
  const view = { zoom: 1, x: 0, y: 0 };
  const zoomed = zoomViewerAt(view, 2, 100, -50);
  assert.deepEqual(zoomed, { zoom: 2, x: -100, y: 50 });
  assert.deepEqual(zoomViewerAt(zoomed, 0.5, 100, -50), view);
  assert.equal(zoomViewerAt(view, 100, 0, 0).zoom, 8);
  assert.equal(zoomViewerAt(view, 0.001, 0, 0).zoom, 0.25);
});

test("add-node options cover every template node, including named media inputs", () => {
  const options = new Set(COMPOSITOR_NODE_OPTIONS.map(({ kind, label }) => `${kind}:${label}`));
  assert.equal(options.size, COMPOSITOR_NODE_OPTIONS.length);
  for (const kind of Object.keys(COMPOSITOR_INPUTS)) assert.ok(COMPOSITOR_NODE_OPTIONS.some((item) => item.kind === kind));
  for (const label of ["Background", "Foreground", "Background video", "Overlay image"]) {
    assert.ok(options.has(`media:${label}`));
    const node = createCompositorNode({ kind: "media", label }, "test", { x: 1, y: 2 });
    assert.equal(node.data.kind, "media");
    assert.equal(node.data.label, label);
    assert.equal(compositorMediaSource(node.data.params), "file");
    assert.deepEqual(COMPOSITOR_INPUTS[node.data.kind], []);
  }
  let id = 0;
  for (const template of COMPOSITOR_TEMPLATES) {
    for (const node of createCompositorTemplate(template.id, () => `${++id}`).nodes) {
      assert.ok(options.has(`${node.data.kind}:${node.data.label}`), `${template.id}: ${node.data.label}`);
    }
  }
  const a = createCompositorNode({ kind: "media", label: "Background" }, "a", { x: 0, y: 0 });
  const b = createCompositorNode({ kind: "media", label: "Background" }, "b", { x: 0, y: 0 });
  a.data.params.sourceMode = "transparent";
  assert.equal(b.data.params.sourceMode, undefined);
});

test("templates create connected, typed, independent node graphs", () => {
  assert.deepEqual(COMPOSITOR_TEMPLATES.map((item) => item.id), ["color", "key", "mask", "tracking"]);
  let sequence = 0;
  for (const template of COMPOSITOR_TEMPLATES) {
    const graph = createCompositorTemplate(template.id, () => `id-${++sequence}`);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    assert.equal(nodes.size, graph.nodes.length);
    assert.equal(graph.nodes.filter((node) => node.data.kind === "viewer").length, 1);
    const ports = new Set();
    for (const edge of graph.edges) {
      const source = nodes.get(edge.source), target = nodes.get(edge.target);
      assert.ok(source && target);
      assert.equal(edge.sourceHandle, "output");
      assert.ok(COMPOSITOR_INPUTS[target.data.kind].includes(edge.targetHandle));
      assert.equal(source.data.kind === "tracker", edge.targetHandle === "motion");
      const port = `${edge.target}:${edge.targetHandle}`;
      assert.ok(!ports.has(port)); ports.add(port);
      assert.equal(reachesCompositorNode(graph.edges, edge.target, edge.source), false);
    }
    for (const node of graph.nodes) {
      for (const input of COMPOSITOR_INPUTS[node.data.kind].filter((input) => input !== "motion")) {
        assert.ok(ports.has(`${node.id}:${input}`), `${template.id}: ${node.data.kind}.${input}`);
      }
    }
    const next = createCompositorTemplate(template.id, () => `id-${++sequence}`);
    assert.ok(next.nodes.every((node) => !nodes.has(node.id)));
    next.nodes[0].data.params.test = 1;
    assert.equal(graph.nodes[0].data.params.test, undefined);
  }
});

test("tracking template shows background until the track is ready", () => {
  let id = 0;
  const { nodes, edges } = createCompositorTemplate("tracking", () => `${++id}`);
  const byKind = (kind) => nodes.find((node) => node.data.kind === kind);
  const background = nodes.find((node) => node.data.label === "Background video");
  assert.ok(edges.some((edge) => edge.source === background.id && edge.target === byKind("viewer").id));
  assert.ok(edges.some((edge) => edge.source === byKind("tracker").id && edge.target === byKind("transform").id && edge.targetHandle === "motion"));
  assert.equal(reachesCompositorNode(edges, byKind("merge").id, byKind("viewer").id), false);
});

test("each template includes correctly connected media inputs", () => {
  const expected = {
    color: ["Media->color.image"],
    mask: ["Media->mask.image"],
    key: ["Background->merge.background", "Foreground->key.image"],
    tracking: ["Background video->tracker.image", "Background video->merge.background",
      "Background video->viewer.image", "Overlay image->transform.image"],
  };
  for (const [template, connections] of Object.entries(expected)) {
    let id = 0;
    const { nodes, edges } = createCompositorTemplate(template, () => `${++id}`);
    const lookup = new Map(nodes.map((node) => [node.id, node]));
    const media = nodes.filter((node) => node.data.kind === "media");
    const actual = edges.filter((edge) => lookup.get(edge.source).data.kind === "media")
      .map((edge) => `${lookup.get(edge.source).data.label}->${lookup.get(edge.target).data.kind}.${edge.targetHandle}`);
    assert.deepEqual(actual.sort(), connections.sort());
    assert.ok(media.every((node) => edges.some((edge) => edge.source === node.id)), `${template}: disconnected media`);
    assert.equal(media.length, template === "key" || template === "tracking" ? 2 : 1);
  }
});

function corrected(rgb, params = {}) {
  const pixels = new Uint8ClampedArray([...rgb, 127]);
  applyColorCorrection(pixels, params);
  assert.equal(pixels[3], 127);
  return Array.from(pixels.slice(0, 3));
}

test("color correction preserves neutral and previously saved controls", () => {
  assert.deepEqual(corrected([80, 100, 120]), [80, 100, 120]);
  assert.deepEqual(corrected([80, 100, 120], { brightness: 80, contrast: 100, saturation: 100 }), [160, 180, 200]);
  assert.deepEqual(corrected([80, 100, 120], { brightness: 0, contrast: 200, saturation: 100 }), [32, 72, 112]);
  assert.deepEqual(corrected([80, 100, 120], { saturation: 0 }), [97, 97, 97]);
  const params = { brightness: -23, contrast: 137, saturation: 183 };
  for (let i = 0; i < 200; i++) {
    const rgb = [(i * 43) % 256, (i * 97) % 256, (i * 151) % 256];
    const gray = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    const expected = new Uint8ClampedArray(rgb.map((v) =>
      (gray + (v - gray) * params.saturation / 100 - 128) * params.contrast / 100 + 128 + params.brightness));
    assert.deepEqual(corrected(rgb, params), Array.from(expected));
  }
});

test("grading and RGB gains affect their expected tonal regions and channels", () => {
  assert.deepEqual(corrected([50, 50, 50], { exposure: 1 }), [100, 100, 100]);
  assert.ok(corrected([64, 64, 64], { gamma: 2 })[0] > 64);
  const warm = corrected([100, 100, 100], { temperature: 40 });
  assert.ok(warm[0] > 100 && warm[2] < 100);
  const tint = corrected([100, 100, 100], { tint: 40 });
  assert.ok(tint[0] > 100 && tint[1] < 100 && tint[2] > 100);
  assert.ok(corrected([30, 30, 30], { shadows: 50 })[0] - 30 > corrected([220, 220, 220], { shadows: 50 })[0] - 220);
  assert.ok(corrected([220, 220, 220], { highlights: -50 })[0] - 220 < corrected([30, 30, 30], { highlights: -50 })[0] - 30);
  assert.deepEqual(corrected([80, 100, 120], { redGain: 200, greenGain: 50, blueGain: 0 }), [160, 50, 0]);
});

test("curves interpolate, compose master before channels and reject malformed points", () => {
  const points = [{ x: 0, y: 0 }, { x: 128, y: 200 }, { x: 255, y: 255 }];
  const table = curveTable(points);
  assert.equal(table[128], 200);
  assert.ok(Math.abs(table[64] - 100) < 0.01);
  assert.deepEqual(corrected([128, 128, 128], {
    curve_master: points,
    curve_red: [{ x: 0, y: 0 }, { x: 200, y: 100 }, { x: 255, y: 255 }],
  }), [100, 200, 200]);
  assert.throws(() => getCurve({ curve_master: [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 255, y: 255 }] }, "master"), /Invalid master/);
});

test("viewer reachability distinguishes bypassed nodes and follows branches safely", () => {
  const edges = [
    { source: "media", target: "viewer" },
    { source: "media", target: "color" },
    { source: "color", target: "mask" },
    { source: "mask", target: "color" },
  ];
  assert.equal(reachesCompositorNode(edges, "color", "viewer"), false);
  assert.equal(reachesCompositorNode(edges, "media", "viewer"), true);
  assert.equal(reachesCompositorNode([...edges, { source: "mask", target: "viewer" }], "color", "viewer"), true);
  assert.equal(reachesCompositorNode(edges, "viewer", "viewer"), true);
});

function frame(width, height, x, y) {
  const pixels = new Uint8ClampedArray(width * height * 4);
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const i = ((y + dy) * width + x + dx) * 4;
      pixels[i] = ((dx + 4) * 31 + (dy + 4) * 17) % 256;
      pixels[i + 1] = ((dx + 4) * 11 + (dy + 4) * 43) % 256;
      pixels[i + 2] = ((dx + 4) * 23 + (dy + 4) * 7) % 256;
      pixels[i + 3] = 255;
    }
  }
  return pixels;
}

test("tracks a detailed feature including near the edge", () => {
  const before = frame(64, 48, 20, 20);
  const after = frame(64, 48, 25, 17);
  assert.deepEqual(trackPatch(before, after, 64, 48, 20, 20), { x: 25, y: 17, confidence: 1 });
  const edge = frame(64, 48, 4, 4);
  assert.deepEqual(trackPatch(before, edge, 64, 48, 20, 20, 4, 20), { x: 4, y: 4, confidence: 1 });
});

test("rejects low-contrast features", () => {
  const flat = new Uint8ClampedArray(64 * 48 * 4);
  assert.throws(() => trackPatch(flat, flat, 64, 48, 20, 20), /too little contrast/);
});

test("interpolates offsets relative to the first frame and clamps at endpoints", () => {
  const points = [{ time: 0, x: 100, y: 50, confidence: 1 }, { time: 1, x: 120, y: 40, confidence: 1 }];
  assert.deepEqual(interpolateTrack(points, -1), { x: 0, y: 0 });
  assert.deepEqual(interpolateTrack(points, 0.5), { x: 10, y: -5 });
  assert.deepEqual(interpolateTrack(points, 2), { x: 20, y: -10 });
  assert.throws(() => interpolateTrack([], 0), /Run the tracker/);
});
