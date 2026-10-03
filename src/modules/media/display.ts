/** Fixed variants for authenticated, content-addressed pictures. Never proxies an arbitrary URL. */
export const MEDIA_WIDTHS = [64, 96, 128, 256, 384, 640, 960, 1280] as const;
const OWN_MEDIA = /^\/api\/media\/[a-f0-9]{64}$/i;
export function mediaWidth(value: string | null): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const n = Number(value);
  return (MEDIA_WIDTHS as readonly number[]).includes(n) ? n : null;
}
export function displayImageUrl(url: string, width: number): string {
  return OWN_MEDIA.test(url) && (MEDIA_WIDTHS as readonly number[]).includes(width) ? url + "?w=" + width : url;
}
export function displayImageSrcSet(url: string): string | undefined {
  return OWN_MEDIA.test(url) ? MEDIA_WIDTHS.map(w => displayImageUrl(url,w) + " " + w + "w").join(", ") : undefined;
}
