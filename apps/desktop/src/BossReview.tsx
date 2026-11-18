import { type ReactNode, useId, useState } from "react";
import { t } from "./i18n";

/** 备查: the always-visible part stays on the page; the rest opens on demand. Screen only, never printed. */
export function BossReview({
  summary,
  children,
  className,
}: {
  summary: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const bodyId = useId();
  return (
    <section
      aria-label={t("boss.review.title")}
      className={`boss-card no-print flex flex-col gap-3 p-4 text-sm${className ? ` ${className}` : ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="boss-label">{t("boss.review.title")}</h2>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((v) => !v)}
          className="boss-secondary px-3 py-1"
        >
          {open ? t("boss.review.collapse") : t("boss.review.expand")}
        </button>
      </div>
      <div className="flex flex-col gap-1">{summary}</div>
      <div id={bodyId} hidden={!open} className="flex flex-col gap-3">
        {open ? children : null}
      </div>
    </section>
  );
}
