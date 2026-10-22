import { useEffect, useRef, useState, type RefObject } from "react";
import { fitCameraBox, type CameraBox } from "../shared/camera";

export function CameraPosition({
  canvas,
  box,
  onChange,
  onCommit,
}: {
  canvas: RefObject<HTMLCanvasElement | null>;
  box: CameraBox;
  onChange: (box: CameraBox) => void;
  onCommit: (box: CameraBox) => void;
}) {
  const [size, setSize] = useState({ left: 0, top: 0, width: 0, height: 0 });
  const gesture = useRef<{
    x: number;
    y: number;
    box: CameraBox;
    resize: boolean;
  } | null>(null);
  const latest = useRef(box);
  latest.current = box;
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const update = () => {
      const r = el.getBoundingClientRect(),
        parent = el.parentElement!.getBoundingClientRect();
      setSize({
        left: r.left - parent.left,
        top: r.top - parent.top,
        width: r.width,
        height: r.height,
      });
    };
    const observer = new ResizeObserver(update);
    observer.observe(el);
    observer.observe(el.parentElement!);
    update();
    return () => observer.disconnect();
  }, [canvas]);
  return (
    <div
      className="camera-position"
      role="group"
      aria-label="Положение камеры"
      style={{
        left: size.left + box.x * size.width,
        top: size.top + box.y * size.height,
        width: box.width * size.width,
        height: box.width * size.height,
      }}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        gesture.current = {
          x: e.clientX,
          y: e.clientY,
          box: { ...box },
          resize: (e.target as HTMLElement).closest("[data-resize]") !== null,
        };
      }}
      onPointerMove={(e) => {
        const g = gesture.current;
        if (!g || !size.width) return;
        const dx = (e.clientX - g.x) / size.width,
          dy = (e.clientY - g.y) / size.height;
        const next = fitCameraBox(
          g.resize
            ? {
                ...g.box,
                width: g.box.width + (Math.abs(dx) > Math.abs(dy) ? dx : dy),
              }
            : { ...g.box, x: g.box.x + dx, y: g.box.y + dy },
        );
        latest.current = next;
        onChange(next);
      }}
      onPointerUp={() => {
        if (gesture.current) {
          gesture.current = null;
          onCommit(latest.current);
        }
      }}
      onPointerCancel={() => {
        if (gesture.current) {
          gesture.current = null;
          onCommit(latest.current);
        }
      }}
    >
      <button
        className="camera-drag"
        aria-label="Переместить камеру"
        title="Перетащите камеру или используйте стрелки на клавиатуре"
        onKeyDown={(e) => {
          const delta = (e.shiftKey ? 20 : 5) / size.width;
          let next = box;
          if (e.key === "ArrowLeft") next = { ...box, x: box.x - delta };
          else if (e.key === "ArrowRight") next = { ...box, x: box.x + delta };
          else if (e.key === "ArrowUp") next = { ...box, y: box.y - delta };
          else if (e.key === "ArrowDown") next = { ...box, y: box.y + delta };
          else return;
          e.preventDefault();
          next = fitCameraBox(next);
          onChange(next);
          onCommit(next);
        }}
      >
        Переместить
      </button>
      <span
        data-resize
        className="camera-resize"
        aria-hidden="true"
        title="Изменить размер"
      />
    </div>
  );
}
