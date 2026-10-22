import { useEffect, useState } from "react";
import type { Message, AudienceTest } from "../shared/contracts";
import {
  demoGreetings,
  scriptedAudience,
  defaultAudienceTest,
} from "../shared/audience";
export const demoAudience = (minutes: number) => scriptedAudience(minutes * 60);
// An explicitly labelled preview only: no API writes, viewer statistics or real chat messages.
export function ChatDemo({
  settings = defaultAudienceTest,
}: {
  settings?: AudienceTest;
}) {
  const [seconds, setSeconds] = useState(0);
  const [fast, setFast] = useState(false);
  useEffect(() => {
    const t = setInterval(
      () => setSeconds((s) => Math.min(5400, s + (fast ? 45 : 1))),
      1000,
    );
    return () => clearInterval(t);
  }, [fast]);
  return (
    <section className="chat-demo" aria-label="Демонстрация чата">
      <strong>
        Демонстрация · {scriptedAudience(seconds, settings)} условных зрителей
      </strong>
      <p>
        Предварительный просмотр — можно проверить весь сценарий за 2 минуты
      </p>
      <button
        type="button"
        className="btn small"
        onClick={() => {
          setSeconds(0);
          setFast(!fast);
        }}
      >
        {fast ? "Обычная скорость" : "Прогнать за 2 минуты"}
      </button>
      <label>
        Минута примера{" "}
        <input
          type="range"
          min="0"
          max="90"
          value={Math.min(90, seconds / 60)}
          onChange={(e) => setSeconds(Number(e.target.value) * 60)}
        />
      </label>
      <div className="chat-demo-messages">
        {demoGreetings
          .slice(0, Math.min(20, Math.floor(seconds / 9)))
          .map(([name, text], i) => (
            <p key={i}>
              <b>{name} · пример</b>
              <br />
              {text}
            </p>
          ))}
      </div>
    </section>
  );
}
export function nameColor(
  message: Pick<Message, "name" | "role" | "attendeeId">,
) {
  if (message.role !== "viewer") return "#e6cb82";
  let hash = 0;
  for (const c of message.attendeeId || message.name)
    hash = (hash * 31 + c.charCodeAt(0)) | 0;
  return ["#256567", "#76568d", "#984b64", "#536b37", "#955c29", "#42638a"][
    Math.abs(hash) % 6
  ];
}
