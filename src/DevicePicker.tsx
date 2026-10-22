import { useEffect, useRef } from "react";
import { Check, ChevronDown } from "lucide-react";

export function DevicePicker({
  label,
  value,
  devices,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  devices: MediaDeviceInfo[];
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node))
        ref.current?.removeAttribute("open");
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && ref.current?.open) {
        event.stopImmediatePropagation();
        ref.current.open = false;
        ref.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    window.addEventListener("keydown", escape, true);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("keydown", escape, true);
    };
  }, []);
  useEffect(() => {
    if (disabled && ref.current) ref.current.open = false;
  }, [disabled]);
  const options = [{ deviceId: "", label: "По умолчанию" }, ...devices];
  return (
    <details ref={ref} className="device-picker">
      <summary
        aria-label={label}
        aria-disabled={disabled}
        onClick={(e) => {
          if (disabled) e.preventDefault();
        }}
      >
        <span>
          {options.find((d) => d.deviceId === value)?.label || "По умолчанию"}
        </span>
        <ChevronDown size={13} />
      </summary>
      <div className="device-options" role="group" aria-label={label}>
        {options.map((d, i) => (
          <button
            type="button"
            key={d.deviceId}
            disabled={disabled}
            aria-pressed={value === d.deviceId}
            onClick={() => {
              onChange(d.deviceId);
              if (ref.current) {
                ref.current.open = false;
                ref.current.querySelector("summary")?.focus();
              }
            }}
          >
            <span>{d.label || `Устройство ${i}`}</span>
            {value === d.deviceId && <Check size={14} />}
          </button>
        ))}
      </div>
    </details>
  );
}
