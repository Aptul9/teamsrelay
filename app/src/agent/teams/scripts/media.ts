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
