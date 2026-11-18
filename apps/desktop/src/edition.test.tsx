import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EDITION_KEY,
  type Edition,
  type EditionEntitlement,
  EditionProvider,
  localEntitlement,
  useEdition,
  useIsBoss,
} from "./edition";

function Probe() {
  const { edition, stored, setEdition, allowed } = useEdition();
  return (
    <div>
      <output data-testid="edition">{edition}</output>
      <output data-testid="stored">{stored}</output>
      <output data-testid="boss-allowed">{String(allowed("boss"))}</output>
      <button type="button" onClick={() => setEdition("boss")}>
        to-boss
      </button>
      <button type="button" onClick={() => setEdition("easy")}>
        to-easy
      </button>
    </div>
  );
}

const denyBoss: EditionEntitlement = { allows: (e: Edition) => e !== "boss" };
const html = document.documentElement;
const text = (id: string) => screen.getByTestId(id).textContent;

function mount(props: { entitlement?: EditionEntitlement; prefersDark?: () => boolean } = {}) {
  return render(
    <EditionProvider {...props}>
      <Probe />
    </EditionProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  html.classList.remove("dark");
  delete html.dataset.edition;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("edition storage", () => {
  it("defaults to easy and writes nothing", () => {
    mount({ prefersDark: () => false });
    expect(text("edition")).toBe("easy");
    expect(text("stored")).toBe("easy");
    expect(window.localStorage.getItem(EDITION_KEY)).toBeNull();
  });

  it("reads a valid stored value", () => {
    window.localStorage.setItem(EDITION_KEY, "boss");
    mount({ prefersDark: () => false });
    expect(text("edition")).toBe("boss");
  });

  it.each(["gold", "", "BOSS", "easy ", "__proto__"])(
    "ignores the invalid stored value %j",
    (v) => {
      window.localStorage.setItem(EDITION_KEY, v);
      mount({ prefersDark: () => false });
      expect(text("edition")).toBe("easy");
    },
  );

  it("changing the edition writes the key and persists across a remount", async () => {
    const user = userEvent.setup();
    const first = mount({ prefersDark: () => false });
    await user.click(screen.getByRole("button", { name: "to-boss" }));
    expect(text("edition")).toBe("boss");
    expect(window.localStorage.getItem(EDITION_KEY)).toBe("boss");
    first.unmount();
    mount({ prefersDark: () => false });
    expect(text("edition")).toBe("boss");
  });

  it("survives localStorage throwing on read", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => mount({ prefersDark: () => false })).not.toThrow();
    expect(text("edition")).toBe("easy");
  });

  it("survives localStorage throwing on write; the switch still applies for this session", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const user = userEvent.setup();
    mount({ prefersDark: () => false });
    await user.click(screen.getByRole("button", { name: "to-boss" }));
    expect(text("edition")).toBe("boss");
    expect(html.dataset.edition).toBe("boss");
  });
});

describe("entitlement seam", () => {
  it("the local entitlement allows both editions", () => {
    expect(localEntitlement.allows("easy")).toBe(true);
    expect(localEntitlement.allows("boss")).toBe(true);
  });

  it("a denied stored boss is effectively easy and the stored value is kept", () => {
    window.localStorage.setItem(EDITION_KEY, "boss");
    mount({ entitlement: denyBoss, prefersDark: () => false });
    expect(text("edition")).toBe("easy");
    expect(text("stored")).toBe("boss");
    expect(text("boss-allowed")).toBe("false");
    expect(window.localStorage.getItem(EDITION_KEY)).toBe("boss");
    expect(html.dataset.edition).toBe("easy");
  });

  it("setEdition('boss') is refused when not allowed and nothing is written", async () => {
    const user = userEvent.setup();
    mount({ entitlement: denyBoss, prefersDark: () => false });
    await user.click(screen.getByRole("button", { name: "to-boss" }));
    expect(text("edition")).toBe("easy");
    expect(window.localStorage.getItem(EDITION_KEY)).toBeNull();
  });

  it("a regained entitlement makes the kept stored value effective again", () => {
    window.localStorage.setItem(EDITION_KEY, "boss");
    const first = mount({ entitlement: denyBoss, prefersDark: () => false });
    expect(text("edition")).toBe("easy");
    first.unmount();
    mount({ entitlement: localEntitlement, prefersDark: () => false });
    expect(text("edition")).toBe("boss");
  });
});

describe("appearance", () => {
  it("sets data-edition and follows the system preference in easy", () => {
    mount({ prefersDark: () => true });
    expect(html.dataset.edition).toBe("easy");
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("easy with a light system is not dark", () => {
    mount({ prefersDark: () => false });
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("boss is always dark, whatever the system says", async () => {
    window.localStorage.setItem(EDITION_KEY, "boss");
    mount({ prefersDark: () => false });
    expect(html.dataset.edition).toBe("boss");
    expect(html.classList.contains("dark")).toBe(true);
  });

  it("switching back to easy returns to the system preference", async () => {
    const user = userEvent.setup();
    mount({ prefersDark: () => false });
    await user.click(screen.getByRole("button", { name: "to-boss" }));
    expect(html.classList.contains("dark")).toBe(true);
    await user.click(screen.getByRole("button", { name: "to-easy" }));
    expect(html.dataset.edition).toBe("easy");
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("does not throw when matchMedia does not exist (the default preference is light)", () => {
    expect(typeof window.matchMedia).not.toBe("function");
    expect(() => mount()).not.toThrow();
    expect(html.classList.contains("dark")).toBe(false);
  });

  it("follows a system preference change while easy, and stops listening on unmount", () => {
    let matches = false;
    let listener: (() => void) | undefined;
    const removed = vi.fn();
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return matches;
        },
        addEventListener: (_: string, fn: () => void) => {
          listener = fn;
        },
        removeEventListener: removed,
      })),
    );
    const view = mount();
    expect(html.classList.contains("dark")).toBe(false);
    matches = true;
    act(() => listener?.());
    expect(html.classList.contains("dark")).toBe(true);
    view.unmount();
    expect(removed).toHaveBeenCalled();
  });

  it("unmounting removes what the provider put on the document", () => {
    const view = mount({ prefersDark: () => true });
    view.unmount();
    expect(html.dataset.edition).toBeUndefined();
    expect(html.classList.contains("dark")).toBe(false);
  });
});

describe("useEdition without a provider", () => {
  it("fails loudly instead of silently returning easy", () => {
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(() => render(<Probe />)).toThrow();
    quiet.mockRestore();
  });
});

describe("useIsBoss", () => {
  function IsBoss() {
    return <output data-testid="is-boss">{String(useIsBoss())}</output>;
  }

  it("is false without a provider (views stay usable on their own) and follows the edition", async () => {
    const { unmount } = render(<IsBoss />);
    expect(text("is-boss")).toBe("false");
    unmount();
    window.localStorage.setItem(EDITION_KEY, "boss");
    render(
      <EditionProvider prefersDark={() => false}>
        <IsBoss />
      </EditionProvider>,
    );
    expect(text("is-boss")).toBe("true");
  });

  it("is false when the entitlement refuses a stored boss", () => {
    window.localStorage.setItem(EDITION_KEY, "boss");
    render(
      <EditionProvider entitlement={denyBoss} prefersDark={() => false}>
        <IsBoss />
      </EditionProvider>,
    );
    expect(text("is-boss")).toBe("false");
  });
});
