import { test } from "node:test";
import assert from "node:assert/strict";
import { moderationReason } from "../shared/moderation.ts";
import { viewerMessage } from "../shared/chat.ts";
test("Moderation handles case, lookalikes and separators without matching innocent words", () => {
  for (const text of [
    "ХУЙ",
    "xуй",
    "х.у.й",
    "ты х у й",
    "это п.и.з.д.а",
    "блЯть",
    "пиздец",
    "fuck",
    "сдохни",
  ])
    assert.ok(moderationReason(text), text);
  for (const text of [
    "Страхуй риски заранее",
    "Подстрахуй меня",
    "Слушаю из Москвы)",
    "❤️👍✅👏",
    "Мне не слышно",
    "Учебник по истории",
  ])
    assert.equal(moderationReason(text), undefined, text);
  assert.equal(
    moderationReason("наш секретный купон", ["секретный"]),
    "Слово из списка организатора",
  );
  assert.equal(
    moderationReason("https://example.com"),
    "Ссылка — нужна проверка",
  );
  assert.equal(moderationReason("!!!!!!!!!!!!!!!!!"), "Похоже на спам");
});
test("Held content is stripped before viewer delivery and retained for moderator review", () => {
  const message = {
    id: "1",
    name: "Иван",
    text: "hidden text",
    role: "viewer",
    attendeeId: "x",
    at: "now",
    deleted: false,
    held: true,
    moderationReason: "reason",
  };
  const view = viewerMessage(message);
  assert.equal(view.text, "Сообщение заблокировано");
  assert.equal(view.moderationReason, undefined);
  assert.equal(message.text, "hidden text");
  assert.equal(viewerMessage({ ...message, held: false }).text, "hidden text");
});
