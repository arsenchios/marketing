import { useState } from "react";
import {
  Pencil,
  Send,
  Plus,
  Trash2,
  MessageSquare,
  Radio,
  X,
  Check,
} from "lucide-react";
import {
  defaultChatTemplates,
  type ChatTemplate,
  type Webinar,
} from "../shared/contracts";
import { send } from "./api";
import { Modal, Notice } from "./ui";

export function StudioEngagement({
  event: w,
  refresh,
  section,
  onInsert,
}: {
  event: Webinar;
  refresh: () => Promise<unknown>;
  section: "offer" | "templates";
  onInsert: (text: string) => void;
}) {
  const [editOffer, setEditOffer] = useState(false);
  const [editTemplates, setEditTemplates] = useState(false);
  const [offer, setOffer] = useState({
    ctaTitle: w.ctaTitle,
    ctaDescription: w.ctaDescription,
    ctaUrl: w.ctaUrl,
  });
  const [drafts, setDrafts] = useState<ChatTemplate[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const templates = w.chatTemplates ?? defaultChatTemplates;
  const locked = w.state === "stopping" || w.state === "ended";
  async function action(fn: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function insert(text: string) {
    onInsert(text);
  }
  return (
    <section
      className={`engagement-panel engagement-${section}`}
      aria-label={
        section === "offer" ? "Предложение зрителям" : "Заготовки сообщений"
      }
    >
      {section === "offer" && (
        <div className="live-offer">
          <div>
            <span className="eyebrow">
              <Radio size={14} />
              ПРЕДЛОЖЕНИЕ ВО ВРЕМЯ ЭФИРА
            </span>
            <h3>
              {!w.ctaTitle || w.ctaTitle === "Продолжим знакомство"
                ? "Ваше предложение"
                : w.ctaTitle}
            </h3>
            <p>
              {(w.ctaDescription ===
              "Все подробности и следующий шаг — по ссылке."
                ? ""
                : w.ctaDescription) ||
                "Курс, услуга или материал: добавьте текст кнопки и ссылку"}
            </p>
            {w.ctaVisible && (
              <small className="offer-visible">
                <Check size={13} />
                Сейчас видно зрителям
              </small>
            )}
          </div>
          <div className="engagement-actions">
            <button
              className="btn quiet small"
              disabled={busy || locked}
              onClick={() => {
                setOffer({
                  ctaTitle: w.ctaTitle,
                  ctaDescription: w.ctaDescription,
                  ctaUrl: w.ctaUrl,
                });
                setError("");
                setEditOffer(true);
              }}
            >
              <Pencil size={15} />
              Настроить предложение
            </button>
            <button
              className={`btn ${w.ctaVisible ? "quiet" : "primary"} small`}
              disabled={busy || locked || !w.ctaUrl}
              onClick={() =>
                void action(async () => {
                  await send(
                    `/api/events/${w.id}/stage`,
                    { ctaVisible: !w.ctaVisible },
                    "PATCH",
                  );
                  await refresh();
                })
              }
            >
              {w.ctaVisible ? "Скрыть предложение" : "Показать предложение"}
            </button>
            <button
              className="btn quiet small"
              disabled={busy || locked || !w.ctaUrl}
              onClick={() =>
                insert(
                  [w.ctaTitle, w.ctaDescription, w.ctaUrl]
                    .filter(Boolean)
                    .join("\n"),
                )
              }
            >
              <Pencil size={15} />
              Вставить в чат
            </button>
          </div>
        </div>
      )}
      {section === "templates" && (
        <div className="chat-shortcuts">
          <div className="shortcut-heading">
            <h3>
              <MessageSquare size={17} />
              Заготовки сообщений
            </h3>
            <button
              className="text-link"
              disabled={busy || locked}
              onClick={() => {
                setDrafts(templates.map((t) => ({ ...t })));
                setError("");
                setEditTemplates(true);
              }}
            >
              <Pencil size={14} />
              Настроить
            </button>
          </div>
          <p>Вставьте в поле, измените и отправьте</p>
          <div className="shortcut-buttons">
            {w.welcome && (
              <button
                disabled={busy || locked}
                title={w.welcome}
                onClick={() => insert(w.welcome)}
              >
                Приветствие
                <Plus size={13} />
              </button>
            )}
            {templates.map((t) => (
              <button
                key={t.id}
                disabled={busy || locked}
                title={t.text}
                onClick={() => insert(t.text)}
              >
                {t.title}
                <Plus size={13} />
              </button>
            ))}
          </div>
        </div>
      )}
      {error && !editOffer && !editTemplates && (
        <Notice tone="error">{error}</Notice>
      )}
      {editOffer && (
        <Modal
          title="Предложение зрителям"
          onClose={() => {
            if (!busy) setEditOffer(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await send(`/api/events/${w.id}/offer`, offer, "PATCH");
                await refresh();
                setEditOffer(false);
              });
            }}
          >
            {w.ctaVisible && (
              <Notice>
                Изменения сразу появятся у зрителей — предложение уже показано
              </Notice>
            )}
            <label className="field">
              Текст кнопки
              <input
                required
                maxLength={80}
                placeholder="Например, записаться на курс"
                value={offer.ctaTitle}
                onChange={(e) =>
                  setOffer({ ...offer, ctaTitle: e.target.value })
                }
              />
            </label>
            <label className="field">
              Описание
              <textarea
                aria-label="Описание"
                maxLength={240}
                rows={2}
                placeholder="Что получат зрители: курс, консультация или материал"
                value={offer.ctaDescription}
                onChange={(e) =>
                  setOffer({ ...offer, ctaDescription: e.target.value })
                }
              />
            </label>
            <label className="field">
              Ссылка
              <input
                type="url"
                maxLength={2000}
                value={offer.ctaUrl}
                placeholder="https://…"
                onChange={(e) => setOffer({ ...offer, ctaUrl: e.target.value })}
              />
            </label>
            {error && <Notice tone="error">{error}</Notice>}
            <button className="btn primary" disabled={busy || locked}>
              Сохранить предложение
            </button>
          </form>
        </Modal>
      )}
      {editTemplates && (
        <Modal
          title="Заготовки сообщений"
          onClose={() => {
            if (!busy) setEditTemplates(false);
          }}
        >
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void action(async () => {
                await send(
                  `/api/events/${w.id}/chat-templates`,
                  { templates: drafts },
                  "PATCH",
                );
                await refresh();
                setEditTemplates(false);
              });
            }}
          >
            <p className="muted">
              Это ваши заготовки. Зрители увидят текст только после отправки в
              чат
            </p>
            <div className="template-editor">
              {drafts.map((t, i) => (
                <div className="template-row" key={t.id}>
                  <label className="field">
                    Название
                    <input
                      required
                      maxLength={40}
                      value={t.title}
                      onChange={(e) =>
                        setDrafts(
                          drafts.map((v, n) =>
                            n === i ? { ...v, title: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <label className="field">
                    Сообщение
                    <textarea
                      aria-label="Сообщение"
                      required
                      rows={3}
                      maxLength={1000}
                      value={t.text}
                      onChange={(e) =>
                        setDrafts(
                          drafts.map((v, n) =>
                            n === i ? { ...v, text: e.target.value } : v,
                          ),
                        )
                      }
                    />
                  </label>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={`Удалить заготовку ${i + 1}`}
                    onClick={() => setDrafts(drafts.filter((_, n) => n !== i))}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              ))}
            </div>
            <div className="modal-actions">
              <button
                type="button"
                className="btn quiet"
                disabled={drafts.length >= 8 || busy}
                onClick={() =>
                  setDrafts([
                    ...drafts,
                    { id: crypto.randomUUID(), title: "", text: "" },
                  ])
                }
              >
                <Plus size={16} />
                Добавить
              </button>
              <button className="btn primary" disabled={busy || locked}>
                Сохранить заготовки
              </button>
            </div>
            {error && <Notice tone="error">{error}</Notice>}
          </form>
        </Modal>
      )}
    </section>
  );
}
