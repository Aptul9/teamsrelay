import { describe, expect, it } from "vitest";
import { IMAGE_ACCEPT, imageProblem } from "@/lib/client";

const file = (type: string, size: number) => new File([new Uint8Array(size)], "photo", { type });

describe("image picked in the app", () => {
  it("goes when it is a PNG, JPEG, GIF or WebP of 10 MB at most", () => {
    for (const type of IMAGE_ACCEPT.split(",")) expect(imageProblem(file(type, 1000)), type).toBeNull();
    expect(imageProblem(file("image/jpeg", 10e6))).toBeNull();
  });

  it("is refused with the reason otherwise", () => {
    expect(imageProblem(file("image/svg+xml", 1000))).toBe("Only PNG, JPEG, GIF or WebP images");
    expect(imageProblem(file("application/pdf", 1000))).toBe("Only PNG, JPEG, GIF or WebP images");
    expect(imageProblem(file("image/png", 10e6 + 1))).toBe("Image larger than 10 MB");
    expect(imageProblem(file("image/png", 0))).toBe("Empty image");
  });
});
