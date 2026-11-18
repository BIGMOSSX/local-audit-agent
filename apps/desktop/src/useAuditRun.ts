import type { AuditRun, Finding } from "@audit/audit-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type AuditClient, toCallError } from "./ipc";
import type { Failure } from "./useProjectSession";

export type AuditPhase = "loading" | "idle" | "starting" | "running" | "cancelling" | "finished";

export interface AuditRunState {
  phase: AuditPhase;
  run: AuditRun | null;
  /** null until the finished run's findings have been loaded (see findingsFailure). */
  findings: Finding[] | null;
  failure: Failure | null;
  findingsFailure: Failure | null;
  start(): Promise<void>;
  cancel(): Promise<void>;
  refresh(): Promise<void>;
  retryFindings(): Promise<void>;
}

const POLL_MS = 1000;
const HISTORY_ALL = 50;
const REVALIDATE_MS = 250;

const toFailure = (raw: unknown): Failure => {
  const err = toCallError(raw);
  return { code: err.code, detail: err.message };
};

/**
 * Follows one project's newest audit run (or the run `runId`). Everything asynchronous is
 * checked against `epochRef`, which changes when the project or run changes, when a new run is
 * started, and on unmount, so a late reply can never touch state that no longer belongs to it.
 */
export function useAuditRun(audit: AuditClient, projectId: string, runId?: string): AuditRunState {
  const [run, setRunState] = useState<AuditRun | null>(null);
  const [findings, setFindings] = useState<Finding[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [findingsFailure, setFindingsFailure] = useState<Failure | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [starting, setStarting] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const epochRef = useRef(0);
  const runRef = useRef<AuditRun | null>(null);
  const startingRef = useRef(false);
  const cancellingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const findingsRunRef = useRef<string | null>(null);
  const revalidateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const revalidatingRef = useRef(false);
  /** The run being followed: the opened run's id, then the run started from it. null = newest. */
  const followRef = useRef<string | null>(runId ?? null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const loadFindings = useCallback(
    (target: AuditRun) => {
      if (findingsRunRef.current === target.id) return;
      findingsRunRef.current = target.id;
      setFindingsFailure(null);
      if (target.findingCount === 0) {
        setFindings([]);
        return;
      }
      setFindings(null);
      const epoch = epochRef.current;
      const stillCurrent = () => epochRef.current === epoch && findingsRunRef.current === target.id;
      audit.findings(target.id).then(
        (list) => {
          if (stillCurrent()) setFindings(list);
        },
        (raw) => {
          if (stillCurrent()) setFindingsFailure(toFailure(raw));
        },
      );
    },
    [audit],
  );

  /** Takes a run reply into state. Returns false when it is older than what is already shown. */
  const accept = useCallback(
    (incoming: AuditRun): boolean => {
      const current = runRef.current;
      if (current && current.id === incoming.id && current.status !== "running") {
        if (incoming.status === "running") return false;
      }
      if (current?.id !== incoming.id) {
        findingsRunRef.current = null;
        setFindings(null);
        setFindingsFailure(null);
      }
      runRef.current = incoming;
      setRunState(incoming);
      if (incoming.status !== "running") loadFindings(incoming);
      return true;
    },
    [loadFindings],
  );

  const sync = useCallback(async (): Promise<void> => {
    const epoch = epochRef.current;
    const follow = followRef.current;
    clearTimer();
    try {
      const list = await audit.history(projectId, follow ? HISTORY_ALL : 1);
      if (epochRef.current !== epoch) return;
      const next = follow ? (list.find((r) => r.id === follow) ?? null) : (list[0] ?? null);
      if (next) accept(next);
      setLoaded(true);
    } catch (raw) {
      if (epochRef.current !== epoch) return;
      setFailure(toFailure(raw));
      setLoaded(true);
      return;
    }
    if (epochRef.current === epoch && runRef.current?.status === "running") {
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void sync();
      }, POLL_MS);
    }
  }, [audit, projectId, accept, clearTimer]);

  /**
   * Quiet re-read of the shown, finished run: only its `stale` flag can change (a finished run is
   * immutable), and the user may have edited the project in another window. Never shows an error.
   */
  const revalidate = useCallback(async (): Promise<void> => {
    const current = runRef.current;
    if (!current || current.status === "running" || revalidatingRef.current) return;
    revalidatingRef.current = true;
    const epoch = epochRef.current;
    try {
      const list = await audit.history(projectId, followRef.current ? HISTORY_ALL : 1);
      if (epochRef.current !== epoch) return;
      const latest = runRef.current;
      const same = list.find((r) => r.id === latest?.id);
      if (latest && same && same.status !== "running" && same.stale !== latest.stale) {
        const next = { ...latest, stale: same.stale };
        runRef.current = next;
        setRunState(next);
      }
    } catch {
      /* nothing to say: the run on screen is still the run that was checked */
    } finally {
      if (epochRef.current === epoch) revalidatingRef.current = false;
    }
  }, [audit, projectId]);

  useEffect(() => {
    const onReturn = (): void => {
      if (document.visibilityState === "hidden") return;
      if (revalidateTimerRef.current !== null) clearTimeout(revalidateTimerRef.current);
      revalidateTimerRef.current = setTimeout(() => {
        revalidateTimerRef.current = null;
        void revalidate();
      }, REVALIDATE_MS);
    };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
      if (revalidateTimerRef.current !== null) {
        clearTimeout(revalidateTimerRef.current);
        revalidateTimerRef.current = null;
      }
    };
  }, [revalidate]);

  useEffect(() => {
    epochRef.current += 1;
    revalidatingRef.current = false;
    runRef.current = null;
    findingsRunRef.current = null;
    followRef.current = runId ?? null;
    startingRef.current = false;
    cancellingRef.current = false;
    setRunState(null);
    setFindings(null);
    setFailure(null);
    setFindingsFailure(null);
    setLoaded(false);
    setStarting(false);
    setCancelling(false);
    void sync();
    return () => {
      epochRef.current += 1;
      clearTimer();
    };
  }, [sync, clearTimer, runId]);

  const start = useCallback(async (): Promise<void> => {
    if (startingRef.current || runRef.current?.status === "running") return;
    startingRef.current = true;
    setStarting(true);
    setFailure(null);
    const epoch = epochRef.current;
    try {
      const started = await audit.run(projectId);
      if (epochRef.current !== epoch) return;
      epochRef.current += 1;
      clearTimer();
      runRef.current = null;
      if (followRef.current !== null) followRef.current = started.id;
      accept(started);
      startingRef.current = false;
      setStarting(false);
      cancellingRef.current = false;
      setCancelling(false);
      if (started.status === "running") {
        const next = epochRef.current;
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          if (epochRef.current === next) void sync();
        }, POLL_MS);
      }
    } catch (raw) {
      if (epochRef.current !== epoch) return;
      startingRef.current = false;
      setStarting(false);
      setFailure(toFailure(raw));
    }
  }, [audit, projectId, accept, clearTimer, sync]);

  const cancel = useCallback(async (): Promise<void> => {
    const target = runRef.current;
    if (target?.status !== "running" || cancellingRef.current) return;
    cancellingRef.current = true;
    setCancelling(true);
    setFailure(null);
    const epoch = epochRef.current;
    try {
      const reply = await audit.cancel(target.id);
      if (epochRef.current !== epoch) return;
      accept(reply);
      clearTimer();
      if (reply.status === "running") {
        // Abort is already signalled; cancellingRef stays set so the button reads 取消中 until the run ends.
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void sync();
        }, POLL_MS);
      } else {
        // `stale` is only known to audit.history, never to the reply of audit.cancel.
        void sync();
      }
    } catch (raw) {
      if (epochRef.current !== epoch) return;
      setFailure(toFailure(raw));
      cancellingRef.current = false;
      setCancelling(false);
    }
  }, [audit, accept, clearTimer, sync]);

  const refresh = useCallback(async (): Promise<void> => {
    setFailure(null);
    await sync();
  }, [sync]);

  const retryFindings = useCallback(async (): Promise<void> => {
    const current = runRef.current;
    if (!current || current.status === "running") return;
    findingsRunRef.current = null;
    loadFindings(current);
  }, [loadFindings]);

  let phase: AuditPhase;
  if (starting) phase = "starting";
  else if (!loaded) phase = "loading";
  else if (!run) phase = "idle";
  else if (run.status === "running") phase = cancelling ? "cancelling" : "running";
  else phase = "finished";

  return { phase, run, findings, failure, findingsFailure, start, cancel, refresh, retryFindings };
}
