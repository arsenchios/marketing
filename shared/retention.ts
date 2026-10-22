import { platformBrand } from "./brand.ts";
import type { Recording } from "./contracts";
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export function recordingExpired(r: Recording, now = Date.now()) {
  return !!r.expiresAt && Date.parse(r.expiresAt) <= now;
}
export function retentionText(r: Recording) {
  if (recordingExpired(r))
    return "Срок хранения истёк — запись больше недоступна";
  if (!r.expiresAt)
    return "После подготовки запись будет доступна для скачивания 7 дней";
  return (
    "Скачайте запись до " +
    new Date(r.expiresAt).toLocaleString("ru", {
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZoneName: "short",
    }) +
    ` — затем она будет удалена из ${platformBrand.name}`
  );
}
export const youtubeArchiveNote =
  "Если эфир шёл на YouTube, запись также может сохраниться в подключённом канале — проверьте YouTube Studio";
