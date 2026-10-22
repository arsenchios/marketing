import { useEffect, useState } from "react";
import { api, send } from "./api";
export function DeckLibrary({
  id,
  active,
  revision,
  onShow,
}: {
  id: string;
  active: string | null;
  revision: number;
  onShow: () => void;
}) {
  const [decks, setDecks] = useState<
      { id: string; name: string; pages: number }[]
    >([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    let disposed = false;
    const load = () =>
      api(`/api/events/${id}/decks`)
        .then((r) => {
          if (!disposed) setDecks(r.decks);
        })
        .catch(() => {});
    void load();
    const timer = setInterval(load, 5000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [id, revision, active]);
  if (!decks.length) return null;
  return (
    <div className="deck-library">
      <strong>Презентации</strong>
      {decks.map((d) => (
        <div className="invitation-person" key={d.id}>
          <span>
            {d.name}
            {d.pages ? ` · ${d.pages} стр.` : ""}
          </span>
          <button
            className="btn quiet small"
            disabled={busy || active === d.id}
            onClick={async () => {
              if (
                !confirm(
                  "Показать эту презентацию всем? Откроется первый слайд",
                )
              )
                return;
              setBusy(true);
              try {
                await send(`/api/events/${id}/decks/${d.id}/show`);
                onShow();
                setMessage("Презентация показана");
              } catch (e) {
                setMessage((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {active === d.id ? "На экране" : "Показать"}
          </button>
        </div>
      ))}
      {message && <small role="status">{message}</small>}
    </div>
  );
}
