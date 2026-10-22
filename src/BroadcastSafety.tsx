import { useEffect, useRef, useState } from "react";
import { RotateCcw } from "lucide-react";
import type { Recording, Webinar } from "../shared/contracts";
import { send } from "./api";
import { Modal, Notice } from "./ui";

export function FinishConfirmation({
  onResume,
  onFinish,
}: {
  onResume: () => void;
  onFinish: () => void;
}) {
  const [deadline] = useState(() => Date.now() + 10000);
  const [seconds, setSeconds] = useState(10);
  const settled = useRef(false);
  const finish = useRef(onFinish);
  finish.current = onFinish;
  function finishNow() {
    if (settled.current) return;
    settled.current = true;
    finish.current();
  }
  useEffect(() => {
    const timer = setInterval(() => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      setSeconds(left);
      if (left === 0) finishNow();
    }, 100);
    return () => clearInterval(timer);
  }, [deadline]);
  return (
    <Modal title="Камера и звук отключены от эфира" onClose={finishNow}>
      <p>
        Зрители досмотрят уже переданное видео. Сейчас передаётся только чёрный
        экран без звука
      </p>
      <p>
        Можно вернуться в эфир или сохранить запись сразу. Через 10 секунд
        завершение подтвердится автоматически
      </p>
      <p className="finish-countdown" role="timer">
        {seconds} сек
      </p>
      <div className="modal-actions">
        <button
          className="btn quiet"
          onClick={() => {
            if (settled.current) return;
            if (Date.now() >= deadline) {
              finishNow();
              return;
            }
            settled.current = true;
            onResume();
          }}
        >
          Вернуться в эфир
        </button>
        <button className="btn danger" onClick={finishNow}>
          Завершить и сохранить
        </button>
      </div>
    </Modal>
  );
}

export function ReopenWebinar({
  event,
  latest,
  support = false,
}: {
  event: Webinar;
  latest?: Recording;
  support?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  if (!latest || !["ended", "failed"].includes(event.state)) return null;
  return (
    <div>
      <button
        className="btn quiet"
        disabled={busy}
        onClick={() => setOpen(true)}
      >
        <RotateCcw size={16} />
        Вернуть в ожидание
      </button>
      {open && (
        <Modal
          title="Вернуть вебинар в ожидание?"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p>
            Ссылка останется прежней. Зрители снова увидят обложку и время
            начала. Презентация, настройки, чат и предыдущие записи сохранятся
          </p>
          <p>
            Новый запуск создаст отдельную запись в этом же вебинаре. Если
            выбран YouTube, будет создана новая трансляция
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="modal-actions">
            <button
              className="btn quiet"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Оставить завершённым
            </button>
            <button
              className="btn primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await send(`/api/events/${event.id}/reopen`, {
                    runId: latest.id,
                    confirm: true,
                  });
                  location.assign(
                    `/${support ? "assist" : "studio"}/${event.id}`,
                  );
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            >
              {busy ? "Возвращаем…" : "Вернуть с прежней ссылкой"}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
