import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DetectedProject } from "@audit/audit-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/db";
import { ProjectsRepo } from "../src/projects-repo";
import { cleanupTmp, makeTmp } from "./helpers";

const detected = (over: Partial<DetectedProject> = {}): DetectedProject => ({
  path: "/work/alpha",
  name: "alpha",
  ecosystems: ["node"],
  packageManager: "pnpm",
  isMonorepo: false,
  isGitRepo: true,
  ...over,
});

let db: DatabaseSync;
let time: number;
let seq: number;
let repo: ProjectsRepo;

beforeEach(() => {
  db = openDb(join(makeTmp(), "audit.db"));
  time = 1_000;
  seq = 0;
  repo = new ProjectsRepo(db, { now: () => time, newId: () => `id-${++seq}` });
});
afterEach(() => {
  db.close();
  cleanupTmp();
});

describe("ProjectsRepo", () => {
  it("inserts a new project with fresh id and timestamps", () => {
    expect(repo.upsert(detected())).toEqual({
      ...detected(),
      id: "id-1",
      addedAt: 1_000,
      lastOpenedAt: 1_000,
    });
  });

  it("re-opening the same path keeps id and addedAt, bumps lastOpenedAt, refreshes detection", () => {
    const first = repo.upsert(detected());
    time = 5_000;
    const again = repo.upsert(
      detected({ ecosystems: ["node", "rust"], packageManager: null, isMonorepo: true }),
    );
    expect(again).toEqual({
      ...detected({ ecosystems: ["node", "rust"], packageManager: null, isMonorepo: true }),
      id: first.id,
      addedAt: 1_000,
      lastOpenedAt: 5_000,
    });
    expect(repo.list()).toHaveLength(1);
    expect(seq).toBe(2); // a candidate id is generated per call; only the first is kept
  });

  it("round-trips Unicode, spaces and parentheses in paths", () => {
    const path = "/home/robin/Work/AI软件安全审计项目开发 (副本)/项目 é";
    const saved = repo.upsert(detected({ path, name: "项目 é" }));
    expect(repo.get(saved.id)?.path).toBe(path);
    expect(repo.get(saved.id)?.name).toBe("项目 é");
  });

  it("stores an empty ecosystem list", () => {
    expect(repo.upsert(detected({ ecosystems: [], packageManager: null })).ecosystems).toEqual([]);
  });

  it("lists most recently opened first", () => {
    repo.upsert(detected({ path: "/a", name: "a" }));
    time = 2_000;
    repo.upsert(detected({ path: "/b", name: "b" }));
    time = 3_000;
    repo.upsert(detected({ path: "/a", name: "a" }));
    expect(repo.list().map((p) => p.path)).toEqual(["/a", "/b"]);
  });

  it("get returns null for an unknown id", () => {
    expect(repo.get("nope")).toBeNull();
  });

  it("refresh replaces detection fields but not path or lastOpenedAt", () => {
    const saved = repo.upsert(detected());
    time = 9_000;
    const refreshed = repo.refresh(
      saved.id,
      detected({ path: "/somewhere/else", isGitRepo: false, name: "renamed" }),
    );
    expect(refreshed).toEqual({ ...saved, isGitRepo: false, name: "renamed" });
  });

  it("refresh returns null for an unknown id", () => {
    expect(repo.refresh("nope", detected())).toBeNull();
  });

  it("a second connection to the same file sees committed rows and can write", () => {
    const file = join(makeTmp(), "shared.db");
    const one = openDb(file);
    const two = openDb(file);
    const repoOne = new ProjectsRepo(one, { now: () => 1, newId: () => "one" });
    const repoTwo = new ProjectsRepo(two, { now: () => 2, newId: () => "two" });
    repoOne.upsert(detected({ path: "/x" }));
    repoTwo.upsert(detected({ path: "/y" }));
    expect(
      repoOne
        .list()
        .map((p) => p.path)
        .sort(),
    ).toEqual(["/x", "/y"]);
    one.close();
    two.close();
  });
});
