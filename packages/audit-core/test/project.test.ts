import { describe, expect, it } from "vitest";
import {
  ProjectListResultSchema,
  ProjectOpenParamsSchema,
  ProjectSchema,
  ProjectStatusSchema,
} from "../src/index";

const sample = {
  id: "p1",
  path: "/home/robin/Work/AI软件安全审计项目开发",
  name: "AI软件安全审计项目开发",
  ecosystems: ["node"],
  packageManager: "pnpm",
  isMonorepo: true,
  isGitRepo: true,
  addedAt: 1,
  lastOpenedAt: 2,
};

describe("project schemas", () => {
  it("parses a project with a Unicode path", () => {
    expect(ProjectSchema.parse(sample).name).toBe("AI软件安全审计项目开发");
  });
  it("allows an unknown package manager and no ecosystems", () => {
    expect(
      ProjectSchema.parse({ ...sample, packageManager: null, ecosystems: [] }).ecosystems,
    ).toEqual([]);
  });
  it("rejects unknown ecosystems and extra keys", () => {
    expect(ProjectSchema.safeParse({ ...sample, ecosystems: ["cobol"] }).success).toBe(false);
    expect(ProjectSchema.safeParse({ ...sample, extra: 1 }).success).toBe(false);
  });
  it("status adds pathExists", () => {
    expect(ProjectStatusSchema.parse({ ...sample, pathExists: false }).pathExists).toBe(false);
    expect(ProjectStatusSchema.safeParse(sample).success).toBe(false);
  });
  it("list result wraps projects", () => {
    expect(ProjectListResultSchema.parse({ projects: [sample] }).projects).toHaveLength(1);
  });
  it("open params need a non-empty path", () => {
    expect(ProjectOpenParamsSchema.safeParse({ path: "" }).success).toBe(false);
    expect(ProjectOpenParamsSchema.safeParse({ path: "/x", extra: 1 }).success).toBe(false);
  });
});
