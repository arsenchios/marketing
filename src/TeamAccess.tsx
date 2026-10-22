import { useEffect, useState } from "react";
import { api, send } from "./api";
export function TeamAccess() {
  const [members, setMembers] = useState<
    { id: string; name: string; role: string }[]
  >([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => api("/api/team").then((r) => setMembers(r.members));
  useEffect(() => {
    void load().catch(() => {});
  }, []);
  return (
    <details className="team-access">
      <summary>Команда</summary>
      <p>
        Модератор управляет чатом и материалами. Ведущий может запускать эфир
        или подключаться вторым спикером. Доступ ко всем вебинарам компании.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          const form = e.currentTarget;
          const data = new FormData(form);
          setBusy(true);
          try {
            await send("/api/team", {
              name: data.get("name"),
              email: data.get("email"),
              role: data.get("role"),
            });
            await load();
            form.reset();
            setMessage(
              `Доступ готов. Передайте помощнику ссылку ${location.origin} — войти нужно с указанным Google-аккаунтом. Письмо автоматически не отправляется`,
            );
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Имя участника
          <input name="name" required maxLength={80} />
        </label>
        <label>
          Почта Google
          <input name="email" type="email" required maxLength={254} />
        </label>
        <label>
          Роль
          <select name="role" defaultValue="moderator">
            <option value="moderator">Модератор</option>
            <option value="host">Ведущий / второй спикер</option>
          </select>
        </label>
        <button className="btn quiet small" disabled={busy}>
          Предоставить доступ
        </button>
      </form>
      {members.map((m) => (
        <p key={m.id}>
          {m.name} · {m.role === "host" ? "Ведущий" : "Модератор"}{" "}
          <button
            className="btn quiet small"
            disabled={busy}
            onClick={async () => {
              if (!confirm(`Отозвать доступ: ${m.name}?`)) return;
              setBusy(true);
              try {
                await send(`/api/team/${m.id}`, {}, "DELETE");
                await load();
                setMessage("Доступ отозван");
              } catch (error) {
                setMessage((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Отозвать доступ
          </button>
        </p>
      ))}
      {message && <p role="status">{message}</p>}
    </details>
  );
}
