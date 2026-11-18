import type { Gate } from "@audit/audit-core";
import { t } from "./i18n";

const TONE: Record<Gate, string> = {
  blocked: "border-danger",
  review: "border-warning",
  ready: "border-success",
  none: "border-divider",
};

/**
 * A cancelled run reached no conclusion, so its words say so. A blocker already found stays red:
 * cancelling does not make a real problem go away. The gate itself is never changed, only the words.
 */
export function shownGate(gate: Gate, cancelled: boolean): Gate | "cancelled" {
  return cancelled && gate !== "blocked" ? "cancelled" : gate;
}

/** The gate is always a word; the border colour only supports it. */
export function GateBadge({ gate, cancelled = false }: { gate: Gate; cancelled?: boolean }) {
  const shown = shownGate(gate, cancelled);
  return (
    <span
      data-gate={gate}
      data-cancelled={shown === "cancelled" ? "" : undefined}
      className={`boss-badge inline-block rounded-full border-2 px-3 py-1 text-sm font-medium ${TONE[gate]}`}
    >
      {t(`gate.${shown}`)}
    </span>
  );
}
