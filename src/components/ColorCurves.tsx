"use client";

import { useRef, useState, type PointerEvent } from "react";
import { CURVE_CHANNELS, getCurve, IDENTITY_CURVE, type CurveChannel, type CurvePoint } from "@/lib/compositor-color";
import type { CompositorParams } from "@/lib/compositor";

export default function ColorCurves({ params, disabled, onChange }: {
  params: CompositorParams;
  disabled: boolean;
  onChange: (key: string, value: CurvePoint[]) => void;
}) {
  const [channel, setChannel] = useState<CurveChannel>("master");
  const [selected, setSelected] = useState<number | null>(null);
  const drag = useRef<number | null>(null);
  const points = getCurve(params, channel);
  const key = `curve_${channel}`;
  const position = (event: PointerEvent<SVGSVGElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: Math.round(Math.max(0, Math.min(255, (event.clientX - rect.left) / rect.width * 255))),
      y: Math.round(Math.max(0, Math.min(255, (1 - (event.clientY - rect.top) / rect.height) * 255))),
    };
  };
  const move = (index: number, point: CurvePoint, current: CurvePoint[]) => {
    const x = index === 0 ? 0 : index === current.length - 1 ? 255 :
      Math.max(current[index - 1].x + 1, Math.min(current[index + 1].x - 1, point.x));
    onChange(key, current.map((p, i) => i === index ? { x, y: point.y } : p));
  };
  const begin = (event: PointerEvent<SVGSVGElement>) => {
    if (disabled || event.button !== 0) return;
    event.preventDefault();
    const point = position(event);
    const rect = event.currentTarget.getBoundingClientRect();
    const nearest = points.map((p, index) => ({
      index, distance: Math.hypot((p.x - point.x) * rect.width / 255, (p.y - point.y) * rect.height / 255),
    })).sort((a, b) => a.distance - b.distance)[0];
    let index = nearest.distance <= 12 ? nearest.index : -1;
    if (index < 0) {
      if (points.length >= 12 || point.x <= 0 || point.x >= 255 || points.some((p) => p.x === point.x)) return;
      const next = [...points, point].sort((a, b) => a.x - b.x);
      index = next.indexOf(point);
      onChange(key, next);
    }
    drag.current = index;
    setSelected(index);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const active = selected === null ? undefined : points[selected];
  const addPoint = () => {
    let index = 0;
    for (let i = 1; i < points.length - 1; i++) {
      if (points[i + 1].x - points[i].x > points[index + 1].x - points[index].x) index = i;
    }
    const a = points[index], b = points[index + 1];
    if (b.x - a.x < 2) return;
    const x = Math.round((a.x + b.x) / 2);
    const point = { x, y: Math.round(a.y + (b.y - a.y) * (x - a.x) / (b.x - a.x)) };
    const next = [...points.slice(0, index + 1), point, ...points.slice(index + 1)];
    onChange(key, next);
    setSelected(index + 1);
  };
  return <div className="comp-curves">
    <label>Curve channel
      <select value={channel} disabled={disabled} onChange={(event) => {
        setChannel(event.target.value as CurveChannel); setSelected(null);
      }}>
        {CURVE_CHANNELS.map((item) => <option key={item} value={item}>{item === "master" ? "Master" : item[0].toUpperCase() + item.slice(1)}</option>)}
      </select>
    </label>
    <svg className="comp-curve-graph" viewBox="0 0 255 255" role="img"
      aria-label={`${channel} color curve`} onPointerDown={begin}
      onPointerMove={(event) => { if (!disabled && drag.current !== null) move(drag.current, position(event), points); }}
      onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <path d="M 0 85 H 255 M 0 170 H 255 M 85 0 V 255 M 170 0 V 255" className="comp-curve-grid" />
      <polyline points={points.map((point) => `${point.x},${255 - point.y}`).join(" ")} className={`comp-curve-line comp-curve-${channel}`} />
      {points.map((point, index) => <circle key={index} cx={point.x} cy={255 - point.y} r="5"
        className={index === selected ? "comp-curve-point selected" : "comp-curve-point"} />)}
    </svg>
    <small>Click to add a point; drag to adjust. Select a point to edit its coordinates.</small>
    <label>Curve point
      <select value={selected === null ? "" : String(selected)} disabled={disabled}
        onChange={(event) => setSelected(event.target.value === "" ? null : Number(event.target.value))}>
        <option value="">Select a point</option>
        {points.map((point, index) => <option key={index} value={index}>{`Point ${index + 1}: ${point.x} → ${point.y}`}</option>)}
      </select>
    </label>
    <button type="button" disabled={disabled || points.length >= 12} onClick={addPoint}>Add curve point</button>
    {active && <div className="comp-curve-values">
      <label>Input
        <input type="number" min={selected === 0 ? 0 : points[selected! - 1].x + 1}
          max={selected === points.length - 1 ? 255 : points[selected! + 1].x - 1}
          value={active.x} disabled={disabled || selected === 0 || selected === points.length - 1}
          onChange={(event) => move(selected!, { ...active, x: Number(event.target.value) }, points)} />
      </label>
      <label>Output
        <input type="number" min="0" max="255" value={active.y} disabled={disabled}
          onChange={(event) => move(selected!, { ...active, y: Math.max(0, Math.min(255, Number(event.target.value))) }, points)} />
      </label>
      <button type="button" disabled={disabled || selected === 0 || selected === points.length - 1}
        onClick={() => { onChange(key, points.filter((_, index) => index !== selected)); setSelected(null); }}>Remove point</button>
    </div>}
    <button type="button" disabled={disabled} onClick={() => { onChange(key, IDENTITY_CURVE.map((point) => ({ ...point }))); setSelected(null); }}>Reset {channel} curve</button>
  </div>;
}
