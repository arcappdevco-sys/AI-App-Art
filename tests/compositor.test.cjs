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
const { trackPatch, interpolateTrack, reachesCompositorNode, zoomViewerAt, compositorImageFit, compositorMediaSource, compositorBypassInput, compositorRange, nextCompositorTime, COMPOSITOR_INPUTS } = require(path.join(__dirname, "..", "src", "lib", "compositor.ts"));
const { applyColorCorrection, curveTable, getCurve } = require(path.join(__dirname, "..", "src", "lib", "compositor-color.ts"));
const { COMPOSITOR_NODE_OPTIONS, COMPOSITOR_TEMPLATES, appendCompositorTemplate, createCompositorNode, createCompositorTemplate } = require(path.join(__dirname, "..", "src", "lib", "compositor-templates.ts"));
const { applyCompositorMask, combineMaskAlpha, convertMaskGeometry, createMaskGeometry, createMaskLayer, getMaskLayers, maskGeometryAt, maskGeometryPath, removeMaskKeyframe, setMaskKeyframe, updateMaskGeometry, validateMaskProjection } = require(path.join(__dirname, "..", "src", "lib", "compositor-mask.ts"));
const { applyCompositorKeyer } = require(path.join(__dirname, "..", "src", "lib", "compositor-keyer.ts"));
const { CompositorHistory, compositorHistoryShortcut } = require(path.join(__dirname, "..", "src", "lib", "compositor-history.ts"));
const { IDENTITY_TRACKING_MATRIX, detectPlanarFeatures, invertTrackingMatrix, multiplyTrackingMatrices, planarTrackingMatrix, similarityTrackingMatrix, trackingAt, trackPlanarFeatures, transformTrackingPoint, validateTrackingProjection, validateTrackingSurface, warpTrackingPixels } = require(path.join(__dirname, "..", "src", "lib", "compositor-tracking.ts"));
const { applySmartMattePixels, smartMatteCost, smartMatteSourceHash, submitSmartMatte, validateSmartMatteSource } = require(path.join(__dirname, "..", "src", "lib", "smart-matte.ts"));

test("Smart Matte applies grayscale alpha without replacing source transparency", () => {
  const source = new Uint8ClampedArray([10, 20, 30, 200, 30, 40, 50, 128, 40, 50, 60, 255]);
  const matte = new Uint8ClampedArray([0, 0, 0, 255, 128, 128, 128, 255, 255, 255, 255, 255]);
  applySmartMattePixels(source, matte);
  assert.deepEqual([...source], [10, 20, 30, 0, 30, 40, 50, 64, 40, 50, 60, 255]);
  assert.throws(() => applySmartMattePixels(source, new Uint8ClampedArray(4)), /invalid size/);
});

test("Smart Matte validates source limits and estimates resolution-based pricing", () => {
  const video = new File(["video"], "source.mp4", { type: "video/mp4" });
  assert.equal(validateSmartMatteSource(video, 5, 1920, 1080), 0.5);
  assert.equal(smartMatteCost(5, 2560, 1440), 1.25);
  assert.equal(smartMatteCost(5, 3840, 2160), 5);
  assert.throws(() => smartMatteCost(5, 3841, 2160), /3840/);
  assert.throws(() => smartMatteCost(5, 640, 100), /aspect ratio/);
  assert.throws(() => validateSmartMatteSource(new File(["x"], "x.png", { type: "image/png" }), 5, 1920, 1080), /video/);
});

test("Smart Matte identifies source content across reloads and detects replacements", async () => {
  const a = new File(["same"], "source.mp4", { type: "video/mp4" });
  const b = new File(["same"], "renamed.mp4", { type: "video/mp4" });
  const c = new File(["changed"], "source.mp4", { type: "video/mp4" });
  assert.equal(await smartMatteSourceHash(a), await smartMatteSourceHash(b));
  assert.notEqual(await smartMatteSourceHash(a), await smartMatteSourceHash(c));
  assert.equal(COMPOSITOR_NODE_OPTIONS.filter((option) => option.kind === "smart-matte").length, 1);
});

test("Smart Matte submits once and treats an ambiguous response as uncertain", async () => {
  const originalFetch = global.fetch;
  let calls = 0;
  global.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "/api/fal/proxy");
    assert.equal(options.headers["x-fal-target-url"], "https://queue.fal.run/lightricks/ltx-2.5/alpha-gen");
    assert.deepEqual(JSON.parse(options.body), { video_url: "https://example.test/video.mp4" });
    return new Response("unavailable", { status: 503 });
  };
  try {
    await assert.rejects(submitSmartMatte("https://example.test/video.mp4"), /uncertain/);
    assert.equal(calls, 1);
  } finally {
    global.fetch = originalFetch;
  }
});

