import type { AudienceTest, Message, Recording, Webinar } from "./contracts";

export const defaultAudienceTest: AudienceTest = {
  enabled: false,
  greetingsEnabled: false,
  rampTarget: 200,
  rampMinutes: 7,
  peak: 400,
  peakMinutes: 15,
};
export const demoGreetings = [
  ["Анна", "Всем привет)"],
  ["Михаил", "Москва на связи 👋"],
  ["Ольга", "Хорошо видно и слышно 👍"],
  ["Денис", "Мне пока не слышно"],
  ["Денис", "А, нет, всё слышно) включил звук"],
  ["Мария", "Привет из Алматы 😊"],
  ["Елена", "Добрый день! Очень жду практику"],
  ["Алексей", "Санкт-Петербург здесь)"],
  ["Ирина", "Всё отлично, спасибо ❤️"],
  ["Андрей", "Интересно узнать, с чего лучше начать"],
  ["Юлия", "Казань на связи 👋"],
  ["Максим", "Стартуем)"],
  ["Светлана", "Хочу услышать реальные примеры"],
  ["Роман", "Звук хороший 👍"],
  ["Екатерина", "Смотрю с телефона, всё видно)"],
  ["Павел", "Привет из Тбилиси"],
  ["Наталья", "Интересно, какие ошибки бывают в начале"],
  ["Виктор", "Запасся блокнотом 😄"],
  ["Дарья", "Всем хорошего эфира ❤️"],
  ["Сергей", "Готов слушать)"],
];

// Presentation-only closed-test activity. Never write to chat storage or analytics.
export function audienceTrend(
  seconds: number,
  config = defaultAudienceTest,
): number {
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const minute = (Math.floor(seconds / 3) * 3) / 60;
  const { rampTarget, rampMinutes, peak, peakMinutes } = config;
  if (minute <= rampMinutes) {
    const t = minute / rampMinutes;
    return Math.round(rampTarget * t * (2 - t));
  }
  if (minute <= peakMinutes)
    return Math.round(
      rampTarget +
        ((peak - rampTarget) * (minute - rampMinutes)) /
          (peakMinutes - rampMinutes),
    );
  const floor = Math.round((peak * 200) / 430);
  const declineMinutes = Math.max(35, 60 - peakMinutes);
  const t = Math.min(1, (minute - peakMinutes) / declineMinutes);
  if (t < 1) return Math.round(peak - (peak - floor) * t * (2 - t));
  return Math.round(
    floor *
      (1 - 0.1 * Math.min(1, (minute - peakMinutes - declineMinutes) / 30)),
  );
}

export function audienceScenario(
  event: Webinar,
  recordings: Recording[],
  now = Date.now(),
) {
  const settings = event.audienceTest;
  if (
    (!settings?.enabled && !settings?.greetingsEnabled) ||
    !["starting", "live", "reconnecting"].includes(event.state)
  )
    return undefined;
  const run = recordings.find((r) => r.state === "recording");
  const startedAt = Date.parse(run?.createdAt || "");
  if (!Number.isFinite(startedAt)) return undefined;
  return {
    elapsedSeconds: Math.max(0, (now - startedAt) / 1000),
    startedAt: run!.createdAt,
    settings,
  };
}

export function scriptedGreetings(
  eventId: string,
  startedAt: string,
  seconds: number,
): Message[] {
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(seconds)) return [];
  return demoGreetings
    .slice(0, Math.max(0, Math.floor(seconds / 9)))
    .map(([name, text], i) => ({
      id: `scenario-${eventId}-${i}`,
      name,
      text,
      role: "viewer",
      attendeeId: null,
      at: new Date(start + (i + 1) * 9000).toISOString(),
      deleted: false,
    }));
}

export function scriptedAudience(
  seconds: number,
  config = defaultAudienceTest,
): number {
  const trend = audienceTrend(seconds, config);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  const step = Math.floor(seconds / 3);
  const amplitude = Math.min(8, config.peak * 0.02) * Math.min(1, seconds / 60);
  const wave =
    amplitude * (Math.sin(step * 0.72) * 0.65 + Math.sin(step * 0.19) * 0.35);
  return Math.max(0, Math.round(trend + wave));
}
