import { describe, expect, it } from "vitest";
import { normalizeUsername, validateUsername } from "@/lib/username";

/**
 * Issue #29, Section 24: pure-function coverage for username validation —
 * the fast client-side check that mirrors migration 00000000000044's own
 * `username_format`/`username_not_reserved` constraints (see the module's
 * own doc comment on why the two must stay in sync by hand).
 */
describe("normalizeUsername", () => {
  it("lowercases, trims, and strips a leading @", () => {
    expect(normalizeUsername("  JaceB  ")).toBe("jaceb");
    expect(normalizeUsername("@JaceB")).toBe("jaceb");
    expect(normalizeUsername("jaceb")).toBe("jaceb");
  });
});

describe("validateUsername", () => {
  it("accepts a well-formed username", () => {
    expect(validateUsername("jace_b2")).toBeNull();
    expect(validateUsername("abc")).toBeNull();
    expect(validateUsername("a".repeat(20))).toBeNull();
  });

  it("is case-insensitive — an uppercase input normalizes and validates the same as its lowercase form", () => {
    expect(validateUsername("JaceB")).toBeNull();
    expect(validateUsername("JACEB")).toBeNull();
  });

  it("rejects usernames under 3 characters", () => {
    expect(validateUsername("ab")).toMatch(/at least 3/);
    expect(validateUsername("")).toMatch(/at least 3/);
  });

  it("rejects usernames over 20 characters", () => {
    expect(validateUsername("a".repeat(21))).toMatch(/20 characters or fewer/);
  });

  it("rejects disallowed characters", () => {
    expect(validateUsername("jace-b")).toMatch(/lowercase letters, numbers, and underscores/);
    expect(validateUsername("jace b")).toMatch(/lowercase letters, numbers, and underscores/);
    expect(validateUsername("jace!")).toMatch(/lowercase letters, numbers, and underscores/);
    expect(validateUsername("jacé")).toMatch(/lowercase letters, numbers, and underscores/);
  });

  it("rejects reserved names, case-insensitively", () => {
    expect(validateUsername("admin")).toMatch(/reserved/);
    expect(validateUsername("Admin")).toMatch(/reserved/);
    expect(validateUsername("PROFILE")).toMatch(/reserved/);
    expect(validateUsername("settings")).toMatch(/reserved/);
  });

  it("accepts a name that merely contains a reserved word as a substring", () => {
    // Reserved-word matching is exact, not substring — "admins" is a
    // distinct, unreserved username from "admin".
    expect(validateUsername("admins")).toBeNull();
  });
});