test("Smart Matte accepts a request ID and rejects an ambiguous successful response", async () => {
  const originalFetch = global.fetch;
  try {
    global.fetch = async () => Response.json({ request_id: "request-123" });
    assert.equal(await submitSmartMatte("https://example.test/video.mp4"), "request-123");
    global.fetch = async () => Response.json({ status: "IN_QUEUE" });
    await assert.rejects(submitSmartMatte("https://example.test/video.mp4"), /uncertain/);
  } finally {
    global.fetch = originalFetch;
  }
});

test("compositor media fit preserves source aspect ratio and centers letterboxed footage", () => {
  assert.deepEqual(compositorImageFit(1920, 1080, 640, 360), { x: 0, y: 0, width: 640, height: 360 });
  assert.deepEqual(compositorImageFit(1000, 1000, 640, 360), { x: 140, y: 0, width: 360, height: 360 });
  assert.deepEqual(compositorImageFit(1080, 1920, 640, 360), { x: 218.75, y: 0, width: 202.5, height: 360 });
  assert.throws(() => compositorImageFit(0, 1080, 640, 360), /positive finite/);
});

test("two-point tracking maps both points with rotation and scale", () => {
  const start = [{ x: 10, y: 20 }, { x: 30, y: 20 }];
  const end = [{ x: 50, y: 60 }, { x: 50, y: 100 }];
  const matrix = similarityTrackingMatrix(start, end);
  for (let i = 0; i < start.length; i++) {
    const mapped = transformTrackingPoint(matrix, start[i]);
    assert.ok(Math.hypot(mapped.x - end[i].x, mapped.y - end[i].y) < 1e-8);
  }
  assert.throws(() => similarityTrackingMatrix([start[0], start[0]], end), /separated/);
});

test("planar tracking maps perspective, inverts, and interpolates anchor positions", () => {
  const start = [{ x: 30, y: 30 }, { x: 200, y: 30 }, { x: 200, y: 160 }, { x: 30, y: 160 }];
  const end = [{ x: 40, y: 20 }, { x: 220, y: 45 }, { x: 190, y: 180 }, { x: 50, y: 145 }];
  const matrix = planarTrackingMatrix(start, end);
  const inverse = invertTrackingMatrix(matrix);
  for (let i = 0; i < start.length; i++) {
    const mapped = transformTrackingPoint(matrix, start[i]);
    assert.ok(Math.hypot(mapped.x - end[i].x, mapped.y - end[i].y) < 1e-6);
    const restored = transformTrackingPoint(inverse, mapped);
    assert.ok(Math.hypot(restored.x - start[i].x, restored.y - start[i].y) < 1e-6);
  }
  const identity = multiplyTrackingMatrices(inverse, matrix);
  assert.ok(identity.every((value, i) => Math.abs(value - IDENTITY_TRACKING_MATRIX[i]) < 1e-6));
  const data = { mode: "planar", complete: false, endTime: 3, samples: [
    { time: 0, matrix: IDENTITY_TRACKING_MATRIX, anchors: start, confidence: 1 },
    { time: 2, matrix, anchors: end, confidence: 0.9 },
  ] };
  const middle = trackingAt(data, 1);
  const mapped = transformTrackingPoint(middle.matrix, start[0]);
  assert.ok(Math.abs(mapped.x - 35) < 1e-6 && Math.abs(mapped.y - 25) < 1e-6);
  assert.throws(() => trackingAt(data, 2.5), /incomplete/);
  assert.throws(() => planarTrackingMatrix(start.map(() => start[0]), end), /usable surface/);
  assert.throws(() => validateTrackingSurface([start[0], start[2], start[1], start[3]]), /convex/);
  assert.throws(() => validateTrackingProjection([1, 0, 0, 0, 1, 0, -0.01, 0, 1]), /horizon/);
  assert.throws(() => validateMaskProjection({ kind: "rectangle", x: 900, y: 0, width: 200, height: 20 },
    [1, 0, 0, 0, 1, 0, -0.001, 0, 1]), /horizon/);
});

