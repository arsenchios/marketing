export const MAX_SLIDES = 400;
export const PRESENTATION_BYTES = 100 * 1024 * 1024;
export const THUMBNAIL_CACHE_SIZE = 24;
export function thumbnailWindow(slide: number, pages: number) {
  const start = Math.max(1, slide - 2);
  return Array.from(
    { length: Math.max(0, Math.min(pages, slide + 5) - start + 1) },
    (_, i) => start + i,
  );
}
export function cacheThumbnail(
  cache: Map<number, string>,
  page: number,
  image: string,
) {
  cache.delete(page);
  cache.set(page, image);
  while (cache.size > THUMBNAIL_CACHE_SIZE)
    cache.delete(cache.keys().next().value!);
}
