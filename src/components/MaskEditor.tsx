"use client";

import { useRef } from "react";
import {
  addFreehandPoint, maskCanvasSize, moveMaskGeometry, projectedMaskPath, type MaskGeometry, type MaskPoint,
} from "@/lib/compositor-mask";
import { invertTrackingMatrix, transformTrackingPoint, type TrackingMatrix } from "@/lib/compositor-tracking";

type DragState = {
  kind: "anchor" | "handle" | "corner" | "move" | "freehand" | "draw-box" | "new-bezier";
  index?: number;
  handle?: "in" | "out";
  start: { x: number; y: number };
  initial: MaskGeometry;
};

function point(x: number, y: number): MaskPoint {
  return { x, y, inX: 0, inY: 0, outX: 0, outY: 0 };
}

export default function MaskEditor({ geometry, disabled, allowPointChanges, motion, transform, selectedPoint, onSelectPoint, onChange }: {
  geometry: MaskGeometry;
  disabled: boolean;
  allowPointChanges: boolean;
  motion: TrackingMatrix;
  transform: string;
  selectedPoint: number | null;
  onSelectPoint: (index: number | null) => void;
  onChange: (geometry: MaskGeometry) => void;
}) {
  const drag = useRef<DragState | null>(null);
  const { width, height } = maskCanvasSize();
  const path = projectedMaskPath(geometry, motion);
  const inverse = invertTrackingMatrix(motion);
  const project = (point: { x: number; y: number }) => transformTrackingPoint(motion, point);
  const points = "points" in geometry ? geometry.points : [];
  const activeSelectedPoint = selectedPoint !== null && selectedPoint < points.length ? selectedPoint : null;
  const bounds = "x" in geometry ? geometry : null;
  const corners = bounds && bounds.width > 0 && bounds.height > 0 ? [
    { x: bounds.x, y: bounds.y }, { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height }, { x: bounds.x, y: bounds.y + bounds.height },
  ] : [];
  const coordinate = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return transformTrackingPoint(inverse, {
      x: (event.clientX - rect.left) * width / rect.width,
      y: (event.clientY - rect.top) * height / rect.height,
    });
  };
  const startDrag = (event: React.PointerEvent<SVGSVGElement>, state: DragState) => {
    event.preventDefault(); event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = state;
  };
  const onPointerDown = (event: React.PointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    const target = event.target as SVGElement;
    const position = coordinate(event);
    const handle = target.closest("[data-mask-handle]");
    if (handle) {
      const index = Number(handle.getAttribute("data-mask-anchor-index"));
      onSelectPoint(index);
      startDrag(event, { kind: "handle", index, handle: handle.getAttribute("data-mask-handle") as "in" | "out", start: position, initial: geometry });
      return;
    }
    const anchor = target.closest("[data-mask-anchor]");
    if (anchor) {
      const index = Number(anchor.getAttribute("data-mask-anchor"));
      onSelectPoint(index);
      startDrag(event, { kind: "anchor", index, start: position, initial: geometry });
      return;
    }
    const corner = target.closest("[data-mask-corner]");
    if (corner) {
      startDrag(event, { kind: "corner", index: Number(corner.getAttribute("data-mask-corner")), start: position, initial: geometry });
      return;
    }
    if (target.closest("[data-mask-move]")) {
      startDrag(event, { kind: "move", start: position, initial: geometry });
      return;
    }
    if (geometry.kind === "freehand" && allowPointChanges) {
      onSelectPoint(null);
      const initial = { ...geometry, points: [point(position.x, position.y)] };
      startDrag(event, { kind: "freehand", start: position, initial });
      onChange(initial);
    } else if (allowPointChanges && (geometry.kind === "polygon" || geometry.kind === "bezier")) {
      const next = { ...geometry, points: [...geometry.points, point(position.x, position.y)] };
      onSelectPoint(geometry.points.length);
      if (geometry.kind === "bezier") startDrag(event, {
        kind: "new-bezier", index: geometry.points.length, start: position, initial: next,
      });
      onChange(next);
    } else if (bounds && (!bounds.width || !bounds.height)) {
      startDrag(event, { kind: "draw-box", start: position, initial: geometry });
    }
  };
  const onPointerMove = (event: React.PointerEvent<SVGSVGElement>) => {
    const state = drag.current;
    if (!state || disabled) return;
    const position = coordinate(event);
    const dx = position.x - state.start.x, dy = position.y - state.start.y;
    if (state.kind === "move") { onChange(moveMaskGeometry(state.initial, dx, dy)); return; }
    if (state.kind === "draw-box" && "x" in state.initial) {
      onChange({ ...state.initial, x: Math.min(state.start.x, position.x), y: Math.min(state.start.y, position.y),
        width: Math.abs(dx), height: Math.abs(dy) });
      return;
    }
    if (state.kind === "new-bezier" && state.initial.kind === "bezier") {
      onChange({ ...state.initial, points: state.initial.points.map((item, index) => index === state.index
        ? { ...item, inX: -dx, inY: -dy, outX: dx, outY: dy } : item) });
      return;
    }
    if (state.kind === "freehand") {
      if (state.initial.kind !== "freehand") return;
      const next = { ...state.initial, points: addFreehandPoint(state.initial.points, position.x, position.y) };
      drag.current = { ...state, initial: next };
      onChange(next);
      return;
    }
    if (state.kind === "corner" && "x" in state.initial) {
      const original = state.initial;
      const left = state.index === 0 || state.index === 3;
      const top = state.index === 0 || state.index === 1;
      const x1 = left ? position.x : original.x;
      const y1 = top ? position.y : original.y;
      const x2 = left ? original.x + original.width : position.x;
      const y2 = top ? original.y + original.height : position.y;
      onChange({ ...original, x: Math.min(x1, x2), y: Math.min(y1, y2),
        width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) });
      return;
    }
    if ((state.kind === "anchor" || state.kind === "handle") && "points" in state.initial) {
      const index = state.index!;
      const points = state.initial.points.map((item, current) => {
        if (current !== index) return item;
        if (state.kind === "anchor") return { ...item, x: item.x + dx, y: item.y + dy };
        const keyX = state.handle === "in" ? "inX" : "outX";
        const keyY = state.handle === "in" ? "inY" : "outY";
        return { ...item, [keyX]: position.x - item.x, [keyY]: position.y - item.y };
      });
      onChange({ ...state.initial, points });
    }
  };
  const stopDrag = (event: React.PointerEvent<SVGSVGElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    drag.current = null;
  };

  return <svg className="comp-mask-editor" width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"
      style={{ transform }}
      role="group" aria-label="Mask shape editor" onPointerDown={onPointerDown} onPointerMove={onPointerMove}
      onPointerUp={stopDrag} onPointerCancel={stopDrag}>
      <rect width={width} height={height} className="comp-mask-editor-bg" />
      {path && <path d={path} className={`comp-mask-shape${"points" in geometry ? " is-outline" : ""}`} data-mask-move="true" />}
      {corners.map((item, index) => <circle key={index} cx={project(item).x} cy={project(item).y} r="7"
        className="comp-mask-point comp-mask-corner" data-mask-corner={index} vectorEffect="non-scaling-stroke" />)}
      {points.map((item, index) => {
        const anchor = project(item);
        const incoming = project({ x: item.x + item.inX, y: item.y + item.inY });
        const outgoing = project({ x: item.x + item.outX, y: item.y + item.outY });
        return <g key={index}>
        {geometry.kind === "bezier" && <>
          <line x1={anchor.x} y1={anchor.y} x2={incoming.x} y2={incoming.y} className="comp-mask-handle-line" />
          <line x1={anchor.x} y1={anchor.y} x2={outgoing.x} y2={outgoing.y} className="comp-mask-handle-line" />
          <circle cx={incoming.x} cy={incoming.y} r="5" className="comp-mask-handle"
            data-mask-handle="in" data-mask-anchor-index={index} vectorEffect="non-scaling-stroke" />
          <circle cx={outgoing.x} cy={outgoing.y} r="5" className="comp-mask-handle"
            data-mask-handle="out" data-mask-anchor-index={index} vectorEffect="non-scaling-stroke" />
        </>}
        <circle cx={anchor.x} cy={anchor.y} r="7" className={`comp-mask-point${activeSelectedPoint === index ? " selected" : ""}`}
          data-mask-anchor={index} vectorEffect="non-scaling-stroke" />
      </g>; })}
    </svg>;
}
