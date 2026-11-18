import { open, readdir, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import type { DetectedProject, Ecosystem, PackageManager } from "@audit/audit-core";
import { IpcError } from "./errors";

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

const ECOSYSTEMS: ReadonlyArray<{ id: Ecosystem; test: (names: ReadonlySet<string>) => boolean }> =
  [
    { id: "node", test: (n) => n.has("package.json") },
    {
      id: "python",
      test: (n) =>
        ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile"].some((f) => n.has(f)),
    },
    { id: "rust", test: (n) => n.has("Cargo.toml") },
    { id: "go", test: (n) => n.has("go.mod") },
    {
      id: "java",
      test: (n) =>
        [
          "pom.xml",
          "build.gradle",
          "build.gradle.kts",
          "settings.gradle",
          "settings.gradle.kts",
        ].some((f) => n.has(f)),
    },
    {
      id: "dotnet",
      test: (n) => [...n].some((f) => /\.(sln|csproj|fsproj)$/.test(f)),
    },
    { id: "ruby", test: (n) => n.has("Gemfile") },
    { id: "php", test: (n) => n.has("composer.json") },
  ];

const LOCKFILES: ReadonlyArray<{ manager: PackageManager; files: readonly string[] }> = [
  { manager: "pnpm", files: ["pnpm-lock.yaml"] },
  { manager: "yarn", files: ["yarn.lock"] },
  { manager: "bun", files: ["bun.lock", "bun.lockb"] },
  { manager: "npm", files: ["package-lock.json", "npm-shrinkwrap.json"] },
];

const MONOREPO_MARKERS = ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"];
const MANAGERS: readonly string[] = ["pnpm", "npm", "yarn", "bun"];

const invalidPath = (message: string) => new IpcError("invalid_path", message);

async function readPackageJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_PACKAGE_JSON_BYTES) return null;
    const handle = await open(file, "r");
    try {
      const buffer = Buffer.alloc(MAX_PACKAGE_JSON_BYTES + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_PACKAGE_JSON_BYTES) return null;
      const text = buffer.toString("utf8", 0, bytesRead).replace(/^\uFEFF/, "");
      const parsed: unknown = JSON.parse(text);
      return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

function hasWorkspaces(pkg: Record<string, unknown> | null): boolean {
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) return ws.length > 0;
  if (ws !== null && typeof ws === "object") {
    const packages = (ws as { packages?: unknown }).packages;
    return Array.isArray(packages) && packages.length > 0;
  }
  return false;
}

function pickPackageManager(
  names: ReadonlySet<string>,
  pkg: Record<string, unknown> | null,
): PackageManager | null {
  const declared = pkg?.packageManager;
  if (typeof declared === "string") {
    const name = declared.split("@")[0] ?? "";
    if (MANAGERS.includes(name)) return name as PackageManager;
  }
  for (const { manager, files } of LOCKFILES) {
    if (files.some((f) => names.has(f))) return manager;
  }
  return null;
}

const NETWORK_MESSAGE = "Network folders are not supported; choose a folder on this computer.";

// `\\host\share`, `//host/share`, `\\?\UNC\...` and `\\.\` device paths: two leading separators of either kind.
const isNetworkPath = (p: string): boolean => /^[\\/]{2}/.test(p);

export async function detectProject(inputPath: string): Promise<DetectedProject> {
  if (typeof inputPath !== "string" || inputPath.length === 0) {
    throw invalidPath("Project path is empty.");
  }
  if (inputPath.includes("\0")) throw invalidPath("Project path contains a NUL character.");
  // Checked on the raw string, on every OS, before any filesystem call: a UNC path would make the
  // daemon open an SMB connection.
  if (isNetworkPath(inputPath)) throw invalidPath(NETWORK_MESSAGE);
  if (!isAbsolute(inputPath)) throw invalidPath("Project path must be absolute.");

  let real: string;
  try {
    real = await realpath(inputPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EACCES" || code === "EPERM")
      throw invalidPath("No permission to access this folder.");
    throw invalidPath("This folder does not exist.");
  }

  // A mapped network drive can resolve to a UNC path.
  if (isNetworkPath(real)) throw invalidPath(NETWORK_MESSAGE);

  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(real);
  } catch {
    throw invalidPath("This folder cannot be read.");
  }
  if (!info.isDirectory()) throw invalidPath("This path is not a folder.");

  let entries: string[];
  try {
    entries = await readdir(real);
  } catch {
    throw invalidPath("This folder cannot be read (permission denied?).");
  }
  const names = new Set(entries);

  const ecosystems = ECOSYSTEMS.filter((e) => e.test(names)).map((e) => e.id);
  const isNode = ecosystems.includes("node");
  const pkg = isNode ? await readPackageJson(join(real, "package.json")) : null;

  return {
    path: real,
    name: basename(real) || real,
    ecosystems,
    packageManager: isNode ? pickPackageManager(names, pkg) : null,
    isMonorepo: MONOREPO_MARKERS.some((f) => names.has(f)) || hasWorkspaces(pkg),
    isGitRepo: names.has(".git"),
  };
}
