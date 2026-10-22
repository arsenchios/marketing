import { platformBrand } from "../shared/brand";
import { TeamAccess } from "./TeamAccess";
import { ChannelIdentity } from "./BroadcastIdentity";
import { useEffect, useState, useRef } from "react";
import { X, Youtube } from "lucide-react";
import { api, send } from "./api";
import { Notice } from "./ui";
type State = {
  configured: boolean;
  deliveryEnabled: boolean;
  channel?: { channel_id: string; title: string; thumbnail?: string } | null;
  shared: boolean;
  ownChannel: boolean;
  canManage: boolean;
  canInvite: boolean;
};
export function Connections({ compact = false }: { compact?: boolean }) {
  const [data, setData] = useState<State | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [email, setEmail] = useState(""),
    [company, setCompany] = useState(""),
    [message, setMessage] = useState("");
  const [platformChannel, setPlatformChannel] = useState(true);
  const [clients, setClients] = useState<
    { id: string; name: string; platformChannel: boolean }[]
  >([]);
  useEffect(() => {
    if (data?.canInvite)
      api("/api/clients")
        .then((r) => setClients(r.clients))
        .catch(() => setError("Не удалось загрузить кабинеты клиентов"));
  }, [data]);
  const load = () =>
    api("/api/integrations/youtube")
      .then(setData)
      .catch(() =>
        setError("Не удалось загрузить настройки — попробуйте ещё раз"),
      );
  useEffect(() => {
    void load();
    if (new URLSearchParams(location.search).get("youtube") === "error")
      setError(
        "Не удалось подключить канал — повторите вход и разрешите доступ к YouTube",
      );
  }, []);
  async function connect() {
    setBusy(true);
    setError("");
    try {
      const r = await send("/api/integrations/youtube/connect");
      location.assign(r.url);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }
  async function disconnect() {
    if (!confirm("Отключить канал и отозвать разрешение Google?")) return;
    setBusy(true);
    try {
      await send("/api/integrations/youtube", {}, "DELETE");
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function invite(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await send("/api/clients/invite", {
        email,
        companyName: company,
        platformChannel,
      });
      await load();
      setMessage(
        "Кабинет подготовлен для " +
          email +
          " — передайте клиенту адрес " +
          location.origin +
          ". Войти нужно именно с этим Google-аккаунтом",
      );
      setEmail("");
      setCompany("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!data)
    return error ? (
      <div>
        <Notice>{error}</Notice>
        <button
          className="btn quiet"
          onClick={() => {
            setError("");
            void load();
          }}
        >
          Повторить
        </button>
      </div>
    ) : (
      <p role="status">Загружаем настройки…</p>
    );
  return (
    <details
      className="connection-settings"
      open={!compact && data.canInvite ? true : undefined}
    >
      <summary>
        <Youtube size={20} />{" "}
        {data.channel ? data.channel.title : "Канал трансляции"}
        <span>{data.channel ? "Канал подключён" : "Настроить"}</span>
      </summary>
      <div className="connection-body">
        {data.canManage && <TeamAccess />}
        {data.channel && <ChannelIdentity channel={data.channel} />}
        <p>
          {data.deliveryEnabled && data.channel
            ? `Вебинары транслируются зрителям через YouTube-канал «${data.channel.title}»`
            : `Сейчас вебинары транслируются через ${platformBrand.serverLabel}`}
        </p>
        <p>
          {data.deliveryEnabled && data.channel
            ? "Запись будет доступна в кабинете для скачивания на 7 дней. YouTube: доступ по ссылке, не публичная публикация. Любой обладатель ссылки сможет посмотреть. Копия появится после обработки; её доступность зависит от ограничений канала"
            : "Запись будет доступна в кабинете для скачивания на 7 дней. Подключённый канал сам по себе не означает передачу видео на YouTube"}
        </p>
        {data.shared && (
          <p>Канал предоставлен {platformBrand.name} — подключать свой необязательно</p>
        )}
        {!data.channel && (
          <p>
            Для эфиров через YouTube подключите канал или обратитесь к
            организатору
          </p>
        )}
        {data.canManage && data.configured && (
          <div className="record-actions">
            <button className="btn quiet" disabled={busy} onClick={connect}>
              {data.shared
                ? "Использовать свой канал"
                : data.channel
                  ? "Подключить другой канал"
                  : "Подключить YouTube"}
            </button>
            {data.ownChannel && (
              <button
                className="btn quiet"
                disabled={busy}
                onClick={disconnect}
              >
                Отключить
              </button>
            )}
          </div>
        )}
        {data.canManage && data.channel && (
          <button
            className="btn quiet"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError("");
              setMessage("");
              try {
                const r = await send("/api/integrations/youtube/check");
                setMessage(r.message);
                await load();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Проверить канал
          </button>
        )}
        {message && <p role="status">{message}</p>}
        <details className="channel-hint">
          <summary>Как использовать свой канал — по желанию</summary>
          <p>
            Канал используется для трансляции зрителям и сохранения записи на
            YouTube. Можно скачать запись из кабинета и самостоятельно загрузить
            её на любой канал
          </p>
          <p>
            Для своего канала заранее откройте{" "}
            <a
              href="https://studio.youtube.com"
              target="_blank"
              rel="noreferrer"
            >
              YouTube Studio
            </a>{" "}
            → Создать → Начать трансляцию. Первая активация может занять до 24
            часов
          </p>
          <p>
            После активации нажмите «Использовать свой канал» или «Подключить
            YouTube» и разрешите доступ. Вход в кабинет через Google сам по себе
            канал не подключает
          </p>
        </details>
        {error && <Notice>{error}</Notice>}
        {data.canInvite && (
          <div className="admin-entry">
            <strong>Вы — администратор платформы</strong>
            <p>
              Клиенты видят только свой кабинет. Приглашения и список клиентских
              вебинаров доступны только вам
            </p>
            <a className="btn quiet" href="/admin">
              Вебинары клиентов
            </a>
          </div>
        )}
        {data.canInvite && (
          <details style={{ marginTop: 16 }}>
            <summary>Предоставить кабинет клиенту</summary>
            <p>
              Клиент войдёт со своим Google-аккаунтом. Доступ к каналу {platformBrand.name}
              позволяет провести эфир без настройки собственного YouTube
            </p>
            <form onSubmit={invite}>
              <label className="channel-choice">
                <input
                  type="checkbox"
                  checked={platformChannel}
                  onChange={(e) => setPlatformChannel(e.target.checked)}
                />{" "}
                Разрешить трансляции через канал {platformBrand.name}
              </label>
              <label>
                Компания
                <input
                  required
                  value={company}
                  onChange={(e) => setCompany(e.target.value)}
                  maxLength={80}
                />
              </label>
              <label>
                Почта Google клиента
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </label>
              <button className="btn quiet" disabled={busy}>
                Подготовить кабинет
              </button>
            </form>
          </details>
        )}
        {data.canInvite && clients.length > 0 && (
          <details className="client-access-list">
            <summary>Кабинеты клиентов · {clients.length}</summary>
            <p>
              Разрешение действует для эфиров через {platformBrand.name}, доступ к управлению
              вашим каналом не передаётся. Подключённый собственный канал
              клиента имеет приоритет
            </p>
            {clients.map((client) => (
              <label className="channel-choice" key={client.id}>
                <input
                  type="checkbox"
                  checked={client.platformChannel}
                  disabled={busy}
                  onChange={async (e) => {
                    const allowed = e.target.checked;
                    setBusy(true);
                    setError("");
                    try {
                      await send(
                        `/api/clients/${client.id}/channel`,
                        { allowed },
                        "PATCH",
                      );
                      await load();
                    } catch (e) {
                      setError((e as Error).message);
                    } finally {
                      setBusy(false);
                    }
                  }}
                />
                {client.name}
              </label>
            ))}
          </details>
        )}
      </div>
    </details>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [exitError, setExitError] = useState("");
  const [exiting, setExiting] = useState(false);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="settings-dialog"
      onCancel={onClose}
      aria-labelledby="settings-title"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="settings-content">
        <div className="modal-head">
          <div>
            <h2 id="settings-title">Настройки кабинета</h2>
          </div>
          <button
            className="icon-btn"
            aria-label="Закрыть настройки"
            onClick={onClose}
          >
            <X size={20} />
          </button>
        </div>
        <p className="settings-intro">
          Здесь можно выйти из аккаунта или подключить свой YouTube. Настройки
          каждого вебинара находятся в его комнате
        </p>
        <Connections />
        <button
          className="settings-logout"
          disabled={exiting}
          onClick={async () => {
            setExiting(true);
            try {
              await send("/api/auth/logout");
              location.assign("/");
            } catch (e) {
              setExitError((e as Error).message);
              setExiting(false);
            }
          }}
        >
          Выйти из кабинета
        </button>
        {exitError && <Notice tone="error">{exitError}</Notice>}
      </div>
    </dialog>
  );
}
