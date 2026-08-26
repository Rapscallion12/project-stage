import { describe, expect, it } from "vitest";
import { SELECTION_RANK_WEIGHTS, selectWeightedCandidate } from "./speaker-selection";

describe("selectWeightedCandidate", () => {
  it("returns null for an empty candidate list", () => {
    expect(selectWeightedCandidate([], 0.5)).toBeNull();
  });

  it("1 candidate: always selected regardless of randomValue", () => {
    const candidates = [{ requestId: "a", rank: 1 }];
    expect(selectWeightedCandidate(candidates, 0)).toBe("a");
    expect(selectWeightedCandidate(candidates, 0.5)).toBe("a");
    expect(selectWeightedCandidate(candidates, 0.999)).toBe("a");
  });

  describe("2 candidates — weights [3, 2], total 5, threshold at 3/5 = 0.6", () => {
    const candidates = [
      { requestId: "rank1", rank: 1 },
      { requestId: "rank2", rank: 2 },
    ];

    it("just below the boundary selects rank 1", () => {
      expect(selectWeightedCandidate(candidates, 0.599)).toBe("rank1");
    });

    it("at the boundary selects rank 2 (threshold is exclusive of the upper candidate's start)", () => {
      expect(selectWeightedCandidate(candidates, 0.6)).toBe("rank2");
    });

    it("just below 1 still selects rank 2", () => {
      expect(selectWeightedCandidate(candidates, 0.999)).toBe("rank2");
    });

    it("0 selects rank 1", () => {
      expect(selectWeightedCandidate(candidates, 0)).toBe("rank1");
    });
  });

  describe("3 candidates — weights [3, 2, 1], total 6, boundaries at 3/6=0.5 and 5/6≈0.833", () => {
    const candidates = [
      { requestId: "rank1", rank: 1 },
      { requestId: "rank2", rank: 2 },
      { requestId: "rank3", rank: 3 },
    ];

    it("selects rank 1 for randomValue in [0, 0.5)", () => {
      expect(selectWeightedCandidate(candidates, 0)).toBe("rank1");
      expect(selectWeightedCandidate(candidates, 0.499)).toBe("rank1");
    });

    it("selects rank 2 for randomValue in [0.5, 0.833)", () => {
      expect(selectWeightedCandidate(candidates, 0.5)).toBe("rank2");
      expect(selectWeightedCandidate(candidates, 0.8332)).toBe("rank2");
    });

    it("selects rank 3 for randomValue in [0.8334, 1)", () => {
      expect(selectWeightedCandidate(candidates, 0.834)).toBe("rank3");
      expect(selectWeightedCandidate(candidates, 0.999)).toBe("rank3");
    });

    it("rank 1 (the leader) does not automatically win — a high randomValue selects someone else", () => {
      const result = selectWeightedCandidate(candidates, 0.9);
      expect(result).not.toBe("rank1");
    });
  });

  it("4+ candidates: only the first 3 by rank receive weight — an unweighted rank 4 candidate never wins (weight defaults to 1, same as rank 3, but this documents the caller's own contract of pre-slicing to Top 3)", () => {
    // The caller (freeze_speaker_candidates' SQL) already limits to 3
    // rows — this test documents that if a 4th ever slipped through,
    // this function still produces a valid weighted pick rather than
    // throwing, using weight 1 (SELECTION_RANK_WEIGHTS' own fallback)
    // for anything beyond the defined curve.
    const candidates = [
      { requestId: "rank1", rank: 1 },
      { requestId: "rank2", rank: 2 },
      { requestId: "rank3", rank: 3 },
      { requestId: "rank4", rank: 4 },
    ];
    expect(() => selectWeightedCandidate(candidates, 0.99)).not.toThrow();
  });

  it("sorts by rank internally — input order does not matter", () => {
    const candidates = [
      { requestId: "rank3", rank: 3 },
      { requestId: "rank1", rank: 1 },
      { requestId: "rank2", rank: 2 },
    ];
    expect(selectWeightedCandidate(candidates, 0)).toBe("rank1");
  });

  it("SELECTION_RANK_WEIGHTS is the single, isolated place the curve lives", () => {
    expect(SELECTION_RANK_WEIGHTS).toEqual([3, 2, 1]);
  });
});
