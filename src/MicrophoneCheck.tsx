import { useEffect, useRef, useState } from "react";

// Local only: sample the same processed audio used by the broadcaster.
export function MicrophoneCheck({
  stream,
  onBusy,
}: {
  stream: () => MediaStream | undefined;
  onBusy: (busy: boolean) => void;
}) {
  const [remaining, setRemaining] = useState(0);
  const [url, setUrl] = useState("");
  const [error, setError] = useState("");
  const recorder = useRef<MediaRecorder | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const currentUrl = useRef("");
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (timer.current) clearInterval(timer.current);
      if (recorder.current?.state === "recording") recorder.current.stop();
      URL.revokeObjectURL(currentUrl.current);
      onBusy(false);
    };
  }, [onBusy]);
  function record() {
    if (recorder.current?.state === "recording") return;
    setError("");
    try {
      const audio = stream();
      if (!audio?.getAudioTracks().some((t) => t.readyState === "live"))
        throw new Error("Сначала включите микрофон");
      URL.revokeObjectURL(currentUrl.current);
      setUrl("");
      const mime = ["audio/webm;codecs=opus", "audio/mp4"].find((type) =>
        MediaRecorder.isTypeSupported(type),
      );
      const r = new MediaRecorder(audio, {
        ...(mime ? { mimeType: mime } : {}),
        audioBitsPerSecond: 128000,
      });
      recorder.current = r;
      const chunks: Blob[] = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.push(e.data);
      };
      r.onerror = () => {
        if (mounted.current)
          setError("Не удалось записать пробу — повторите проверку");
      };
      r.onstop = () => {
        if (timer.current) clearInterval(timer.current);
        if (!mounted.current) return;
        setRemaining(0);
        onBusy(false);
        if (!chunks.length) return;
        currentUrl.current = URL.createObjectURL(
          new Blob(chunks, { type: r.mimeType }),
        );
        setUrl(currentUrl.current);
      };
      r.start();
      onBusy(true);
      setRemaining(6);
      const end = Date.now() + 6000;
      timer.current = setInterval(() => {
        const seconds = Math.max(0, Math.ceil((end - Date.now()) / 1000));
        setRemaining(seconds);
        if (!seconds && r.state === "recording") r.stop();
      }, 200);
    } catch {
      onBusy(false);
      setError("Пробная запись недоступна. Проверьте микрофон и повторите");
    }
  }
  return (
    <div className="microphone-check">
      <button
        className="btn quiet small"
        disabled={remaining > 0}
        onClick={record}
      >
        {remaining ? `Говорите… ${remaining} с` : "Проверить микрофон"}
      </button>
      {url && (
        <audio controls src={url} aria-label="Прослушать пробу микрофона" />
      )}
      <small>
        {error ||
          "Необязательно · 6 секунд записи, затем прослушайте в наушниках"}
      </small>
    </div>
  );
}
