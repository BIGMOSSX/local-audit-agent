import type { Finding } from "@audit/audit-core";
import { useCallback, useEffect, useState } from "react";
import { type AuditClient, toCallError } from "./ipc";
import type { Failure } from "./useProjectSession";

export interface RunFindings {
  /** null until the list of exactly this run has arrived; never another run's list. */
  findings: Finding[] | null;
  failure: Failure | null;
  ready: boolean;
  retry: () => void;
}

interface Slot {
  key: string;
  findings: Finding[] | null;
  failure: Failure | null;
}

/** Loads the whole stored finding list of one run once; null id asks nothing. */
export function useRunFindings(audit: AuditClient, runId: string | null): RunFindings {
  const [slot, setSlot] = useState<Slot | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (runId === null) return;
    const key = `${runId}#${attempt}`;
    let live = true;
    audit.findings(runId).then(
      (list) => {
        if (live) setSlot({ key, findings: list, failure: null });
      },
      (raw) => {
        if (!live) return;
        const err = toCallError(raw);
        setSlot({ key, findings: null, failure: { code: err.code, detail: err.message } });
      },
    );
    return () => {
      live = false;
    };
  }, [audit, runId, attempt]);

  const retry = useCallback(() => {
    setSlot(null);
    setAttempt((n) => n + 1);
  }, []);

  const current =
    runId !== null && slot !== null && slot.key === `${runId}#${attempt}` ? slot : null;
  return {
    findings: current?.findings ?? null,
    failure: current?.failure ?? null,
    ready: current?.findings != null,
    retry,
  };
}
