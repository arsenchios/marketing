import { useEffect, useState } from "react";
import { api, send } from "./api";
import { Studio } from "./Studio";

export function GuestEntry({ id }: { id: string }) {
  const [role, setRole] = useState<"speaker" | "assistant" | null>(null),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [token] = useState(() => location.hash.slice(1));
  useEffect(() => {
    void api(`/api/events/${id}/permissions`)
      .then((p) => setRole(p.guestRole || null))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [id]);
  if (loading) return <main className="page">Открываем приглашение…</main>;
  if (role)
    return (
      <>
        <Studio id={id} support coSpeaker={role === "speaker"} />
      </>
    );
  return (
    <main className="page guest-entry">
      <h1>Приглашение на вебинар</h1>
      <p>Представьтесь, чтобы войти в студию. Ваше имя будет видно в чате.</p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError("");
          try {
            const result = await send(`/api/events/${id}/invitation-entry`, {
              token,
              name: new FormData(e.currentTarget).get("name"),
            });
            setRole(result.role);
            history.replaceState(null, "", location.pathname);
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Ваше имя
          <input name="name" required maxLength={60} autoComplete="name" />
        </label>
        <button className="btn primary" disabled={busy || !token}>
          Войти в студию
        </button>
      </form>
      {!token && <p>Откройте полную ссылку, которую прислал организатор</p>}
      {error && <p role="alert">{error}</p>}
    </main>
  );
}
