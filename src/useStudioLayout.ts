import { useEffect, useState } from "react";
export function useStudioLayout(active: boolean) {
  const [focused, setFocused] = useState(false);
  const [mobile, setMobile] = useState(
    () => window.matchMedia("(max-width: 1024px)").matches,
  );
  const [chatVisible, setChatVisible] = useState(
    () => !window.matchMedia("(max-width: 1024px)").matches,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1024px)");
    const change = () => {
      setMobile(media.matches);
      setChatVisible(!media.matches);
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  useEffect(() => {
    if (!mobile || !chatVisible) return;
    const escape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !document.querySelector("dialog[open]")) {
        e.stopImmediatePropagation();
        setChatVisible(false);
      }
    };
    window.addEventListener("keydown", escape, true);
    return () => window.removeEventListener("keydown", escape, true);
  }, [mobile, chatVisible]);
  const [chatWidth, setChatWidth] = useState(() => {
    try {
      const n = Number(localStorage.getItem("studio-chat-width"));
      return n >= 240 && n <= 440 ? n : 290;
    } catch {
      return 290;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("studio-chat-width", String(chatWidth));
    } catch {}
  }, [chatWidth]);
  useEffect(() => {
    if (!focused) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const escape = (e: KeyboardEvent) => {
      if (
        e.key === "Escape" &&
        !document.querySelector('dialog[open], [role="dialog"]')
      )
        setFocused(false);
    };
    window.addEventListener("keydown", escape);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", escape);
    };
  }, [focused]);
  useEffect(() => {
    if (!active || !("wakeLock" in navigator)) return;
    let cancelled = false;
    let lock: WakeLockSentinel | undefined;
    let acquiring = false;
    const acquire = async () => {
      if (cancelled || acquiring || document.hidden || (lock && !lock.released))
        return;
      acquiring = true;
      try {
        const next = await navigator.wakeLock.request("screen");
        if (cancelled) await next.release();
        else lock = next;
      } catch {
      } finally {
        acquiring = false;
      }
    };
    void acquire();
    document.addEventListener("visibilitychange", acquire);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", acquire);
      void lock?.release();
    };
  }, [active]);
  return {
    focused,
    mobile,
    setFocused,
    chatVisible,
    setChatVisible,
    chatWidth,
    setChatWidth,
  };
}
