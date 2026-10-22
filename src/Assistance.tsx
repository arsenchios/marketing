import { useEffect, useState } from "react";
import { send } from "./api";
import { Studio } from "./Studio";
import { Notice } from "./ui";
export function Assistance({ id }: { id: string }) {
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    send(`/api/admin/webinars/${id}/assist`)
      .then(() => {
        if (!cancelled) setReady(true);
      })
      .catch((e) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);
  return ready ? (
    <Studio id={id} support />
  ) : (
    <main className="page">
      <a href="/admin">Вебинары клиентов</a>
      {error ? <Notice tone="error">{error}</Notice> : <p>Открываем студию…</p>}
    </main>
  );
}
