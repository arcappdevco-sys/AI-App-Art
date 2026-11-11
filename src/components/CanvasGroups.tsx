"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties, type PointerEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ViewportPortal, useReactFlow, useViewport } from "@xyflow/react";
import {
  createCanvasGroup, GROUP_COLORS, GROUP_MIN_HEIGHT, GROUP_MIN_WIDTH, groupBoundsForNodes,
  nodesInsideGroup, type CanvasGroup, type GroupColor,
} from "@/lib/canvas-groups";

type GroupMenu = { x: number; y: number; screenX: number; screenY: number; target: HTMLElement; groupId?: string };
type GroupDrag = {
  id: string;
  mode: "move" | "resize";
  start: { x: number; y: number };
  group: CanvasGroup;
  nodes: Map<string, { x: number; y: number }>;
};

function groupTypingTarget(target: EventTarget | null) {
  return target instanceof Element && Boolean(target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"));
}

export default function CanvasGroups({ groups, setGroups, canvasRef, active }: {
  groups: CanvasGroup[];
  setGroups: React.Dispatch<React.SetStateAction<CanvasGroup[]>>;
  canvasRef: RefObject<HTMLElement | null>;
  active: boolean;
}) {
  const { getNodes, setNodes, setEdges, screenToFlowPosition } = useReactFlow();
  const { zoom } = useViewport();
  const [selected, setSelected] = useState("");
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const [menu, setMenu] = useState<GroupMenu | null>(null);
  const drag = useRef<GroupDrag | null>(null);

  const editGroup = useCallback((group: CanvasGroup) => {
    setDraft(group.title);
    setEditing(group.id);
    setMenu(null);
  }, []);

  const selectGroup = useCallback((id: string) => {
    setSelected(id);
    setNodes((nodes) => nodes.map((node) => node.selected ? { ...node, selected: false } : node));
    setEdges((edges) => edges.map((edge) => edge.selected ? { ...edge, selected: false } : edge));
  }, [setEdges, setNodes]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !active) return;
    const contextMenu = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.classList.contains("react-flow__pane")) return;
      event.preventDefault();
      const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
      setSelected("");
      setMenu({ ...position, screenX: event.clientX, screenY: event.clientY, target: canvas });
    };
    const pointerDown = (event: globalThis.PointerEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!event.target.closest(".ff-group-interactive")) {
        setMenu(null);
        if (event.target.closest(".react-flow__node, .react-flow__edge, .react-flow__pane, .react-flow__nodesselection")) {
          setSelected("");
        }
      }
    };
    canvas.addEventListener("contextmenu", contextMenu);
    canvas.addEventListener("pointerdown", pointerDown, true);
    return () => {
      canvas.removeEventListener("contextmenu", contextMenu);
      canvas.removeEventListener("pointerdown", pointerDown, true);
    };
  }, [active, canvasRef, screenToFlowPosition]);

  useEffect(() => {
    if (!active) return;
    const keyDown = (event: KeyboardEvent) => {
      if (groupTypingTarget(event.target)) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "g") {
        if (event.repeat) return;
        const bounds = groupBoundsForNodes(getNodes().filter((node) => node.selected));
        if (!bounds) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        const group = createCanvasGroup(bounds);
        setGroups((current) => [...current, group]);
        selectGroup(group.id);
      } else if (selected && groups.some((group) => group.id === selected)
        && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setGroups((current) => current.filter((group) => group.id !== selected));
        setSelected("");
        setMenu(null);
      }
    };
    window.addEventListener("keydown", keyDown, true);
    return () => window.removeEventListener("keydown", keyDown, true);
  }, [active, getNodes, groups, selectGroup, selected, setGroups]);

  const startDrag = (event: PointerEvent<HTMLElement>, group: CanvasGroup, mode: GroupDrag["mode"]) => {
    if (event.button !== 0 || editing === group.id) return;
    event.preventDefault();
    event.stopPropagation();
    selectGroup(group.id);
    setMenu(null);
    drag.current = {
      id: group.id, mode, group,
      start: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      nodes: new Map((mode === "move" ? nodesInsideGroup(group, getNodes()) : [])
        .map((node) => [node.id, { ...node.position }])),
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const moveDrag = (event: PointerEvent<HTMLElement>) => {
    const current = drag.current;
    if (!current) return;
    const position = screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const dx = position.x - current.start.x;
    const dy = position.y - current.start.y;
    setGroups((groupsNow) => groupsNow.map((group) => group.id !== current.id ? group : current.mode === "move"
      ? { ...group, x: current.group.x + dx, y: current.group.y + dy }
      : { ...group, width: Math.max(GROUP_MIN_WIDTH, current.group.width + dx), height: Math.max(GROUP_MIN_HEIGHT, current.group.height + dy) }));
    if (current.mode === "move") {
      setNodes((nodes) => nodes.map((node) => {
        const original = current.nodes.get(node.id);
        return original ? { ...node, position: { x: original.x + dx, y: original.y + dy } } : node;
      }));
    }
  };

  const finishEdit = (save: boolean) => {
    if (save && editing) setGroups((current) => current.map((group) => group.id === editing
      ? { ...group, title: draft.trim() || "Group" } : group));
    setEditing("");
  };
  const menuGroup = groups.find((group) => group.id === menu?.groupId);

  return (
    <>
    <ViewportPortal>
      <div className="ff-group-layer">
        {groups.map((group) => (
          <div
            key={group.id}
            className={`ff-canvas-group${selected === group.id ? " ff-canvas-group-selected" : ""}`}
            style={{
              left: group.x, top: group.y, width: group.width, height: group.height,
              "--group-color": GROUP_COLORS[group.color],
              "--group-title-color": group.color === "default" ? "var(--accent-contrast)" : "#fff",
              "--group-ui-scale": Math.max(1, 0.8 / zoom),
            } as CSSProperties}
          >
            <div
              className="ff-group-title ff-group-interactive"
              onPointerDown={(event) => startDrag(event, group, "move")}
              onPointerMove={moveDrag}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
              onDoubleClick={(event) => { event.stopPropagation(); editGroup(group); }}
              onContextMenu={(event) => {
                event.preventDefault(); event.stopPropagation(); selectGroup(group.id);
                const target = canvasRef.current;
                if (target) setMenu({ ...screenToFlowPosition({ x: event.clientX, y: event.clientY }), screenX: event.clientX, screenY: event.clientY, target, groupId: group.id });
              }}
            >
              {editing === group.id ? (
                <input
                  autoFocus aria-label="Group title" value={draft}
                  onPointerDown={(event) => event.stopPropagation()}
                  onChange={(event) => setDraft(event.target.value)}
                  onBlur={() => finishEdit(true)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === "Escape") {
                      event.preventDefault(); event.stopPropagation();
                      finishEdit(event.key === "Enter");
                    }
                  }}
                />
              ) : <span>{group.title}</span>}
            </div>
            <button
              type="button" className="ff-group-resize ff-group-interactive" aria-label={`Resize ${group.title}`}
              onPointerDown={(event) => startDrag(event, group, "resize")}
              onPointerMove={moveDrag}
              onPointerUp={() => { drag.current = null; }}
              onPointerCancel={() => { drag.current = null; }}
            />
          </div>
        ))}
      </div>
    </ViewportPortal>
    {menu && createPortal(
          <div className="ff-group-menu ff-group-interactive" style={{ left: Math.max(0, Math.min(menu.screenX, window.innerWidth - 210)), top: Math.max(0, Math.min(menu.screenY, window.innerHeight - (menuGroup ? 190 : 50))) }} onContextMenu={(event) => event.preventDefault()}>
            {menuGroup ? (
              <>
                <button type="button" onClick={() => editGroup(menuGroup)}>Edit title</button>
                <div className="ff-group-palette-label">Color</div>
                <div className="ff-group-palette">
                  {(Object.keys(GROUP_COLORS) as GroupColor[]).map((color) => (
                    <button
                      type="button" key={color} title={color} aria-label={`${color} group color`}
                      aria-pressed={menuGroup.color === color}
                      style={{ background: GROUP_COLORS[color] }}
                      onClick={() => {
                        setGroups((current) => current.map((group) => group.id === menuGroup.id ? { ...group, color } : group));
                        setMenu(null);
                      }}
                    />
                  ))}
                </div>
                <button type="button" onClick={() => {
                  const bounds = groupBoundsForNodes(nodesInsideGroup(menuGroup, getNodes()));
                  if (bounds) setGroups((current) => current.map((group) => group.id === menuGroup.id ? { ...group, ...bounds } : group));
                  setMenu(null);
                }}>Fit group to nodes</button>
                <button type="button" onClick={() => {
                  setGroups((current) => current.filter((group) => group.id !== menuGroup.id));
                  setSelected(""); setMenu(null);
                }}>Remove group</button>
              </>
            ) : (
              <button type="button" onClick={() => {
                const group = createCanvasGroup({ x: menu.x, y: menu.y, width: 400, height: 300 });
                setGroups((current) => [...current, group]);
                selectGroup(group.id); setMenu(null);
              }}>Add group</button>
            )}
          </div>
      , menu.target)}
    </>
  );
}
