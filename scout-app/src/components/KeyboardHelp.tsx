import { useEffect, useState } from "react";
import { CircleHelp, X } from "lucide-react";

const SHORTCUTS = [
  ["A", "Advance"],
  ["Shift A", "Add context first"],
  ["D", "Not useful"],
  ["Shift D", "Decline with a reason"],
  ["M", "I’ll take it"],
  ["C", "Comment with Scout"],
  ["↓", "Go deeper"],
  ["←  →", "Browse the queue"],
] as const;

export default function KeyboardHelp() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape" || event.key === "?") setOpen(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  return (
    <div className="shortcut-help-wrap">
      <button
        type="button"
        className="shortcut-help-trigger"
        onClick={() => setOpen((value) => !value)}
        aria-label="Keyboard shortcuts"
        aria-expanded={open}
      >
        <CircleHelp size={17} />
      </button>
      {open && (
        <div className="shortcut-popover" role="dialog" aria-label="Keyboard shortcuts">
          <div className="shortcut-popover-header">
            <strong>Quick actions</strong>
            <button type="button" onClick={() => setOpen(false)} aria-label="Close keyboard shortcuts"><X size={14} /></button>
          </div>
          <div className="shortcut-list">
            {SHORTCUTS.map(([key, label]) => (
              <div key={key} className="shortcut-row">
                <span>{label}</span><kbd>{key}</kbd>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
