import { ReopenWebinar } from "./BroadcastSafety";
import {
  YouTubeRecordingLink,
  RecordingStorageStatus,
} from "./BroadcastIdentity";
import { useEffect, useState } from "react";
import { Copy, Download, ArrowLeft, FileText } from "lucide-react";
import type { Message, Recording, RoomSnapshot } from "../shared/contracts";
import { recordingExpired } from "../shared/retention";
import { api, assetUrl, send, useRoom } from "./api";
import { Badge, Chat, Header, Notice, displayLabel } from "./ui";

export function durationLabel(seconds: number | null) {
  if (seconds === null) return "Длительность уточняется";
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)} ч ${minutes % 60} мин`
    : minutes > 0
      ? `${minutes} мин ${Math.floor(seconds % 60)} сек`
      : `${Math.floor(seconds)} сек`;
}
export function DownloadDeadline({ recording: r }: { recording: Recording }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);
  if (!r.expiresAt)
    return (
      <div className="download-deadline">
        <strong>7 дней на скачивание</strong>
        <span>Срок начнётся после подготовки файла</span>
      </div>
    );
  const remaining = Date.parse(r.expiresAt) - now;
  const days = Math.ceil(remaining / 86400000);
  return (
    <div
      className={`download-deadline ${remaining <= 86400000 ? "urgent" : ""}`}
    >
      <span>{remaining <= 0 ? "Срок хранения истёк" : "Скачать до"}</span>
      <strong>
        {new Date(r.expiresAt).toLocaleString("ru", {
          day: "numeric",
          month: "long",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          timeZoneName: "short",
        })}
      </strong>
      <span>
        {remaining <= 0
          ? "Запись больше недоступна"
          : remaining < 86400000
            ? "Осталось меньше суток"
            : `Осталось дней: ${days}`}{" "}
        · после срока файл удаляется
      </span>
    </div>
  );
}
export function DuplicateButton({ id }: { id: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  return (
    <div>
      <button
        className="btn quiet"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          setError("");
          try {
            const w = await send(`/api/events/${id}/duplicate`);
            location.assign(`/event/${w.id}`);
          } catch (e) {
            setError((e as Error).message);
            setBusy(false);
          }
        }}
      >
        <Copy size={16} />
        {busy ? "Создаём копию…" : "Создать копию"}
      </button>
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
export function Archive({ id }: { id: string }) {
  const room = useRoom(id);
  if (!room.data)
    return (
      <>
        <Header />
        <main className="page">
          <Notice>{room.error || "Открываем историю вебинара…"}</Notice>
        </main>
      </>
    );
  if (room.data.event.state !== "ended")
    return (
      <>
        <Header />
        <main className="page">
          <Notice>Вебинар ещё не завершён</Notice>
          <a className="btn quiet" href={`/studio/${id}`}>
            Открыть студию
          </a>
        </main>
      </>
    );
  return <ArchiveContent data={room.data} connected={room.connected} />;
}
export function ArchiveContent({
  data,
  connected,
  support = false,
}: {
  data: RoomSnapshot;
  connected: boolean;
  support?: boolean;
}) {
  const w = data.event;
  const [older, setOlder] = useState<Message[]>([]);
  const [hasOlder, setHasOlder] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const messages = [...older, ...data.messages].filter(
    (m, i, all) => all.findIndex((x) => x.id === m.id) === i,
  );
  return (
    <>
      <Header />
      <main className="page webinar-archive">
        <div className="breadcrumb">
          <a href="/">
            <ArrowLeft size={14} />
            Вебинары
          </a>
          <span>/</span>
          <span>История вебинара</span>
        </div>
        <a className="btn small" href={`/statistics?event=${w.id}`}>
          Статистика вебинара
        </a>
        <div className="page-heading">
          <div>
            <Badge state={w.state} />
            <h1>{displayLabel(w.title)}</h1>
            <p>
              {w.hostName} · {w.description}
            </p>
          </div>
          <div className="modal-actions">
            <ReopenWebinar
              event={w}
              latest={data.recordings[0]}
              support={support}
            />
            {!support && <DuplicateButton id={w.id} />}
          </div>
        </div>
        <Notice>
          <strong>Вебинар завершён — спасибо за ваш эфир!</strong>
          <br />
          Здесь — записи, презентация и история чата. Если завершили случайно,
          верните вебинар в ожидание — ссылка останется прежней. Для другого
          вебинара создайте копию с новой ссылкой
        </Notice>
        <div className="archive-layout">
          <section className="archive-history">
            {messages.length >= 80 && hasOlder && (
              <button
                className="btn quiet small"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    const rows = await api<Message[]>(
                      `/api/events/${w.id}/chat?before=${encodeURIComponent(messages[0].at)}&beforeId=${encodeURIComponent(messages[0].id)}`,
                    );
                    setOlder((prev) => [...rows, ...prev]);
                    setHasOlder(rows.length === 80);
                  } catch (e) {
                    setError((e as Error).message);
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                {busy ? "Загружаем…" : "Показать более ранние сообщения"}
              </button>
            )}
            <Chat
              event={w}
              messages={messages}
              online={0}
              connected={connected}
              readOnly
            />
            {error && <Notice tone="error">{error}</Notice>}
          </section>
          <section className="archive-content">
            {data.recordings.length === 0 && (
              <Notice>Записей этого вебинара пока нет</Notice>
            )}
            {data.recordings.map((r, index) => (
              <article className="archive-recording" key={r.id}>
                <div className="section-title">
                  <h2>
                    {data.recordings.length > 1
                      ? `Передача ${data.recordings.length - index}`
                      : "Запись вебинара"}
                  </h2>
                  <span>{durationLabel(r.duration)}</span>
                </div>
                <p>
                  {new Date(r.createdAt).toLocaleString("ru")} ·{" "}
                  <a href={`/statistics?event=${w.id}&run=${r.id}`}>
                    Статистика этой передачи
                  </a>
                </p>
                {r.hasFile && !recordingExpired(r) ? (
                  <video
                    controls
                    playsInline
                    preload="metadata"
                    src={`/api/events/${w.id}/recordings/${r.id}`}
                  />
                ) : (
                  <Notice>
                    {recordingExpired(r)
                      ? "Срок хранения записи истёк"
                      : r.state === "failed"
                        ? "Не удалось подготовить запись"
                        : "Готовим запись — она появится здесь автоматически"}
                  </Notice>
                )}
                {r.state === "incomplete" && (
                  <Notice>
                    Запись содержит пропуски из-за перерывов связи
                  </Notice>
                )}
                <div className="archive-recording-actions">
                  <DownloadDeadline recording={r} />
                  {r.hasFile && !recordingExpired(r) && (
                    <a
                      className="btn primary"
                      href={`/api/events/${w.id}/recordings/${r.id}/download`}
                    >
                      <Download size={16} />
                      Скачать запись
                    </a>
                  )}
                </div>
                <RecordingStorageStatus recording={r} />
                <YouTubeRecordingLink youtube={r.youtube} />
              </article>
            ))}
            {w.pdfId && (
              <a
                className="btn quiet"
                href={assetUrl(w.id, w.pdfId)}
                target="_blank"
                rel="noreferrer"
              >
                <FileText size={16} />
                Открыть презентацию
              </a>
            )}
            {w.ctaUrl && (
              <div className="archive-offer">
                <h2>Предложение зрителям</h2>
                <p>{w.ctaDescription}</p>
                <a href={w.ctaUrl} target="_blank" rel="noreferrer">
                  {w.ctaTitle || "Открыть предложение"}
                </a>
              </div>
            )}
          </section>
        </div>
      </main>
    </>
  );
}
