import { describe, expect, it } from "vitest";
import { emptyImpact, ImpactContextSchema } from "../src/impact";

describe("ImpactContext", () => {
  it("emptyImpact is valid and has no domain", () => {
    const e = emptyImpact();
    expect(ImpactContextSchema.safeParse(e).success).toBe(true);
    expect(e.businessDomain).toBeNull();
    expect(e.changedFiles).toEqual([]);
  });
  it("rejects a non-repo-relative path", () => {
    expect(
      ImpactContextSchema.safeParse({ ...emptyImpact(), changedFiles: ["/abs"] }).success,
    ).toBe(false);
  });
});
