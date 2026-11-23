// Drag to reorder, on the web: react-native-web views are DOM nodes, so rows use the browser's own
// drag and drop. A click still opens the row, and the browser draws the drag image.

import { useEffect, useRef, useState, type RefObject } from "react";
import { Platform } from "react-native";

interface DragEventLike {
  clientY: number;
  relatedTarget: unknown;
  dataTransfer: {
    effectAllowed: string;
    dropEffect: string;
    setData(type: string, data: string): void;
  } | null;
  preventDefault(): void;
}

interface DomNode {
  draggable: boolean;
  addEventListener(type: string, listener: (event: DragEventLike) => void): void;
  removeEventListener(type: string, listener: (event: DragEventLike) => void): void;
  getBoundingClientRect(): { top: number; height: number };
  contains(node: unknown): boolean;
}

/** What is being dragged: a drag's data can't be read before the drop. */
let dragging: { list: string; key: string } | null = null;

export type DropSide = "before" | "after";

/**
 * Makes `source` draggable as `key` of `list`, and `target` (the source by default) a drop spot for
 * the list's other keys. Returns the side a drop would land on, for the indicator line.
 */
export function useReorder(options: {
  source: RefObject<unknown>;
  target?: RefObject<unknown>;
  list: string;
  key: string;
  enabled: boolean;
  onStart?(): void;
  onMove(from: string, to: string, after: boolean): void;
}): DropSide | null {
  const [side, setSide] = useState<DropSide | null>(null);
  const latest = useRef(options);
  latest.current = options;
  const { source, target = source, list, key, enabled } = options;
  useEffect(() => {
    const from = source.current as DomNode | null;
    const to = target.current as DomNode | null;
    if (Platform.OS !== "web" || !enabled || !from || !to) return;
    const accepts = () => dragging?.list === list && dragging.key !== key;
    const sideOf = (event: DragEventLike): DropSide => {
      const rect = to.getBoundingClientRect();
      return event.clientY > rect.top + rect.height / 2 ? "after" : "before";
    };
    const start = (event: DragEventLike) => {
      dragging = { list, key };
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", key);
      }
      latest.current.onStart?.();
    };
    const end = () => {
      dragging = null;
    };
    const over = (event: DragEventLike) => {
      if (!accepts()) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      setSide(sideOf(event));
    };
    const leave = (event: DragEventLike) => {
      if (!to.contains(event.relatedTarget)) setSide(null);
    };
    const drop = (event: DragEventLike) => {
      setSide(null);
      if (!dragging || !accepts()) return;
      event.preventDefault();
      latest.current.onMove(dragging.key, key, sideOf(event) === "after");
      dragging = null;
    };
    from.draggable = true;
    from.addEventListener("dragstart", start);
    from.addEventListener("dragend", end);
    to.addEventListener("dragover", over);
    to.addEventListener("dragleave", leave);
    to.addEventListener("drop", drop);
    return () => {
      from.draggable = false;
      from.removeEventListener("dragstart", start);
      from.removeEventListener("dragend", end);
      to.removeEventListener("dragover", over);
      to.removeEventListener("dragleave", leave);
      to.removeEventListener("drop", drop);
      setSide(null);
    };
  }, [source, target, list, key, enabled]);
  return side;
}
