import { describe, expect, it } from "vitest";
import { replacePercentage, resolveRoundOutcome } from "./speaker-round";

describe("resolveRoundOutcome", () => {
  it("zero votes is continue — silence never ejects anyone", () => {
    expect(resolveRoundOutcome(0, 0)).toBe("continue");
  });

  it("all Continue votes is continue", () => {
    expect(resolveRoundOutcome(5, 0)).toBe("continue");
  });

  it("an exact 50/50 tie is continue, not narrow-loss — explicit instruction", () => {
    expect(resolveRoundOutcome(1, 1)).toBe("continue");
    expect(resolveRoundOutcome(5, 5)).toBe("continue");
  });

  it("Replace just over 50% is a narrow loss", () => {
    // 2 continue, 3 replace = 60% replace
    expect(resolveRoundOutcome(2, 3)).toBe("narrow-loss");
  });

  it("Replace just under 66% is still a narrow loss, not decisive", () => {
    // 34 continue, 65 replace = 65.65...% replace, under 66
    expect(resolveRoundOutcome(34, 65)).toBe("narrow-loss");
  });

  it("Replace at exactly 66% is decisive", () => {
    // 34 continue, 66 replace = 66% replace exactly
    expect(resolveRoundOutcome(34, 66)).toBe("decisive-replace");
  });

  it("Replace above 66% is decisive", () => {
    expect(resolveRoundOutcome(1, 9)).toBe("decisive-replace"); // 90%
  });

  it("matches the product's own worked examples", () => {
    // "2 voters, 2 Replace -> Replace wins" (100%, decisive)
    expect(resolveRoundOutcome(0, 2)).toBe("decisive-replace");
    // "10 voters, 7 Replace -> Replace wins" (70%, decisive)
    expect(resolveRoundOutcome(3, 7)).toBe("decisive-replace");
    // "100 viewers but only 1 vote, and it is Replace -> Replace wins" (100%, decisive)
    expect(resolveRoundOutcome(0, 1)).toBe("decisive-replace");
    // "zero votes -> Continue"
    expect(resolveRoundOutcome(0, 0)).toBe("continue");
  });

  it("a single Continue vote against a single Replace vote is a tie (continue)", () => {
    expect(resolveRoundOutcome(1, 1)).toBe("continue");
  });
});

describe("replacePercentage", () => {
  it("is null with no votes", () => {
    expect(replacePercentage(0, 0)).toBeNull();
  });

  it("computes the display percentage", () => {
    expect(replacePercentage(2, 3)).toBe(60);
    expect(replacePercentage(1, 1)).toBe(50);
  });
});
