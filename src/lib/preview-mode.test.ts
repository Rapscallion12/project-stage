// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { isPreviewOrDevBuild } from "./preview-mode";

describe("isPreviewOrDevBuild (issue #21, Parts 1 & 5)", () => {
  const original = process.env.VERCEL_ENV;

  afterEach(() => {
    if (original === undefined) delete process.env.VERCEL_ENV;
    else process.env.VERCEL_ENV = original;
  });

  it("is false on the real production deployment", () => {
    process.env.VERCEL_ENV = "production";
    expect(isPreviewOrDevBuild()).toBe(false);
  });

  it("is true on a preview deployment", () => {
    process.env.VERCEL_ENV = "preview";
    expect(isPreviewOrDevBuild()).toBe(true);
  });

  it("is true locally, where VERCEL_ENV is unset", () => {
    delete process.env.VERCEL_ENV;
    expect(isPreviewOrDevBuild()).toBe(true);
  });
});
