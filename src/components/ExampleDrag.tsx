"use client";

import { useEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from "react";

type ExampleDragState = {
  pointerId: number;
  type: string;
  label: string;
  startX: number;
  startY: number;
  dragging: boolean;
  cancelled: boolean;
  previousUserSelect: string;
};

type ExampleDragPreviewState = { label: string; x: number; y: number; allowed: boolean };

export function useExampleDrag(
  canvasRef: RefObject<HTMLElement | null>,
  onDrop: (type: string, position: { x: number; y: number }) => void,
) {
  const drag = useRef<ExampleDragState | null>(null);
  const suppressClick = useRef(false);
  const [preview, setPreview] = useState<ExampleDragPreviewState | null>(null);

  const restoreSelection = (current: ExampleDragState) => {
    if (current.dragging) document.documentElement.style.userSelect = current.previousUserSelect;
  };

  useEffect(() => {
    const cancel = () => {
      const current = drag.current;
      if (!current) return;
      current.cancelled = true;
      suppressClick.current = true;
      restoreSelection(current);
      setPreview(null);
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && drag.current) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("blur", cancel);
      if (drag.current) restoreSelection(drag.current);
    };
  }, []);

  const isCanvasTarget = (x: number, y: number) => {
    const target = document.elementFromPoint(x, y);
    return Boolean(target && canvasRef.current?.contains(target)
      && target.closest(".react-flow__pane, .react-flow__viewport"));
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>, type: string, label: string) => {
    if (event.button !== 0 || !event.isPrimary || (event.pointerType !== "mouse" && event.pointerType !== "pen")) return;
    suppressClick.current = false;
    drag.current = {
      pointerId: event.pointerId, type, label, startX: event.clientX, startY: event.clientY,
      dragging: false, cancelled: false,
      previousUserSelect: document.documentElement.style.userSelect,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId || current.cancelled) return;
    if (!current.dragging && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) >= 5) {
      current.dragging = true;
      suppressClick.current = true;
      document.documentElement.style.userSelect = "none";
      window.getSelection()?.removeAllRanges();
    }
    if (current.dragging) {
      event.preventDefault();
      setPreview({ label: current.label, x: event.clientX, y: event.clientY, allowed: isCanvasTarget(event.clientX, event.clientY) });
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    drag.current = null;
    restoreSelection(current);
    setPreview(null);
    if (current.dragging) {
      event.preventDefault();
      if (!current.cancelled && isCanvasTarget(event.clientX, event.clientY)) {
        onDrop(current.type, { x: event.clientX, y: event.clientY });
      }
    }
  };

  const onPointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    suppressClick.current = current.dragging || current.cancelled;
    drag.current = null;
    restoreSelection(current);
    setPreview(null);
  };

  const onClickCapture = (event: MouseEvent<HTMLButtonElement>) => {
    if (suppressClick.current && event.detail !== 0) {
      event.preventDefault();
      event.stopPropagation();
    }
    suppressClick.current = false;
  };

  return { preview, onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClickCapture };
}

export function ExampleDragPreview({ preview }: { preview: ExampleDragPreviewState | null }) {
  if (!preview) return null;
  return (
    <div
      className={`ff-example-drag-preview${preview.allowed ? "" : " ff-example-drag-disallowed"}`}
      style={{ left: preview.x + 14, top: preview.y + 14 }}
      aria-hidden="true"
    >
      {preview.label}
    </div>
  );
}
