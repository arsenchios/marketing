import { useEffect, useState } from "react";
import { api } from "./api";
import { Studio } from "./Studio";
export function SpeakerRoom({ id }: { id: string }) {
  const [access, setAccess] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    void api(`/api/events/${id}/permissions`)
      .then((p) => {
        if (!p.broadcast)
          throw Error(
            "Нужен доступ спикера. Попросите владельца пригласить вашу Google-почту в команду",
          );
        setAccess(true);
      })
      .catch((e) => setError(e.message));
  }, [id]);
  if (!access)
    return (
      <main className="page">
        <h1>Подключение спикера</h1>
        <p>{error || "Проверяем доступ…"}</p>
        <a className="btn quiet" href="/">
          Войти в кабинет
        </a>
      </main>
    );
  return (
    <>
      <Studio id={id} support coSpeaker />
    </>
  );
}
