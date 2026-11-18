import type { LocalModelService } from "@audit/audit-core";
import { useCallback, useEffect, useRef, useState } from "react";
import { type ModelClient, toCallError } from "./ipc";
import type { Failure } from "./useProjectSession";

export interface LocalModels {
  services: LocalModelService[] | null;
  failure: Failure | null;
  detecting: boolean;
  detect(): Promise<void>;
}

// Looks once on mount (the view is only mounted while 设置 is open) and again on request.
export function useLocalModels(client: ModelClient): LocalModels {
  const [services, setServices] = useState<LocalModelService[] | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [detecting, setDetecting] = useState(false);
  const runningRef = useRef(false);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const detect = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setDetecting(true);
    setFailure(null);
    try {
      const found = await client.list();
      if (aliveRef.current) setServices(found);
    } catch (raw) {
      const err = toCallError(raw);
      if (aliveRef.current) {
        setServices([]);
        setFailure({ code: err.code, detail: err.message });
      }
    } finally {
      runningRef.current = false;
      if (aliveRef.current) setDetecting(false);
    }
  }, [client]);

  useEffect(() => {
    void detect();
  }, [detect]);

  return { services, failure, detecting, detect };
}
