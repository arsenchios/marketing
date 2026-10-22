import { useEffect, useRef, useState } from "react";
import { SpeakerCall } from "./speakerCall";
import type { Compositor } from "./compositor";

export function RemoteAudio({ stream }: { stream: MediaStream | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const el = audio.current!;
    el.srcObject = stream;
    if (stream)
      void el
        .play()
        .then(() => setBlocked(false))
        .catch(() => setBlocked(true));
    return () => {
      el.pause();
      el.srcObject = null;
    };
  }, [stream]);
  return (
    <>
      <audio ref={audio} autoPlay />
      {blocked && (
        <button
          className="btn quiet small"
          onClick={() =>
            void audio.current
              ?.play()
              .then(() => setBlocked(false))
              .catch(() => setBlocked(true))
          }
        >
          Слышать собеседника
        </button>
      )}
    </>
  );
}
export function SpeakerPanel({
  id,
  tab,
  compositor,
  ready,
  role = "primary",
}: {
  id: string;
  tab: string;
  compositor: React.RefObject<Compositor | null>;
  ready: boolean;
  role?: "primary" | "guest";
}) {
  const call = useRef<SpeakerCall | null>(null);
  const [remote, setRemote] = useState<MediaStream | null>(null);
  const [status, setStatus] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!ready) return;
    const c = new SpeakerCall(
      id,
      role,
      tab,
      () => compositor.current?.peerStream() || null,
      (stream) => {
        compositor.current?.setGuest(stream);
        setRemote(stream);
      },
      setStatus,
      (enabled) => { if (compositor.current) compositor.current.guestCameraOn = enabled; },
    );
    call.current = c;
    void c.start().catch((e) => setStatus(e.message));
    return () => {
      c.dispose();
      call.current = null;
    };
  }, [ready, id, tab, role, retry]);
  return (
    <div className="speaker-connection" aria-live="polite">
      {ready && <small>{status}</small>}
      {ready && /Не удалось|закрыто|занято/.test(status) && <button className="btn quiet small" onClick={() => setRetry((n) => n + 1)}>Подключить повторно</button>}
      <RemoteAudio stream={remote} />
    </div>
  );
}
