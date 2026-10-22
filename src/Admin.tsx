import { Diagnostics } from "./Diagnostics";
import { DeleteWebinar } from "./DeleteWebinar";
import { useEffect, useState } from "react";
import { api, send, dateLabel } from "./api";
import { Header, Notice, Badge, CopyButton } from "./ui";
import type { Webinar } from "../shared/contracts";
type Item = Pick<
  Webinar,
  "id" | "slug" | "title" | "state" | "startsAt" | "timezone" | "hostName"
> & { companyName: string };
export function Admin() {
  const [technical, setTechnical] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api("/api/admin/webinars")
        .then((r) => {
          if (!cancelled) {
            setItems(r.webinars);
            setError("");
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    void load();
    const timer = setInterval(load, 15000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);
  return (
    <>
      <Header active="admin" />
      <main className="page">
        <div className="page-heading">
          <div>
            <div className="eyebrow">АДМИНИСТРАТОР ПЛАТФОРМЫ</div>
            <h1>Вебинары клиентов</h1>
            <p>
              Помогайте ведущим, следите за эфиром и отправляйте зрителям ссылку
              на комнату
            </p>
          </div>
          <a className="btn quiet" href="/">
            Мой кабинет
          </a>
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        {loading && <p role="status">Загружаем вебинары…</p>}
        {!loading && !error && !items.length && (
          <Notice>
            Здесь появятся вебинары, созданные в кабинетах ваших клиентов
          </Notice>
        )}
        <button
          className="btn quiet"
          aria-pressed={technical}
          onClick={() => setTechnical(!technical)}
        >
          {technical ? "Скрыть техническую сводку" : "Техническая сводка"}
        </button>
        <div className="admin-webinars">
          {items.map((w) => (
            <article key={w.id}>
              <div>
                <Badge state={w.state} />
                <h2>{w.title}</h2>
                <p>
                  {w.companyName} · {w.hostName}
                </p>
                <small>{dateLabel(w.startsAt, w.timezone)}</small>
              </div>
              <button
                className="btn quiet"
                disabled={!!busy}
                onClick={async () => {
                  setBusy(w.id);
                  setError("");
                  try {
                    const r = await send(`/api/admin/webinars/${w.id}/observe`);
                    location.assign(r.url);
                  } catch (e) {
                    setError((e as Error).message);
                    setBusy("");
                  }
                }}
              >
                {busy === w.id ? "Открываем…" : "Наблюдать за вебинаром"}
              </button>
              <a className="btn primary" href={`/assist/${w.id}`}>
                Помочь в студии
              </a>
              <CopyButton
                value={`${location.origin}/room/${w.slug}`}
                label="Ссылка зрителя"
              />
              <a
                className="btn quiet"
                href={`/room/${w.slug}`}
                target="_blank"
                rel="noreferrer"
              >
                Как видит зритель
              </a>
              {technical && <Diagnostics id={w.id} />}
              <DeleteWebinar
                webinar={w}
                admin
                onDeleted={() =>
                  setItems((items) => items.filter((item) => item.id !== w.id))
                }
              />
            </article>
          ))}
        </div>
      </main>
    </>
  );
}