test("planar tracking estimates motion from textured surface features", () => {
  const width = 100, height = 80;
  const before = new Uint8ClampedArray(width * height * 4), after = new Uint8ClampedArray(before.length);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const v = ((x * 47 + y * 101 + x * y * 13) ^ (x * 17 + y * 31)) & 255;
    const i = (y * width + x) * 4;
    before[i] = before[i + 1] = before[i + 2] = v; before[i + 3] = 255;
    if (x + 2 < width && y + 1 < height) {
      const j = ((y + 1) * width + x + 2) * 4;
      after[j] = after[j + 1] = after[j + 2] = v; after[j + 3] = 255;
    }
  }
  const polygon = [{ x: 10, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 70 }, { x: 10, y: 70 }];
  const features = detectPlanarFeatures(before, width, height, polygon);
  const result = trackPlanarFeatures(before, after, width, height, features);
  const point = transformTrackingPoint(result.matrix, { x: 50, y: 40 });
  assert.ok(Math.abs(point.x - 52) < 0.5 && Math.abs(point.y - 41) < 0.5);
  assert.throws(() => detectPlanarFeatures(new Uint8ClampedArray(before.length), width, height, polygon), /texture/);
});

test("planar features follow a perspective-warped surface over multiple frames", () => {
  const width = 160, height = 120, source = new Uint8ClampedArray(width * height * 4);
  let seed = 123456;
  for (let i = 0; i < width * height; i++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    source[i * 4] = source[i * 4 + 1] = source[i * 4 + 2] = seed >>> 24;
    source[i * 4 + 3] = 255;
  }
  const corners = [{ x: 20, y: 20 }, { x: 140, y: 20 }, { x: 140, y: 100 }, { x: 20, y: 100 }];
  let features = detectPlanarFeatures(source, width, height, corners);
  let previous = source, estimate = IDENTITY_TRACKING_MATRIX;
  for (let frame = 1; frame <= 4; frame++) {
    const actual = [1, -0.01 * frame, 2 * frame, 0.008 * frame, 1, frame, 0.00006 * frame, -0.00004 * frame, 1];
    const current = warpTrackingPixels(source, width, height, actual);
    const tracked = trackPlanarFeatures(previous, current, width, height, features);
    estimate = multiplyTrackingMatrices(tracked.matrix, estimate);
    features = tracked.features; previous = current;
    for (const point of corners) {
      const expected = transformTrackingPoint(actual, point), observed = transformTrackingPoint(estimate, point);
      assert.ok(Math.hypot(expected.x - observed.x, expected.y - observed.y) < 2);
    }
  }
});

test("tracked image warp preserves alpha and saved single-point tracks", () => {
  const source = new Uint8ClampedArray(5 * 5 * 4);
  source.set([250, 50, 20, 128], (2 * 5 + 2) * 4);
  const matrix = [1, 0, 1, 0, 1, 0, 0, 0, 1];
  const warped = warpTrackingPixels(source, 5, 5, matrix);
  assert.deepEqual([...warped.slice((2 * 5 + 3) * 4, (2 * 5 + 4) * 4)], [250, 50, 20, 128]);
  assert.equal(warped[(2 * 5 + 2) * 4 + 3], 0);
  const oldTrack = [{ time: 0, x: 10, y: 20, confidence: 1 }, { time: 2, x: 30, y: 30, confidence: 0.9 }];
  const interpolated = trackingAt(oldTrack, 1);
  assert.deepEqual(interpolated.matrix, [1, 0, 10, 0, 1, 5, 0, 0, 1]);
});

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

test("mask shapes support legacy rectangles, shape conversion and closed Bézier paths", () => {
  const [legacy] = getMaskLayers({ x: 300, y: 120, width: 100, height: 80 });
  assert.deepEqual(legacy.geometry, { kind: "rectangle", x: 250, y: 80, width: 100, height: 80 });
  const ellipse = convertMaskGeometry(legacy.geometry, "ellipse");
  assert.deepEqual(ellipse, { kind: "ellipse", x: 250, y: 80, width: 100, height: 80 });
  const bezier = convertMaskGeometry(legacy.geometry, "bezier");
  assert.match(maskGeometryPath(bezier), / C /);
  assert.equal(maskGeometryPath(createMaskGeometry("polygon")), "");
  assert.match(maskGeometryPath(convertMaskGeometry(legacy.geometry, "polygon")), / Z$/);
  assert.throws(() => getMaskLayers({ layers: [{ id: "invalid" }] }), /invalid mask layer data/);
});

test("new mask nodes start empty and incomplete shapes pass the source through", () => {
  let id = 0;
  const mask = createCompositorTemplate("mask", () => `${++id}`).nodes.find((node) => node.data.kind === "mask");
  assert.deepEqual(getMaskLayers(mask.data.params), []);
  const source = {};
  assert.equal(applyCompositorMask(source, [], 0, false), source);
  assert.equal(applyCompositorMask(source, [], 0, true), source);
  for (const kind of ["rectangle", "ellipse", "polygon", "freehand", "bezier"]) {
    const layer = createMaskLayer(kind, kind);
    assert.equal(applyCompositorMask(source, [layer], 0, false), source);
  }
  const point = { x: 10, y: 20, inX: 0, inY: 0, outX: 0, outY: 0 };
  const unfinished = { ...createMaskLayer("bezier", "draft"), geometry: { kind: "bezier", points: [point, { ...point, x: 30 }] } };
  assert.equal(applyCompositorMask(source, [unfinished], 0, true), source);
  assert.doesNotMatch(maskGeometryPath(unfinished.geometry), / Z$/);
});

