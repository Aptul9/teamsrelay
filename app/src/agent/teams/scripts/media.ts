// Page scripts that read images inside the Teams session. They run inside the Teams page: self-contained.

// blob: and AMS image URLs are readable only inside the Teams session: the page fetches them. null when the
// fetch fails or the image is larger than max bytes.
export async function fetchImage({ src, max }: { src: string; max: number }): Promise<{ type: string; data: string } | null> {
  const r = await fetch(src, { credentials: "include" });
  if (!r.ok) return null;
  const blob = await r.blob();
  if (blob.size > max) return null;
  const url = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
  return { type: blob.type, data: url.split(",")[1] || "" };
}

// Profile pictures come from a Teams API that wants its own token, so fetch() is refused. They are already
// drawn in the page, from the same origin: a canvas copies them. PNG as base64, null when not found.
export function copyImage(src: string): string | null {
  const img = [...document.querySelectorAll("img")].find((x) => (x.currentSrc || x.src) === src && x.naturalWidth);
  if (!img) return null;
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0);
    return canvas.toDataURL("image/png").split(",")[1] || null;
  } catch {
    return null;
  }
}

// The banner of a company's sign-in page (a wide image, often a mark with the name beside it) made square for a round
// icon: the mark alone where it stands out (the first group of columns with ink, about as wide as tall and at least
// twice as tall as the middle one of the groups after it: MSC's compass beside its name), else all of it, centered on
// a transparent square. Ink is what is opaque and not white, the banner being drawn on a white page. PNG as base64,
// null when the image cannot be read or has no ink.
export async function squareLogo(banner: string): Promise<string | null> {
  try {
    const image = await createImageBitmap(new Blob([Uint8Array.from(atob(banner), (c) => c.charCodeAt(0))]));
    const { width: w, height: h } = image;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(image, 0, 0);
    const px = ctx.getImageData(0, 0, w, h).data;
    const inked = (x: number, y: number) => {
      const i = (y * w + x) * 4;
      return px[i + 3] > 40 && Math.min(px[i], px[i + 1], px[i + 2]) < 225;
    };
    // the groups of columns with ink, left to right, with the rows they cover
    const groups: { x0: number; x1: number; y0: number; y1: number }[] = [];
    for (let x = 0; x < w; x++) {
      let y0 = -1;
      let y1 = -1;
      for (let y = 0; y < h; y++) {
        if (!inked(x, y)) continue;
        if (y0 < 0) y0 = y;
        y1 = y + 1;
      }
      if (y0 < 0) continue;
      const last = groups[groups.length - 1];
      if (last?.x1 === x) Object.assign(last, { x1: x + 1, y0: Math.min(last.y0, y0), y1: Math.max(last.y1, y1) });
      else groups.push({ x0: x, x1: x + 1, y0, y1 });
    }
    if (!groups.length) return null;
    const first = groups[0];
    const heights = groups.slice(1).map((g) => g.y1 - g.y0).sort((a, b) => a - b);
    const [fw, fh] = [first.x1 - first.x0, first.y1 - first.y0];
    const mark = heights.length > 0 && fw >= fh * 0.8 && fw <= fh * 1.25 && fh >= heights[heights.length >> 1] * 2;
    const box = mark
      ? first
      : { x0: first.x0, x1: groups[groups.length - 1].x1, y0: Math.min(...groups.map((g) => g.y0)), y1: Math.max(...groups.map((g) => g.y1)) };
    const [bw, bh] = [box.x1 - box.x0, box.y1 - box.y0];
    const side = Math.max(bw, bh);
    const square = new OffscreenCanvas(side, side);
    square.getContext("2d")?.drawImage(canvas, box.x0, box.y0, bw, bh, Math.round((side - bw) / 2), Math.round((side - bh) / 2), bw, bh);
    const blob = await square.convertToBlob({ type: "image/png" });
    const url = await new Promise<string>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.readAsDataURL(blob);
    });
    return url.split(",")[1] || null;
  } catch {
    return null;
  }
}
