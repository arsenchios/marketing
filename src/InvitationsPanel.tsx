import { useEffect, useState, useRef } from "react";
import { api, send } from "./api";
import { Modal } from "./ui";
import { Link, Copy } from "lucide-react";
type Role = "speaker" | "assistant";
export function InvitationsPanel({ id }: { id: string }) {
  const [data, setData] = useState<{ invitations: any[]; participants: any[] }>(
    { invitations: [], participants: [] },
  );
  const [role, setRole] = useState<Role | null>(null),
    [links, setLinks] = useState<Partial<Record<Role, string>>>({}),
    [message, setMessage] = useState(""),
    [busy, setBusy] = useState(false);
  const opening = useRef(false);
  const load = () => api(`/api/events/${id}/invitations`).then(setData);
  useEffect(() => {
    void load().catch(() => {});
    const timer = setInterval(() => void load().catch(() => {}), 5000);
    return () => clearInterval(timer);
  }, [id]);
  const current = data.invitations.filter(
    (i) => !i.revoked && i.expires > Date.now(),
  );
  const selected = current.filter((i) => i.role === role);
  async function invite(r: Role) {
    setBusy(true);
    setMessage("");
    try {
      const result = await send(`/api/events/${id}/invitations`, { role: r });
      setLinks((l) => ({ ...l, [r]: result.url }));
      await load();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function open(r: Role) {
    if (opening.current || busy) return;
    opening.current = true;
    setRole(r);
    setMessage("");
    try {
      const fresh = await api(`/api/events/${id}/invitations`);
      setData(fresh);
      if (!fresh.invitations.some((i: any) => i.role === r && !i.revoked && i.expires > Date.now()))
        await invite(r);
    } catch (e) { setMessage((e as Error).message); }
    finally { opening.current = false; }
  }
  async function revoke(invitation: string) {
    if (!confirm("Отключить участника и отозвать его ссылку?")) return;
    setBusy(true);
    try {
      await send(`/api/events/${id}/invitations/${invitation}`, {}, "DELETE");
      setLinks((l) => ({ ...l, [role!]: undefined }));
      await load();
      setMessage("Участник отключён, ссылка отозвана");
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <button
        className="btn quiet"
        onClick={() => void open("speaker")}
      >
        <Link size={16} />
        Ссылка для спикера
      </button>
      <button
        className="btn quiet"
        onClick={() => void open("assistant")}
      >
        <Link size={16} />
        Ссылка для ассистента
      </button>
      {role && (
        <Modal
          title={
            role === "speaker" ? "Пригласить спикера" : "Пригласить ассистента"
          }
          onClose={() => setRole(null)}
        >
          <div className="invitation-panel invitation-dialog">
            <p>
              {role === "speaker"
                ? "Спикер проверит камеру и звук и подключится без вашего подтверждения."
                : "Ассистент помогает с чатом, слайдами и предложением без камеры."}{" "}
              Регистрация не нужна.
            </p>
            {links[role] && (
              <label>
                Личная ссылка
                <div className="invitation-link">
                  <input
                    aria-label="Ссылка приглашения"
                    readOnly
                    value={links[role]}
                    onFocus={(e) => e.currentTarget.select()}
                  />
                  <button
                    className="btn quiet"
                    aria-label="Скопировать ссылку приглашения"
                    onClick={() =>
                      void navigator.clipboard
                        .writeText(links[role]!)
                        .then(() => setMessage("Ссылка скопирована"))
                        .catch(() =>
                          setMessage("Выделите ссылку и скопируйте вручную"),
                        )
                    }
                  >
                    <Copy size={16} />
                  </button>
                </div>
              </label>
            )}
            {selected.map((i) => {
              const person = data.participants.find(
                (p) => p.invitation === i.id,
              );
              return (
                <div className="invitation-member" key={i.id}>
                  <strong>
                    {person?.name ||
                      (role === "speaker" ? "Спикер" : "Ассистент")}
                  </strong>
                  <small>
                    {person
                      ? person.online
                        ? "В комнате"
                        : "Не в сети"
                      : "Ожидаем вход по ссылке"}
                  </small>
                  <label className="invitation-control">
                    <input
                      type="checkbox"
                      checked={!!i.controls}
                      disabled={busy}
                      onChange={async (e) => {
                        const controls = e.target.checked;
                        setData((d) => ({
                          ...d,
                          invitations: d.invitations.map((row) =>
                            row.id === i.id
                              ? { ...row, controls: controls ? 1 : 0 }
                              : row,
                          ),
                        }));
                        setBusy(true);
                        try {
                          await send(
                            `/api/events/${id}/invitations/${i.id}`,
                            { controls },
                            "PATCH",
                          );
                          await load();
                        } catch (e) {
                          setMessage((e as Error).message);
                          await load().catch(() => {});
                        } finally {
                          setBusy(false);
                        }
                      }}
                    />
                    Разрешить управление слайдами и инструментами
                  </label>
                  <button
                    className="btn quiet small"
                    disabled={busy}
                    onClick={() => void revoke(i.id)}
                  >
                    Отключить и отозвать ссылку
                  </button>
                </div>
              );
            })}
            {(!selected.length || role === "assistant") && (
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => void invite(role)}
              >
                Создать ссылку
              </button>
            )}
            {!!selected.length && !links[role] && (
              <small>
                Для новой ссылки отзовите прежнюю. Уже вошедший участник может
                вернуться в том же браузере.
              </small>
            )}
            {message && <p role="status">{message}</p>}
          </div>
        </Modal>
      )}
    </>
  );
}