test("mask layers combine alpha and animate Bézier points between keyframes", () => {
  assert.equal(combineMaskAlpha(0.5, 0.5, "add"), 0.75);
  assert.equal(combineMaskAlpha(0.5, 0.5, "subtract"), 0.25);
  assert.equal(combineMaskAlpha(0.5, 0.5, "intersect"), 0.25);
  let layer = createMaskLayer("bezier", "animated");
  layer = { ...layer, geometry: convertMaskGeometry(createMaskGeometry("ellipse"), "bezier") };
  layer = setMaskKeyframe(layer, 0);
  const end = { ...layer.geometry, points: layer.geometry.points.map((point) => ({
    ...point, x: point.x + 100, outX: point.outX + 20,
  })) };
  layer = updateMaskGeometry(layer, end, 10);
  const middle = maskGeometryAt(layer, 5);
  assert.equal(middle.kind, "bezier");
  assert.equal(middle.points[0].x, layer.keyframes[0].geometry.points[0].x + 50);
  assert.equal(middle.points[0].outX, layer.keyframes[0].geometry.points[0].outX + 10);
  layer = removeMaskKeyframe(layer, 10);
  assert.equal(layer.keyframes.length, 1);
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

test("adding a template preserves the canvas and routes its output to the existing Viewer", () => {
  let id = 0;
  const current = createCompositorTemplate("color", () => `current-${++id}`);
  const template = createCompositorTemplate("key", () => `template-${++id}`);
  const oldViewer = current.nodes.find((node) => node.data.kind === "viewer");
  const oldViewerInput = current.edges.find((edge) => edge.target === oldViewer.id);
  const preservedEdges = current.edges.filter((edge) => edge.id !== oldViewerInput.id);
  const templateViewer = template.nodes.find((node) => node.data.kind === "viewer");
  const templateViewerInput = template.edges.find((edge) => edge.target === templateViewer.id);

  const result = appendCompositorTemplate(current.nodes, current.edges, template);
  const addedNodes = result.nodes.filter((node) => node.id.startsWith("template-"));
  const addedEdges = result.edges.filter((edge) => edge.id.startsWith("template-"));

  assert.equal(result.nodes.length, current.nodes.length + template.nodes.length - 1);
  assert.ok(current.nodes.every((node) => result.nodes.some((added) => added.id === node.id)));
  assert.ok(addedNodes.every((node) => node.position.x > Math.max(...current.nodes.map((item) => item.position.x))));
  assert.ok(preservedEdges.every((edge) => result.edges.some((added) => added.id === edge.id)));
  assert.equal(result.edges.some((edge) => edge.id === oldViewerInput.id), false);
  assert.ok(addedEdges.some((edge) => edge.source === templateViewerInput.source && edge.target === oldViewer.id));
  assert.equal(result.nodes.filter((node) => node.data.kind === "viewer").length, 1);
  assert.equal(result.selectedId, templateViewerInput.source);
  assert.ok(result.nodes.find((node) => node.id === result.selectedId).selected);
  assert.equal(result.edges.filter((edge) => edge.target === oldViewer.id && edge.targetHandle === "image").length, 1);
});

test("adding a template to a canvas without a Viewer keeps the template Viewer", () => {
  let id = 0;
  const template = createCompositorTemplate("mask", () => `template-${++id}`);
  const result = appendCompositorTemplate([], [], template);
  assert.deepEqual(result.nodes, template.nodes.map((node) =>
    node.id === result.selectedId ? { ...node, selected: true } : { ...node, selected: false }));
  assert.deepEqual(result.edges, template.edges.map((edge) => ({ ...edge, selected: false })));
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
  assert.throws(() => trackPatch(frame(64, 48, 20, 20), flat, 64, 48, 20, 20), /current frame/);
});

test("interpolates offsets relative to the first frame and clamps at endpoints", () => {
  const points = [{ time: 0, x: 100, y: 50, confidence: 1 }, { time: 1, x: 120, y: 40, confidence: 1 }];
  assert.deepEqual(interpolateTrack(points, -1), { x: 0, y: 0 });
  assert.deepEqual(interpolateTrack(points, 0.5), { x: 10, y: -5 });
  assert.deepEqual(interpolateTrack(points, 2), { x: 20, y: -10 });
  assert.throws(() => interpolateTrack([], 0), /Run the tracker/);
});
