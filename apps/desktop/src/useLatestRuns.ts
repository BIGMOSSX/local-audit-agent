import type { AuditRun, Project } from "@audit/audit-core";
import { useCallback, useEffect, useState } from "react";
import { type AuditClient, toCallError } from "./ipc";
import type { Failure } from "./useProjectSession";

export interface LatestRunRow {
  project: Project;
  run: AuditRun;
}

export interface LatestRuns {
  /** Newest first; null until the first read has finished (or while the project list is loading). */
  rows: LatestRunRow[] | null;
  /** The first project whose history could not be read; rows that did load are still in `rows`. */
  failure: Failure | null;
  failed: boolean;
  loading: boolean;
  refetch(): void;
}

/**
 * The latest run of every project. A project without a run is left out; one whose history fails
 * is reported through `failure` without hiding the others. `enabled: false` pauses reading, and
 * turning it back on reads again.
 */
export function useLatestRuns(
  audit: AuditClient,
  projects: Project[] | null,
  options: { enabled?: boolean } = {},
): LatestRuns {
  const enabled = options.enabled ?? true;
  const [rows, setRows] = useState<LatestRunRow[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [tick, setTick] = useState(0);

  // `tick` only forces a re-read.
  useEffect(() => {
    if (projects === null || !enabled) return;
    let cancelled = false;
    Promise.allSettled(projects.map((project) => audit.history(project.id, 1))).then((results) => {
      if (cancelled) return;
      const found: LatestRunRow[] = [];
      let firstError: unknown;
      results.forEach((result, i) => {
        const project = projects[i];
        if (result.status === "rejected") firstError ??= result.reason;
        else if (project && result.value[0]) found.push({ project, run: result.value[0] });
      });
      found.sort(
        (a, b) => (b.run.finishedAt ?? b.run.startedAt) - (a.run.finishedAt ?? a.run.startedAt),
      );
      setRows(found);
      // Replaced only now: while a re-read is in flight the previous failure stands, so a partial
      // list is never presented as complete in the meantime.
      if (firstError === undefined) setFailure(null);
      else {
        const err = toCallError(firstError);
        setFailure({ code: err.code, detail: err.message });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [audit, projects, enabled, tick]);

  const refetch = useCallback(() => setTick((n) => n + 1), []);

  return { rows, failure, failed: failure !== null, loading: rows === null, refetch };
}
