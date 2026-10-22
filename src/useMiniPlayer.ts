import { useEffect, useRef, useState, type PointerEvent } from "react";

// Layout changes only: never move/recreate the iframe while dragging the in-page player.
export function useMiniPlayer(active: boolean) {
  const [box, setBox] = useState({ x: 12, y: 12, width: 380 });
  const boxRef = useRef(box);
  boxRef.current = box;
  const fit = (b: typeof box) => {
    const width = Math.min(
      Math.max(280, b.width),
      Math.max(160, innerWidth - 24),
      800,
    );
    const height = Math.max(200, (width * 9) / 16) + 148;
    return {
      width,
      x: Math.max(0, Math.min(b.x, innerWidth - width)),
      y: Math.max(0, Math.min(b.y, innerHeight - height)),
    };
  };
  useEffect(() => {
    if (!active) return;
    setBox((b) => fit({ ...b, x: innerWidth - b.width - 12 }));
    const resize = () => setBox((b) => fit(b));
    window.addEventListener("resize", resize);
    return () => window.removeEventListener("resize", resize);
  }, [active]);
  const gesture = useRef<{
    x: number;
    y: number;
    box: typeof box;
    resize: boolean;
  } | null>(null);
  function down(e: PointerEvent<HTMLElement>, resize = false) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    gesture.current = {
      x: e.clientX,
      y: e.clientY,
      box: boxRef.current,
      resize,
    };
  }
  function move(e: PointerEvent<HTMLElement>) {
    const g = gesture.current;
    if (!g) return;
    setBox(
      fit(
        g.resize
          ? { ...g.box, width: g.box.width + e.clientX - g.x }
          : {
              ...g.box,
              x: g.box.x + e.clientX - g.x,
              y: g.box.y + e.clientY - g.y,
            },
      ),
    );
  }
  const handlers = {
    onPointerMove: move,
    onPointerUp: () => {
      gesture.current = null;
    },
    onPointerCancel: () => {
      gesture.current = null;
    },
    onLostPointerCapture: () => {
      gesture.current = null;
    },
  };
  return {
    style: active
      ? { left: box.x, top: box.y, width: box.width, right: "auto" }
      : undefined,
    drag: {
      ...handlers,
      onPointerDown: (e: PointerEvent<HTMLElement>) => down(e),
    },
    resize: {
      ...handlers,
      onPointerDown: (e: PointerEvent<HTMLElement>) => down(e, true),
    },
    grow: (delta: number) =>
      setBox((b) => fit({ ...b, width: b.width + delta })),
  };
}
