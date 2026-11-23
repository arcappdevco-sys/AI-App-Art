export type CanvasViewport = { x: number; y: number; zoom: number };
export type CanvasPoint = { x: number; y: number };

export function zoomCanvasAtPoint(
  viewport: CanvasViewport,
  point: CanvasPoint,
  deltaY: number,
  minZoom: number,
  maxZoom: number,
): CanvasViewport {
  const zoom = Math.min(maxZoom, Math.max(minZoom, viewport.zoom * 2 ** (-deltaY / 500)));
  const scale = zoom / viewport.zoom;
  return {
    x: point.x - (point.x - viewport.x) * scale,
    y: point.y - (point.y - viewport.y) * scale,
    zoom,
  };
}
