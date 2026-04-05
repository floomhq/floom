import { describe, it, expect } from "vitest";
import { detectImageFormat } from "@/lib/detectImageFormat";

describe("detectImageFormat", () => {
  it("detects PNG from magic bytes", () => {
    expect(detectImageFormat("iVBORw0KGgoAAAANSUh")).toEqual({
      mime: "image/png",
      ext: "png",
    });
  });

  it("detects JPEG from magic bytes", () => {
    expect(detectImageFormat("/9j/4AAQSkZJRg")).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
    });
  });

  it("detects GIF from magic bytes", () => {
    expect(detectImageFormat("R0lGODlhAQABAIAAAP")).toEqual({
      mime: "image/gif",
      ext: "gif",
    });
  });

  it("detects WebP from magic bytes", () => {
    expect(detectImageFormat("UklGRlYAAABXRUJQ")).toEqual({
      mime: "image/webp",
      ext: "webp",
    });
  });

  it("detects SVG from magic bytes", () => {
    expect(detectImageFormat("PHN2ZyB4bWxucz0i")).toEqual({
      mime: "image/svg+xml",
      ext: "svg",
    });
  });

  it("detects PNG from data URI", () => {
    expect(detectImageFormat("data:image/png;base64,iVBOR")).toEqual({
      mime: "image/png",
      ext: "png",
    });
  });

  it("detects JPEG from data URI with jpg extension", () => {
    expect(detectImageFormat("data:image/jpeg;base64,/9j/")).toEqual({
      mime: "image/jpeg",
      ext: "jpg",
    });
  });

  it("defaults to PNG for unknown prefix", () => {
    expect(detectImageFormat("AAABBBCCC")).toEqual({
      mime: "image/png",
      ext: "png",
    });
  });
});
