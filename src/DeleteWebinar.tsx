import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Modal, Notice } from "./ui";
import { send } from "./api";
import type { Webinar } from "../shared/contracts";
export function DeleteWebinar({
  webinar,
  admin = false,
  onDeleted,
}: {
  webinar: Pick<Webinar, "id" | "title" | "state">;
  admin?: boolean;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const active = ["starting", "live", "reconnecting", "stopping"].includes(
    webinar.state,
  );
  return (
    <>
      <button
        className="btn quiet small"
        disabled={active}
        title={active ? "Сначала завершите эфир" : "Удалить вебинар"}
        onClick={() => {
          setError("");
          setOpen(true);
        }}
      >
        <Trash2 size={15} /> Удалить
      </button>
      {open && (
        <Modal
          title="Удалить вебинар?"
          onClose={() => {
            if (!busy) setOpen(false);
          }}
        >
          <p>
            <strong>{webinar.title}</strong>
          </p>
          <p>
            Вебинар, чат и доступ к записям исчезнут из кабинета. Ссылка зрителя
            перестанет работать. Сначала скачайте нужные записи
          </p>
          <p className="muted">
            Облачные записи удалятся по обычному сроку хранения. Копия на
            YouTube останется
          </p>
          {error && <Notice tone="error">{error}</Notice>}
          <div className="modal-actions">
            <button
              className="btn quiet"
              disabled={busy}
              onClick={() => setOpen(false)}
            >
              Отмена
            </button>
            <button
              className="btn danger"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setError("");
                try {
                  await send(
                    admin
                      ? `/api/admin/webinars/${webinar.id}`
                      : `/api/events/${webinar.id}`,
                    { confirm: true },
                    "DELETE",
                  );
                  setOpen(false);
                  onDeleted();
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? "Удаляем…" : "Удалить вебинар"}
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
