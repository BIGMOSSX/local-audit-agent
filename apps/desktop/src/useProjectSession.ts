import type { Project } from "@audit/audit-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ClientErrorCode, type ProjectClient, toCallError } from "./ipc";

export interface Failure {
  code: ClientErrorCode;
  detail: string;
}

export interface ProjectSession {
  projects: Project[] | null;
  failure: Failure | null;
  alreadyListed: boolean;
  tooMany: boolean;
  busy: boolean;
  isBusy(): boolean;
  openPaths(paths: readonly string[]): Promise<void>;
  pickAndOpen(pick: () => Promise<string | null>): Promise<void>;
}

const MAX_PER_DROP = 20;

export function useProjectSession(client: ProjectClient): ProjectSession {
  const [projects, setProjectsState] = useState<Project[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [alreadyListed, setAlreadyListed] = useState(false);
  const [tooMany, setTooMany] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const projectsRef = useRef<Project[] | null>(null);

  const setProjects = useCallback((list: Project[]) => {
    projectsRef.current = list;
    setProjectsState(list);
  }, []);

  const report = useCallback((raw: unknown) => {
    const err = toCallError(raw);
    setFailure({ code: err.code, detail: err.message });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // A folder opened before the first read finishes already set a fresher list; keep it.
    client.list().then(
      (list) => {
        if (!cancelled && projectsRef.current === null) setProjects(list);
      },
      (raw) => {
        if (cancelled) return;
        if (projectsRef.current === null) setProjects([]);
        report(raw);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [client, report, setProjects]);

  // Native drop events arrive outside React, so the gate is a ref: state would be stale between events.
  const exclusive = useCallback(async (job: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await job();
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const clearNotices = useCallback(() => {
    setFailure(null);
    setAlreadyListed(false);
    setTooMany(false);
  }, []);

  const openAll = useCallback(
    async (requested: readonly string[]) => {
      clearNotices();
      const unique = [...new Set(requested)];
      const paths = unique.slice(0, MAX_PER_DROP);
      if (unique.length > paths.length) setTooMany(true);
      const known = new Set((projectsRef.current ?? []).map((p) => p.id));
      let opened = 0;
      let duplicates = 0;
      let failed = false;
      let firstError: unknown;
      const fail = (raw: unknown) => {
        if (!failed) firstError = raw;
        failed = true;
      };
      for (const path of paths) {
        try {
          const project = await client.open(path);
          opened += 1;
          if (known.has(project.id)) duplicates += 1;
          known.add(project.id);
        } catch (raw) {
          fail(raw);
        }
      }
      if (opened > 0) {
        try {
          setProjects(await client.list());
        } catch (raw) {
          fail(raw);
        }
      }
      if (failed) report(firstError);
      else if (opened > 0 && opened === duplicates) setAlreadyListed(true);
    },
    [client, clearNotices, report, setProjects],
  );

  const openPaths = useCallback(
    (paths: readonly string[]) =>
      paths.length === 0 ? Promise.resolve() : exclusive(() => openAll(paths)),
    [exclusive, openAll],
  );

  const pickAndOpen = useCallback(
    (pick: () => Promise<string | null>) =>
      exclusive(async () => {
        clearNotices();
        let path: string | null;
        try {
          path = await pick();
        } catch (raw) {
          report(raw);
          return;
        }
        if (path !== null) await openAll([path]);
      }),
    [clearNotices, exclusive, openAll, report],
  );

  const isBusy = useCallback(() => busyRef.current, []);

  return { projects, failure, alreadyListed, tooMany, busy, isBusy, openPaths, pickAndOpen };
}
