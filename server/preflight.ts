import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { MediaManager } from "./media.ts";

/** Synthetic video/tone only: never captures a person or creates a recording row. */
export async function checkRecording(media: MediaManager) {
  const dir = await mkdtemp(join(tmpdir(), "arslive-check-"));
  try {
    const file = join(dir, "check.mp4");
    await media.command(media.ffmpeg, [
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "color=c=black:s=320x180:r=15",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:sample_rate=48000",
      "-t",
      "0.6",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-movflags",
      "+faststart",
      file,
    ]);
    const result = JSON.parse(
      await media.command(media.ffprobe, [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type:format=duration",
        "-of",
        "json",
        file,
      ]),
    );
    if (
      !result.streams?.some((s: any) => s.codec_type === "video") ||
      !result.streams?.some((s: any) => s.codec_type === "audio") ||
      Number(result.format?.duration) <= 0 ||
      (await stat(file)).size === 0
    )
      throw new Error("Recording check failed");
    await media.command(media.ffmpeg, [
      "-v",
      "error",
      "-i",
      file,
      "-f",
      "null",
      "-",
    ]);
    return { recording: "ready" as const, checkedAt: new Date().toISOString() };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
