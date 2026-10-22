import { MAX_SLIDES, PRESENTATION_BYTES } from "../shared/presentation.ts";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import yauzl from "yauzl";

const exec = promisify(execFile);
export const PRESENTATION_LIMIT = PRESENTATION_BYTES;
const OUTPUT_LIMIT = PRESENTATION_BYTES;
const office = new Set(["pptx", "ppt", "ppsx", "pps", "odp"]);
export class AssetError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
// Only one conversion at a time: a large deck must not exhaust the broadcast server.
let converting = false;
function converterEnv(home: string) {
  return {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    LC_ALL: "C",
    SAL_USE_VCLPLUGIN: "svp",
  };
}
async function convertOffice(args: string[], temp: string) {
  const binary = process.env.LIBREOFFICE_PATH || "soffice";
  const command = process.platform === "linux" ? "python3" : binary;
  const argv =
    process.platform === "linux"
      ? [
          fileURLToPath(new URL("./office-sandbox.py", import.meta.url)),
          temp,
          binary,
          ...args,
        ]
      : args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, argv, {
      detached: process.platform !== "win32",
      stdio: "ignore",
      cwd: temp,
      env: converterEnv(temp),
    });
    const timer = setTimeout(() => {
      if (child.pid) {
        try {
          process.kill(
            process.platform === "win32" ? child.pid : -child.pid,
            "SIGKILL",
          );
        } catch {
          /* Already exited. */
        }
      }
    }, 180000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error("Conversion failed"));
    });
  });
}
export async function validatePDF(path: string) {
  try {
    const { stdout } = await exec(
      process.env.PDFINFO_PATH || "pdfinfo",
      ["-f", "1", "-l", String(MAX_SLIDES), path],
      {
        timeout: 10000,
        maxBuffer: 256 * 1024,
        env: { PATH: process.env.PATH, LC_ALL: "C" },
      },
    );
    const pages = Number(stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
    const sizes = [
      ...stdout.matchAll(
        /(?:Page\s+\d+\s+size|Page size):\s+([\d.]+)\s+x\s+([\d.]+)/g,
      ),
    ];
    if (
      !pages ||
      pages > MAX_SLIDES ||
      /Encrypted:\s+yes/.test(stdout) ||
      sizes.some((m) => Math.max(+m[1], +m[2]) > 14400)
    )
      throw Error();
    return pages;
  } catch {
    throw new AssetError(
      "Не удалось прочитать презентацию. Загрузите файл без пароля, не более 400 слайдов",
    );
  }
}
// Inspect ZIP entries without extracting; cap decompressed size, reject active content and external resources.
export async function validateOfficeZip(buffer: Buffer, ext: string) {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip)
        return reject(new AssetError("Файл презентации повреждён"));
      let total = 0,
        count = 0,
        valid = false,
        settled = false;
      const fail = (message: string) => {
        if (!settled) {
          settled = true;
          zip.close();
          reject(new AssetError(message));
        }
      };
      zip.on("error", () => fail("Файл презентации повреждён"));
      zip.on("end", () => {
        if (!settled) {
          settled = true;
          valid
            ? resolve()
            : reject(
                new AssetError("Это не файл презентации выбранного формата"),
              );
        }
      });
      zip.on("entry", (entry) => {
        total += entry.uncompressedSize;
        if (
          ++count > 10000 ||
          total > 512 * 1024 * 1024 ||
          entry.uncompressedSize > PRESENTATION_BYTES ||
          entry.generalPurposeBitFlag & 1
        )
          return fail("Презентация слишком большая или защищена паролем");
        if (
          /vbaproject|\/embeddings\/|^Scripts\/|^Basic\//i.test(entry.fileName)
        )
          return fail(
            "Удалите макросы и встроенные объекты или экспортируйте презентацию в PDF",
          );
        if (
          entry.fileName ===
          (ext === "odp" ? "content.xml" : "ppt/presentation.xml")
        )
          valid = true;
        if (!/\.xml$|\.rels$/.test(entry.fileName)) {
          zip.readEntry();
          return;
        }
        if (entry.uncompressedSize > 8 * 1024 * 1024)
          return fail("Слишком сложная презентация — экспортируйте её в PDF");
        zip.openReadStream(entry, (err, stream) => {
          if (err || !stream) return fail("Файл презентации повреждён");
          const chunks: Buffer[] = [];
          stream.on("data", (chunk) => chunks.push(chunk));
          stream.on("error", () => fail("Файл презентации повреждён"));
          stream.on("end", () => {
            if (settled) return;
            const xml = Buffer.concat(chunks).toString("utf8");
            if (/<!DOCTYPE|<!ENTITY/i.test(xml))
              return fail(
                "Неподдерживаемое содержимое — экспортируйте презентацию в PDF",
              );
            // Hyperlinks are harmless; externally linked images/media must be embedded first.
            if (
              ext === "odp"
                ? /xlink:href\s*=\s*["'](?:https?:|file:|ftp:|\/\/|\.\.\/)/i.test(
                    xml.replace(/<text:a\b[^>]*>/gi, ""),
                  )
                : /<Relationship\b(?=[^>]*TargetMode\s*=\s*["']External["'])(?![^>]*Type\s*=\s*["'][^"']*\/hyperlink["'])[^>]*>/i.test(
                    xml,
                  )
            )
              return fail(
                "Презентация ссылается на внешние изображения или видео. Вставьте их в файл или экспортируйте в PDF",
              );
            zip.readEntry();
          });
        });
      });
      zip.readEntry();
    });
  });
}
export async function normalizeImage(buffer: Buffer) {
  try {
    const image = sharp(buffer, {
      limitInputPixels: 40_000_000,
      failOn: "warning",
      animated: false,
    });
    const meta = await image.metadata();
    if (
      !["png", "jpeg", "webp"].includes(meta.format || "") ||
      (meta.pages || 1) > 1
    )
      throw Error();
    // Orient phone photos, bound canvas memory and strip private EXIF metadata.
    return await image
      .rotate()
      .resize({
        width: 3840,
        height: 3840,
        fit: "inside",
        withoutEnlargement: true,
      })
      .png()
      .toBuffer();
  } catch {
    throw new AssetError(
      "Нужна фотография PNG, JPG или WebP, до 40 мегапикселей, без анимации",
    );
  }
}
export async function prepareAsset(
  buffer: Buffer,
  name: string,
  kind: "pdf" | "logo" | "cover",
) {
  if (
    !buffer.length ||
    buffer.length > (kind === "pdf" ? PRESENTATION_LIMIT : 12 * 1024 * 1024)
  )
    throw new AssetError(
      kind === "pdf"
        ? "Размер презентации — до 100 МБ"
        : "Размер изображения — до 12 МБ",
    );
  if (converting)
    throw new AssetError(
      "Другой файл ещё обрабатывается. Повторите загрузку через минуту",
      429,
    );
  converting = true;
  let temp = "";
  try {
    temp = await mkdtemp(join(tmpdir(), "arslive-deck-"));
    if (kind !== "pdf")
      return {
        buffer: await normalizeImage(buffer),
        mime: "image/png",
        ext: "png",
        pages: undefined,
      };
    const ext = extname(name).slice(1).toLowerCase();
    let pdf: Buffer;
    if (buffer.subarray(0, 5).toString() === "%PDF-") pdf = buffer;
    else if (["png", "jpg", "jpeg", "webp"].includes(ext)) {
      const doc = await PDFDocument.create();
      const normalized = await normalizeImage(buffer);
      const photo = await sharp(normalized)
        .flatten({ background: "#ffffff" })
        .resize({
          width: 2560,
          height: 1440,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 88 })
        .toBuffer();
      const img = await doc.embedJpg(photo);
      const page = doc.addPage([960, 540]);
      const scale = Math.min(960 / img.width, 540 / img.height);
      page.drawImage(img, {
        x: (960 - img.width * scale) / 2,
        y: (540 - img.height * scale) / 2,
        width: img.width * scale,
        height: img.height * scale,
      });
      pdf = Buffer.from(await doc.save());
    } else if (office.has(ext)) {
      if (["pptx", "ppsx", "odp"].includes(ext))
        await validateOfficeZip(buffer, ext);
      else if (
        !buffer.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"))
      )
        throw new AssetError("Файл PowerPoint повреждён");
      const profile = join(temp, "profile");
      await mkdir(join(profile, "user"), { recursive: true });
      await writeFile(
        join(profile, "user", "registrymodifications.xcu"),
        `<?xml version="1.0"?><oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Load"><prop oor:name="UpdateDocMode" oor:op="fuse"><value>0</value></prop></item></oor:items>`,
      );
      const input = join(temp, "slides." + ext);
      await writeFile(input, buffer, { mode: 0o600 });
      try {
        await convertOffice(
          [
            "-env:UserInstallation=" + pathToFileURL(profile).href,
            "--headless",
            "--norestore",
            "--nodefault",
            "--nofirststartwizard",
            "--convert-to",
            "pdf:impress_pdf_Export:" +
              JSON.stringify({
                ReduceImageResolution: { type: "boolean", value: "true" },
                MaxImageResolution: { type: "long", value: "150" },
                Quality: { type: "long", value: "85" },
                UseLosslessCompression: { type: "boolean", value: "false" },
              }),
            "--outdir",
            temp,
            input,
          ],
          temp,
        );
        const output = join(temp, "slides.pdf");
        if ((await stat(output)).size > OUTPUT_LIMIT)
          throw new AssetError(
            "После обработки презентация превышает 100 МБ. Сожмите изображения",
          );
        pdf = await readFile(output);
      } catch (e) {
        if (e instanceof AssetError) throw e;
        throw new AssetError(
          (e as NodeJS.ErrnoException).code === "ENOENT"
            ? "Обработка PowerPoint на сервере ещё недоступна. Пока загрузите PDF"
            : "Не удалось обработать презентацию. Проверьте пароль и содержимое или экспортируйте её в PDF",
        );
      }
    } else
      throw new AssetError(
        "Загрузите PDF, PPTX, PPT, PPSX, PPS, ODP или изображение PNG, JPG, WebP. Из Keynote и Google Slides экспортируйте PPTX или PDF",
      );
    const path = join(temp, "checked.pdf");
    await writeFile(path, pdf);
    const pages = await validatePDF(path);
    return { buffer: pdf, mime: "application/pdf", ext: "pdf", pages };
  } finally {
    converting = false;
    if (temp) await rm(temp, { recursive: true, force: true });
  }
}
