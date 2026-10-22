import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { PDFDocument } from "pdf-lib";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { prepareAsset, validateOfficeZip } from "../server/presentations.ts";
const exec = promisify(execFile);

test(
  "Real presentation import: PDF, PowerPoint/ODP variants, photos and rejected input",
  { timeout: 180000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "live-format-test-"));
    try {
      const pptx = await readFile(
        new URL("./fixtures/presentation.pptx", import.meta.url),
      );
      const converting = prepareAsset(pptx, "Тест.PPTX", "pdf");
      await assert.rejects(
        prepareAsset(pptx, "second.pptx", "pdf"),
        (error: any) => error.status === 429,
      );
      const result = await converting;
      assert.equal(result.pages, 2);
      assert.equal(result.mime, "application/pdf");
      await writeFile(join(dir, "verified.pdf"), result.buffer);
      const document = await getDocument({
        data: new Uint8Array(result.buffer),
        useSystemFonts: true,
      }).promise;
      const first = await (await document.getPage(1)).getTextContent();
      const second = await (await document.getPage(2)).getTextContent();
      assert.match(
        first.items.map((i: any) => i.str).join(" "),
        /Проверка PowerPoint/,
      );
      assert.match(
        second.items.map((i: any) => i.str).join(" "),
        /Второй слайд/,
      );
      await document.loadingTask.destroy();
      await writeFile(join(dir, "deck.pptx"), pptx);
      for (const format of [
        "ppt:MS PowerPoint 97",
        "odp:impress8",
        "pps:MS PowerPoint 97 AutoPlay",
        "ppsx:Impress MS PowerPoint 2007 XML AutoPlay",
      ]) {
        await exec(
          process.env.LIBREOFFICE_PATH || "soffice",
          [
            "-env:UserInstallation=" + pathToFileURL(join(dir, "profile")).href,
            "--headless",
            "--convert-to",
            format,
            "--outdir",
            dir,
            join(dir, "deck.pptx"),
          ],
          { timeout: 30000 },
        );
        const ext = format.split(":")[0];
        const file = await readFile(join(dir, "deck." + ext));
        assert.equal(
          (await prepareAsset(file, "deck." + ext, "pdf")).pages,
          2,
          ext,
        );
      }
      const pdf = await PDFDocument.create();
      pdf.addPage([960, 540]);
      assert.equal(
        (await prepareAsset(Buffer.from(await pdf.save()), "slides.pdf", "pdf"))
          .pages,
        1,
      );
      for (const ext of ["png", "jpeg", "webp"] as const) {
        const image = await sharp({
          create: {
            width: 160,
            height: 90,
            channels: 3,
            background: "#ac2442",
          },
        })
          .toFormat(ext)
          .toBuffer();
        const cover = await prepareAsset(image, "photo." + ext, "cover");
        assert.equal(cover.mime, "image/png");
        const metadata = await sharp(cover.buffer).metadata();
        assert.equal(metadata.width, 160);
        assert.equal(metadata.exif, undefined);
        assert.equal(
          (await prepareAsset(image, "photo." + ext, "pdf")).pages,
          1,
        );
      }
      await assert.rejects(
        prepareAsset(Buffer.from("<svg></svg>"), "fake.png", "cover"),
        /фотография/,
      );
      await assert.rejects(
        prepareAsset(Buffer.from("bad ppt"), "bad.ppt", "pdf"),
        /повреждён/,
      );
      await assert.rejects(
        prepareAsset(Buffer.from("bad zip"), "bad.pptx", "pdf"),
        /повреждён/,
      );
      await assert.rejects(
        prepareAsset(Buffer.from("abc"), "slides.key", "pdf"),
        /Keynote/,
      );
      await assert.rejects(
        prepareAsset(Buffer.alloc(101 * 1024 * 1024), "big.pptx", "pdf"),
        /100 МБ/,
      );
      const large = await PDFDocument.create();
      for (let i = 0; i < 400; i++) large.addPage();
      const largeBytes = Buffer.from(await large.save());
      assert.equal(
        (await prepareAsset(largeBytes, "400.pdf", "pdf")).pages,
        400,
      );
      // A valid PDF padded with comments exercises the exact byte boundary.
      const hundredMB = Buffer.alloc(100 * 1024 * 1024, 32);
      largeBytes.copy(hundredMB, 0);
      assert.equal(
        (await prepareAsset(hundredMB, "100mb.pdf", "pdf")).pages,
        400,
      );
      large.addPage();
      await assert.rejects(
        prepareAsset(Buffer.from(await large.save()), "401.pdf", "pdf"),
        /400/,
      );
      // Rejection releases the conversion slot and leaves the next upload usable.
      assert.equal(
        (await prepareAsset(result.buffer, "again.pdf", "pdf")).pages,
        2,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

import {
  thumbnailWindow,
  cacheThumbnail,
  THUMBNAIL_CACHE_SIZE,
} from "../shared/presentation.ts";
test("Thumbnail working set stays bounded across a 400-slide presentation", () => {
  assert.deepEqual(thumbnailWindow(1, 400), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(thumbnailWindow(400, 400), [398, 399, 400]);
  const cache = new Map<number, string>();
  for (let i = 1; i <= 400; i++)
    for (const n of thumbnailWindow(i, 400))
      cacheThumbnail(cache, n, String(n));
  assert.equal(cache.size, THUMBNAIL_CACHE_SIZE);
  assert.equal(cache.has(1), false);
  assert.equal(cache.has(400), true);
  cacheThumbnail(cache, 380, "refreshed");
  assert.equal([...cache.keys()].at(-1), 380);
});
