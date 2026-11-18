import { describe, expect, it } from "vitest";
import { AuditPlanSchema } from "../src/plan";

const task = (id: string) => ({
  id,
  engine: "quality",
  kind: "quality.coverage-gap",
  title: "t",
  scope: [],
  readOnly: true,
  networkRequired: false,
});

describe("AuditPlanSchema", () => {
  it("accepts unique task ids", () => {
    expect(
      AuditPlanSchema.safeParse({ projectPath: "/p", tasks: [task("a"), task("b")] }).success,
    ).toBe(true);
  });
  it("rejects duplicate task ids", () => {
    expect(
      AuditPlanSchema.safeParse({ projectPath: "/p", tasks: [task("a"), task("a")] }).success,
    ).toBe(false);
  });
  it("requires an explicit readOnly flag (no default)", () => {
    const { readOnly: _drop, ...noFlag } = task("a");
    expect(AuditPlanSchema.safeParse({ projectPath: "/p", tasks: [noFlag] }).success).toBe(false);
  });
  it("requires an explicit networkRequired flag (§16 network-prompt hook, R12)", () => {
    const { networkRequired: _drop, ...noFlag } = task("a");
    expect(AuditPlanSchema.safeParse({ projectPath: "/p", tasks: [noFlag] }).success).toBe(false);
  });
});
