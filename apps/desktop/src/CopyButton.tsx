import { Button } from "@audit/ui";
import { useCallback, useEffect, useRef, useState } from "react";

export type CopyState = "idle" | "copied" | "failed";

/** Clipboard write with an outcome; a reply that arrives after unmount changes nothing. */
export function useCopy(getText: () => string) {
  const [state, setState] = useState<CopyState>("idle");
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(getText());
      if (aliveRef.current) setState("copied");
    } catch {
      if (aliveRef.current) setState("failed");
    }
  }, [getText]);

  return { state, copy };
}

export interface CopyButtonProps {
  /** Read when the button is pressed, and again for the manual-copy box after a failure. */
  getText: () => string;
  label: string;
  copiedLabel: string;
  failedLabel: string;
  variant?: "primary" | "secondary";
  isDisabled?: boolean;
  className?: string;
  /** Classes for the button itself (the skin hooks), not the wrapper. */
  buttonClassName?: string;
}

export function CopyButton(props: CopyButtonProps) {
  const {
    getText,
    label,
    copiedLabel,
    failedLabel,
    variant,
    isDisabled,
    className,
    buttonClassName,
  } = props;
  const { state, copy } = useCopy(getText);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state === "failed") boxRef.current?.select();
  }, [state]);

  return (
    <div className={`flex flex-col gap-2${className ? ` ${className}` : ""}`}>
      <div>
        <Button
          variant={variant ?? "secondary"}
          isDisabled={isDisabled}
          className={buttonClassName}
          onPress={() => void copy()}
        >
          {label}
        </Button>
        {state === "copied" && (
          <span role="status" className="ml-3 text-sm">
            {copiedLabel}
          </span>
        )}
      </div>
      {state === "failed" && (
        <>
          <p role="status" className="text-sm">
            {failedLabel}
          </p>
          <textarea
            ref={boxRef}
            readOnly
            rows={8}
            value={getText()}
            onFocus={(e) => e.currentTarget.select()}
            aria-label={label}
            className="w-full rounded border border-divider p-2 text-sm"
          />
        </>
      )}
    </div>
  );
}
