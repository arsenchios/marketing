import { useEffect, useState, useCallback, useRef } from "react";
import type { RoomSnapshot } from "../shared/contracts";
export const guestMode = () => typeof location !== "undefined" && location.pathname.startsWith("/guest/");
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...options,
      headers: {
        ...(guestMode() ? {"X-Webinar-Guest":"1"} : {}),
        ...(options.body instanceof FormData
          ? {}
          : { "Content-Type": "application/json" }),
        ...options.headers,
      },
    });
  } catch (cause) {
    throw Object.assign(
      new Error(
        "Не удалось получить ответ сервера. Проверьте интернет — действие могло уже выполниться",
      ),
      { cause, network: true },
    );
  }
  let body: any;
  try {
    body = await res.json();
  } catch {
    throw Object.assign(
      new Error(
        "Сервер временно не отвечает. Попробуйте проверить состояние ещё раз",
      ),
      { status: res.status },
    );
  }
  if (!res.ok)
    throw Object.assign(
      new Error(body.error || "Не удалось связаться с сервером"),
      { status: res.status,
        recoveryUrl: typeof body.recoveryUrl === "string" && /^\/studio\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.recoveryUrl)
          ? body.recoveryUrl : undefined,
      },
    );
  return body;
}
export const send = (path: string, body: unknown = {}, method = "POST") =>
  api(path, { method, body: JSON.stringify(body) });
export function useRoom(id: string, viewer = false) {
  const [data, setData] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const denied = useRef(false);
  const revision = useRef(0);
  const endpoint = viewer ? `/api/room/${id}` : `/api/events/${id}`;
  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const d = await api<RoomSnapshot>(endpoint, {
        signal: AbortSignal.timeout(10000),
      });
      if (request !== revision.current) return d;
      denied.current = false;
      setData(d);
      setError("");
      return d;
    } catch (e) {
      if (request !== revision.current) return null;
      denied.current = [401, 403, 404].includes(
        (e as Error & { status: number }).status,
      );
      if (denied.current) setData(null);
      setError((e as Error).message);
      return null;
    }
  }, [endpoint]);
  useEffect(() => {
    let disposed = false;
    let ws: WebSocket | undefined;
    let timer: ReturnType<typeof setTimeout>;
    let handshake: ReturnType<typeof setTimeout>;
    let attempt = 0;
    let connecting = false;
    denied.current = false;
    setConnected(false);
    function retry() {
      clearTimeout(timer);
      if (!disposed && !denied.current)
        timer = setTimeout(
          connect,
          Math.min(15000, 1000 * 2 ** attempt++) + Math.random() * 300,
        );
    }
    async function connect() {
      if (disposed || connecting || denied.current || (ws && ws.readyState < 2))
        return;
      connecting = true;
      try {
        const d = await refresh();
        if (disposed) return;
        if (!d || denied.current) {
          retry();
          return;
        }
        const socket = new WebSocket(
          `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/room?event=${d.event.id}${viewer ? "&view=1" : guestMode() ? "&guest=1" : ""}`,
        );
        ws = socket;
        handshake = setTimeout(() => {
          if (socket.readyState === WebSocket.CONNECTING) socket.close();
        }, 12000);
        socket.onopen = () => {
          clearTimeout(handshake);
          if (!disposed) {
            attempt = 0;
            setConnected(true);
          }
        };
        socket.onmessage = (e) => {
          if (disposed || ws !== socket || denied.current) return;
          try {
            const msg = JSON.parse(e.data);
            if (msg.type === "snapshot") {
              revision.current++;
              setData(msg);
              setError("");
            }
          } catch {
            /* Ignore malformed messages; the next snapshot can recover. */
          }
        };
        socket.onclose = (e) => {
          clearTimeout(handshake);
          if (disposed || ws !== socket) return;
          setConnected(false);
          if (e.code === 4003) {
            denied.current = true;
            revision.current++;
            setData(null);
            setError("Доступ к комнате закрыт или срок входа истёк");
            return;
          }
          retry();
        };
      } catch {
        retry();
      } finally {
        connecting = false;
      }
    }
    function resume() {
      if (disposed || denied.current) return;
      if (ws?.readyState === WebSocket.OPEN) void refresh();
      else {
        clearTimeout(timer);
        void connect();
      }
    }
    function visible() {
      if (!document.hidden) resume();
    }
    // A host can still learn that Finish succeeded even if a socket update was lost.
    const poll = setInterval(() => {
      if (!document.hidden && (!viewer || ws?.readyState !== WebSocket.OPEN))
        resume();
    }, 15000);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", visible);
    void connect();
    return () => {
      disposed = true;
      revision.current++;
      clearTimeout(timer);
      clearInterval(poll);
      clearTimeout(handshake);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", visible);
      ws?.close();
    };
  }, [refresh, viewer]);
  return { data, error, connected, refresh };
}
export const assetUrl = (event: string, id: string) =>
  `/api/events/${event}/assets/${id}${guestMode() ? "?guest=1" : ""}`;
export const dateLabel = (date: string, timezone: string) =>
  date
    ? new Intl.DateTimeFormat("ru", {
        day: "numeric",
        month: "long",
        hour: "2-digit",
        minute: "2-digit",
        timeZone: timezone,
      }).format(new Date(date))
    : "Дата пока не назначена";
