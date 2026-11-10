export function compositorHistoryShortcut(
  event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "shiftKey" | "defaultPrevented" | "isComposing">,
  editingText: boolean,
): "undo" | "redo" | null {
  if (event.defaultPrevented || event.isComposing || editingText || event.altKey || !(event.ctrlKey || event.metaKey)) return null;
  const key = event.key.toLowerCase();
  if (key !== "z" && key !== "y") return null;
  return key === "y" || event.shiftKey ? "redo" : "undo";
}

export class CompositorHistory<T> {
  private undo: T[] = [];
  private redo: T[] = [];

  constructor(private readonly limit: number) {}

  get canUndo() { return this.undo.length > 0; }
  get canRedo() { return this.redo.length > 0; }

  record(snapshot: T) {
    this.undo = [...this.undo, snapshot].slice(-this.limit);
    this.redo = [];
  }

  peek(direction: "undo" | "redo") {
    return (direction === "undo" ? this.undo : this.redo).at(-1);
  }

  complete(direction: "undo" | "redo", current: T) {
    const source = direction === "undo" ? this.undo : this.redo;
    const destination = direction === "undo" ? this.redo : this.undo;
    if (!source.length) throw new Error(`Cannot ${direction}: history is empty.`);
    source.pop();
    destination.push(current);
    if (destination.length > this.limit) destination.shift();
  }
}
