import type { DatabaseSync } from "node:sqlite";
import { type DetectedProject, type Project, ProjectSchema } from "@audit/audit-core";

export interface RepoDeps {
  now: () => number;
  newId: () => string;
}

interface Row {
  id: string;
  path: string;
  name: string;
  ecosystems: string;
  package_manager: string | null;
  is_monorepo: number;
  is_git_repo: number;
  added_at: number;
  last_opened_at: number;
}

function toProject(raw: unknown): Project {
  const r = raw as Row;
  return ProjectSchema.parse({
    id: r.id,
    path: r.path,
    name: r.name,
    ecosystems: JSON.parse(r.ecosystems),
    packageManager: r.package_manager,
    isMonorepo: r.is_monorepo === 1,
    isGitRepo: r.is_git_repo === 1,
    addedAt: r.added_at,
    lastOpenedAt: r.last_opened_at,
  });
}

export class ProjectsRepo {
  private readonly db: DatabaseSync;
  private readonly deps: RepoDeps;

  constructor(db: DatabaseSync, deps: RepoDeps) {
    this.db = db;
    this.deps = deps;
  }

  upsert(d: DetectedProject): Project {
    const now = this.deps.now();
    const row = this.db
      .prepare(
        `INSERT INTO projects
           (id, path, name, ecosystems, package_manager, is_monorepo, is_git_repo, added_at, last_opened_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           name = excluded.name,
           ecosystems = excluded.ecosystems,
           package_manager = excluded.package_manager,
           is_monorepo = excluded.is_monorepo,
           is_git_repo = excluded.is_git_repo,
           last_opened_at = excluded.last_opened_at
         RETURNING *`,
      )
      .get(
        this.deps.newId(),
        d.path,
        d.name,
        JSON.stringify(d.ecosystems),
        d.packageManager,
        d.isMonorepo ? 1 : 0,
        d.isGitRepo ? 1 : 0,
        now,
        now,
      );
    return toProject(row);
  }

  refresh(id: string, d: DetectedProject): Project | null {
    const row = this.db
      .prepare(
        `UPDATE projects SET
           name = ?, ecosystems = ?, package_manager = ?, is_monorepo = ?, is_git_repo = ?
         WHERE id = ? RETURNING *`,
      )
      .get(
        d.name,
        JSON.stringify(d.ecosystems),
        d.packageManager,
        d.isMonorepo ? 1 : 0,
        d.isGitRepo ? 1 : 0,
        id,
      );
    return row ? toProject(row) : null;
  }

  list(): Project[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY last_opened_at DESC, added_at DESC, id")
      .all()
      .map(toProject);
  }

  get(id: string): Project | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? toProject(row) : null;
  }
}
