import type { Message, Webinar } from "./contracts";
import { moderationReason } from "./moderation";
export function viewerMessage(message: Message): Message {
  return message.held && !message.deleted
    ? {
        ...message,
        text: "Сообщение заблокировано",
        moderationReason: undefined,
      }
    : message;
}
export function publicMessage<T extends Pick<Message, "name" | "role">>(
  message: T,
  webinar: Pick<Webinar, "hostName">,
): T {
  return {
    ...message,
    name:
      ["viewer","speaker"].includes(message.role)
        ? moderationReason(message.name)
          ? "Участник"
          : message.name
        : message.role === "moderator"
          ? "Модератор"
          : webinar.hostName.trim() || "Ведущий",
  };
}
