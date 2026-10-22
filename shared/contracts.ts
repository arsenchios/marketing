import { platformBrand } from "./brand.ts";
import { z } from "zod";
export const chatTemplateSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z0-9_-]{1,48}$/),
    title: z.string().trim().min(1).max(40),
    text: z.string().trim().min(1).max(1000),
  })
  .strict();
export const chatTemplatesSchema = z
  .array(chatTemplateSchema)
  .max(8)
  .refine((rows) => new Set(rows.map((r) => r.id)).size === rows.length);
export type ChatTemplate = z.infer<typeof chatTemplateSchema>;
export const defaultChatTemplates: ChatTemplate[] = [
  {
    id: "sound",
    title: "Проверка звука",
    text: "Хорошо ли нас видно и слышно? Напишите + в чат",
  },
  {
    id: "questions",
    title: "Вопросы",
    text: "Задавайте вопросы в чат — разберём их во время вебинара",
  },
  {
    id: "pause",
    title: "Небольшая пауза",
    text: "Небольшая техническая пауза. Пожалуйста, оставайтесь в комнате — скоро продолжим",
  },
  {
    id: "thanks",
    title: "Завершение",
    text: "Спасибо за участие и ваши вопросы! До встречи на следующих вебинарах",
  },
];
export const audienceTestSchema = z
  .object({
    enabled: z.boolean(),
    greetingsEnabled: z.boolean(),
    rampTarget: z.number().int().min(1).max(10000),
    rampMinutes: z.number().int().min(1).max(120),
    peak: z.number().int().min(1).max(10000),
    peakMinutes: z.number().int().min(2).max(240),
  })
  .strict()
  .refine((v) => v.peak >= v.rampTarget && v.peakMinutes > v.rampMinutes, {
    message:
      "Пик должен быть не меньше первого значения и наступать позже начального роста",
  });
export type AudienceTest = z.infer<typeof audienceTestSchema>;
export const eventInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(2000),
  hostName: z.string().trim().max(80),
  brandName: z.string().trim().max(60),
  accent: z.string().regex(/^#[a-fA-F0-9]{6}$/),
  welcome: z.string().max(500),
  chatBlockedWords: z
    .array(z.string().trim().min(1).max(40))
    .max(100)
    .optional(),
  startsAt: z.string().refine((s) => !s || Number.isFinite(Date.parse(s))),
  timezone: z.string().refine((s) => {
    try {
      new Intl.DateTimeFormat("ru", { timeZone: s });
      return true;
    } catch {
      return false;
    }
  }),
  ctaTitle: z.string().max(80),
  ctaDescription: z.string().max(240),
  ctaUrl: z
    .string()
    .max(2000)
    .refine((s) => !s || /^https?:\/\//.test(s)),
  channel: z.enum(["arslive", "company"]),
  chatTemplates: chatTemplatesSchema.optional(),
  audienceTest: audienceTestSchema.optional(),
});
export type EventInput = z.infer<typeof eventInput>;
export type EventState =
  | "draft"
  | "starting"
  | "live"
  | "reconnecting"
  | "stopping"
  | "ended"
  | "failed";
export type Stroke = {
  color: string;
  width: number;
  points: [number, number][];
};
export const cameraBoxSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().min(0.12).max(0.55),
  })
  .strict()
  .refine((b) => b.x + b.width <= 1.000001 && b.y + b.width <= 1.000001);
export type { CameraBox } from "./camera";
import type { CameraBox } from "./camera";
export type Webinar = EventInput & {
  id: string;
  companyId: string;
  slug: string;
  state: EventState;
  createdAt: string;
  deletedAt?: string;
  reopenedAt?: string;
  reopenedFromRunId?: string;
  ctaVisible: boolean;
  pdfId: string | null;
  logoId: string | null;
  coverId: string | null;
  slide: number;
  layout: "slides" | "camera";
  annotations: Record<string, Stroke[]>;
  cameraBox?: CameraBox;
  delivery?: "railway" | "youtube";
};
export type Message = {
  id: string;
  name: string;
  text: string;
  role: string;
  attendeeId: string | null;
  at: string;
  deleted: boolean;
  held?: boolean;
  moderationReason?: string;
  blocked?: boolean;
};
export type YouTubeChannel = {
  channel_id: string;
  title: string;
  thumbnail?: string | null;
};
export type YouTubeBroadcast = {
  completion?: "complete" | "failed" | "unavailable";
  completedAt?: string;
  videoId: string;
  channel?: YouTubeChannel | null;
};
export type Recording = {
  youtube?: YouTubeBroadcast;
  id: string;
  eventId: string;
  companyId: string;
  state: "recording" | "processing" | "ready" | "incomplete" | "failed";
  createdAt: string;
  duration: number | null;
  bytes: number | null;
  hasFile: boolean;
  readyAt?: string;
  stoppedAt?: string;
  expiresAt?: string;
  purgedAt?: string;
  storageKey?: string;
  localRemovedAt?: string;
  interrupted: boolean;
  assemblyPending?: boolean;
  archive?: {
    state: "pending" | "uploading" | "ready" | "failed" | "not_configured";
    storedAt?: string;
    verifiedAt?: string;
  };
};
export type MediaStatus = {
  finishUntil?: number;
  runId: string | null;
  receiving: boolean;
  bytes: number;
  lastDataAt: number | null;
  playlist: string | null;
  state: EventState;
  mode: "broadcast";
  provider: "railway" | "youtube";
  archiveWarning?: string | null;
  youtube?: {
    channel?: YouTubeChannel | null;
    enabled: boolean;
    phase: "off" | "waiting" | "sending" | "live" | "error";
    videoId?: string;
    message?: string;
  };
};
export type RoomSnapshot = {
  speakerName?: string;
  audienceScenario?: {
    elapsedSeconds: number;
    startedAt: string;
    settings: AudienceTest;
  };
  attendees?: { attendeeId: string; name: string }[];
  event: Webinar;
  messages: Message[];
  recordings: Recording[];
  media: MediaStatus;
  online: number;
};
export const initialEvent: EventInput = {
  title: "Новый вебинар",
  description: "",
  hostName: "",
  brandName: "",
  accent: platformBrand.accent,
  welcome:
    "Добро пожаловать! Напишите в чат, хорошо ли нас видно и слышно, из какого вы города и что вам интересно узнать",
  startsAt: "",
  timezone: "Europe/Moscow",
  ctaTitle: "",
  ctaDescription: "",
  ctaUrl: "",
  channel: "arslive",
};
