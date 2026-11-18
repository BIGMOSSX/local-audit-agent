import { mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { computeProjectStamp } from "../src/project-stamp";
import { cleanupTmp, makeTmp } from "./helpers";

afterEach(cleanupTmp);

function project(): string {
  const root = makeTmp("stamp-");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "package.json"), "{}\n");
  return root;
}

describe("computeProjectStamp", () => {
  it("is stable for an unchanged tree", async () => {
    const root = project();
    expect(await computeProjectStamp(root)).toBe(await computeProjectStamp(root));
    expect(await computeProjectStamp(root)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a file's size changes", async () => {
    const root = project();
    const before = await computeProjectStamp(root);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 12345;\n");
    expect(await computeProjectStamp(root)).not.toBe(before);
  });

  it("changes when only the modification time changes", async () => {
    const root = project();
    const before = await computeProjectStamp(root);
    utimesSync(join(root, "src", "a.ts"), new Date(), new Date(Date.now() + 60_000));
    expect(await computeProjectStamp(root)).not.toBe(before);
  });

  it("changes when a file is added or renamed", async () => {
    const root = project();
    const before = await computeProjectStamp(root);
    writeFileSync(join(root, "src", "b.ts"), "x\n");
    const added = await computeProjectStamp(root);
    expect(added).not.toBe(before);
    rmSync(join(root, "src", "b.ts"));
    writeFileSync(join(root, "src", "c.ts"), "x\n");
    expect(await computeProjectStamp(root)).not.toBe(added);
  });

  it("ignores directories the audit never reads", async () => {
    const root = project();
    mkdirSync(join(root, "node_modules"));
    mkdirSync(join(root, ".git"));
    const before = await computeProjectStamp(root);
    writeFileSync(join(root, "node_modules", "x.js"), "1");
    writeFileSync(join(root, ".git", "HEAD"), "ref");
    expect(await computeProjectStamp(root)).toBe(before);
  });

  it("rejects when the root cannot be read", async () => {
    await expect(computeProjectStamp(join(makeTmp(), "missing"))).rejects.toThrow();
  });
});
