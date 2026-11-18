import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type Edition = "easy" | "boss";

export const EDITION_KEY = "audit.edition";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const isEdition = (value: unknown): value is Edition => value === "easy" || value === "boss";

/** The seam for a later subscription tier: whoever decides which editions this install may use. */
export interface EditionEntitlement {
  allows(edition: Edition): boolean;
}

export const localEntitlement: EditionEntitlement = { allows: () => true };

function readStored(): Edition {
  try {
    const value = window.localStorage.getItem(EDITION_KEY);
    return isEdition(value) ? value : "easy";
  } catch {
    return "easy";
  }
}

function writeStored(edition: Edition): void {
  try {
    window.localStorage.setItem(EDITION_KEY, edition);
  } catch {
    /* the choice still applies for this session */
  }
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches;
}

interface EditionState {
  /** What the UI shows: the stored choice, unless the entitlement does not allow it. */
  edition: Edition;
  /** What the user last chose; kept even when it is not currently allowed. */
  stored: Edition;
  setEdition(edition: Edition): void;
  allowed(edition: Edition): boolean;
}

const EditionContext = createContext<EditionState | null>(null);

export function EditionProvider({
  entitlement = localEntitlement,
  prefersDark = systemPrefersDark,
  children,
}: {
  entitlement?: EditionEntitlement;
  prefersDark?: () => boolean;
  children: ReactNode;
}) {
  const [stored, setStored] = useState<Edition>(readStored);
  const [systemDark, setSystemDark] = useState<boolean>(() => prefersDark());
  const edition: Edition = entitlement.allows(stored) ? stored : "easy";

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(DARK_QUERY);
    const onChange = () => setSystemDark(prefersDark());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [prefersDark]);

  // The one place that decides how the document looks.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.edition = edition;
    root.classList.toggle("dark", edition === "boss" || systemDark);
    return () => {
      delete root.dataset.edition;
      root.classList.remove("dark");
    };
  }, [edition, systemDark]);

  const setEdition = useCallback(
    (next: Edition) => {
      if (!isEdition(next) || !entitlement.allows(next)) return;
      writeStored(next);
      setStored(next);
    },
    [entitlement],
  );
  const allowed = useCallback((next: Edition) => entitlement.allows(next), [entitlement]);

  const value = useMemo(
    () => ({ edition, stored, setEdition, allowed }),
    [edition, stored, setEdition, allowed],
  );
  return <EditionContext.Provider value={value}>{children}</EditionContext.Provider>;
}

export function useEdition(): EditionState {
  const value = useContext(EditionContext);
  if (!value) throw new Error("useEdition needs an EditionProvider");
  return value;
}

/** For presentation switches in views that may render without a provider (then: not BOSS). */
export function useIsBoss(): boolean {
  return useContext(EditionContext)?.edition === "boss";
}
