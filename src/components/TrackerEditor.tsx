"use client";

import { useRef } from "react";
import type { TrackingPoint } from "@/lib/compositor-tracking";

export default function TrackerEditor({ anchors, paths, active, editable, transform, onActive, onMove }: {
  anchors: TrackingPoint[];
  paths: TrackingPoint[][];
  active: number;
  editable: boolean;
  transform: string;
  onActive: (index: number) => void;
  onMove: (index: number, point: TrackingPoint) => void;
}) {
  const dragging = useRef<number | null>(null);
  const position = (event: React.PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.max(10, Math.min(630, (event.clientX - rect.left) * 640 / rect.width)),
      y: Math.max(10, Math.min(350, (event.clientY - rect.top) * 360 / rect.height)),
    };
  };
  const down = (event: React.PointerEvent<SVGSVGElement>) => {
    if (!editable || event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    const target = event.target as SVGElement;
    const marker = target.closest("[data-tracker-anchor]");
    const index = marker ? Number(marker.getAttribute("data-tracker-anchor")) : active;
    dragging.current = index;
    onActive(index);
    event.currentTarget.setPointerCapture(event.pointerId);
    onMove(index, position(event));
  };
  return <svg className="comp-tracker-editor" width="640" height="360" viewBox="0 0 640 360"
    style={{ transform }} role="group" aria-label="Tracking markers"
    onPointerDown={down} onPointerMove={(event) => {
      if (dragging.current !== null && editable) onMove(dragging.current, position(event));
    }} onPointerUp={(event) => {
      dragging.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }} onPointerCancel={() => { dragging.current = null; }}>
    <rect width="640" height="360" fill="transparent" />
    {paths.map((path, index) => path.length > 1 && <polyline key={index}
      points={path.map((point) => `${point.x},${point.y}`).join(" ")} className="comp-tracker-path" />)}
    {anchors.length === 4 && <polygon points={anchors.map((point) => `${point.x},${point.y}`).join(" ")}
      className="comp-tracker-surface" />}
    {anchors.map((point, index) => <g key={index} data-tracker-anchor={index} className="comp-tracker-anchor">
      <circle cx={point.x} cy={point.y} r="9" className={index === active ? "selected" : ""} />
      <path d={`M ${point.x - 15} ${point.y} h 30 M ${point.x} ${point.y - 15} v 30`} />
      <text x={point.x + 12} y={point.y - 10}>{index + 1}</text>
    </g>)}
  </svg>;
}
