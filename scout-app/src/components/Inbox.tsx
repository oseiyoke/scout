import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence } from "framer-motion";
import { ChevronLeft, ChevronRight, LoaderCircle, Radar, RotateCcw } from "lucide-react";
import Card from "./Card";
import CardExpanded from "./CardExpanded";
import KeyboardHelp from "./KeyboardHelp";
import { applyVerb, undoDecision } from "../lib/proposals";
import { executeProposal } from "../lib/executor";
import { distillDenial, recordTakeover } from "../lib/judgments";
import { useScout } from "../state/store";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Proposal } from "../lib/types";

interface UndoEntry {
  id: string;
  label: string;
  expires: number;
}

export default function Inbox({ onSweepNow, sweeping }: { onSweepNow: () => void; sweeping: boolean }) {
  const proposals = useScout((s) => s.proposals);
  const settings = useScout((s) => s.settings);
  const [queue, setQueue] = useState<Proposal[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [focusExpandedChat, setFocusExpandedChat] = useState(false);
  const [whyNotFor, setWhyNotFor] = useState<Proposal | null>(null);
  const [undo, setUndo] = useState<UndoEntry | null>(null);
  const undoTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Deck shows open proposals; failed cards stay so the error is visible.
  useEffect(() => {
    setQueue(proposals.filter((p) => p.status === "proposed" || p.status === "failed"));
  }, [proposals]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(0, queue.length - 1)));
  }, [queue.length]);

  const pushUndo = (entry: Omit<UndoEntry, "expires">) => {
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo({ ...entry, expires: Date.now() + 5000 });
    undoTimer.current = setTimeout(() => setUndo(null), 5000);
  };

  const runIt = useCallback(async (p: Proposal) => {
    await applyVerb(p.id, "run");
    pushUndo({ id: p.id, label: "Advancing" });
    if (p.action_kind === "draft_only" || p.action_kind === "fyi") {
      if (p.draft) await navigator.clipboard.writeText(p.draft).catch(() => {});
      const ev = JSON.parse(p.evidence || "[]") as { url?: string }[];
      const url = ev.find((e) => e.url)?.url;
      if (url) await openUrl(url).catch(() => {});
      await executeProposal(p.id);
    } else {
      await executeProposal(p.id);
    }
  }, []);

  const dismissWithReason = useCallback((p: Proposal) => {
    setWhyNotFor(p);
  }, []);

  const dismiss = useCallback(async (p: Proposal) => {
    await applyVerb(p.id, "dismiss");
    pushUndo({ id: p.id, label: "Dismissed" });
  }, []);

  const takeover = useCallback(async (p: Proposal) => {
    await applyVerb(p.id, "takeover");
    await recordTakeover(p);
    pushUndo({ id: p.id, label: "You're taking it" });
  }, []);

  const navigate = useCallback(
    (direction: "next" | "previous") => {
      if (queue.length < 2) return;
      setActiveIndex((index) => direction === "next"
        ? (index + 1) % queue.length
        : (index - 1 + queue.length) % queue.length);
    },
    [queue.length],
  );

  const decide = useCallback((decision: "approve" | "dismiss" | "takeover") => {
    const active = queue[activeIndex];
    if (!active) return;
    if (decision === "approve") void runIt(active);
    else if (decision === "dismiss") void dismiss(active);
    else void takeover(active);
  }, [queue, activeIndex, runIt, dismiss, takeover]);

  // Browsing never records a decision: arrow keys only move through the queue.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (expandedId || whyNotFor) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const active = queue[activeIndex];
      if (!active) return;
      const key = e.key.toLowerCase();
      if (e.key === "ArrowRight") navigate("next");
      else if (e.key === "ArrowLeft") navigate("previous");
      else if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocusExpandedChat(false);
        setExpandedId(active.id);
      } else if (key === "a" && e.shiftKey) {
        e.preventDefault();
        setFocusExpandedChat(true);
        setExpandedId(active.id);
      } else if (key === "a") {
        e.preventDefault();
        void runIt(active);
      } else if (key === "d" && e.shiftKey) {
        e.preventDefault();
        dismissWithReason(active);
      } else if (key === "d") {
        e.preventDefault();
        void dismiss(active);
      } else if (key === "m") {
        e.preventDefault();
        void takeover(active);
      } else if (key === "c") {
        e.preventDefault();
        setFocusExpandedChat(true);
        setExpandedId(active.id);
      } else if (key === "u") {
        void doUndo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [navigate, expandedId, whyNotFor, undo, queue, activeIndex, runIt, dismiss, dismissWithReason, takeover]);

  const doUndo = async () => {
    if (!undo) return;
    if (undoTimer.current) clearTimeout(undoTimer.current);
    setUndo(null);
    await undoDecision(undo.id);
  };

  const submitWhyNot = async (reason: string | null) => {
    const p = whyNotFor;
    setWhyNotFor(null);
    if (!p) return;
    await applyVerb(p.id, "dismiss", reason ?? undefined);
    pushUndo({ id: p.id, label: "Dismissed" });
    if (reason?.trim()) void distillDenial(p, reason.trim());
  };

  const expanded = expandedId ? (queue.find((p) => p.id === expandedId) ?? null) : null;
  const active = queue[activeIndex] ?? null;
  const nextSweepMin = settings?.sweep_interval_minutes ?? 30;

  return (
    <div className="inbox-view">
      {queue.length === 0 ? (
        <div className="empty-signal-state">
          <div className="empty-signal-visual"><Radar size={28} /></div>
          <div className="empty-signal-eyebrow">Signal check complete</div>
          <div className="empty-signal-title">You’re all clear</div>
          <div className="empty-signal-copy">Scout will check again in about {nextSweepMin} minutes.</div>
          <button
            onClick={onSweepNow}
            disabled={sweeping}
            className="sweep-button mt-5"
          >
            {sweeping ? <LoaderCircle size={16} className="animate-spin" /> : <Radar size={16} />}
            {sweeping ? "Sweeping" : "Check again now"}
          </button>
        </div>
      ) : (
        <div className="decision-stage">
          <div className="decision-stage-heading">
            <span className="decision-position">Decision {activeIndex + 1} of {queue.length}</span>
            <div className="queue-navigation" aria-label="Browse decision queue">
              <KeyboardHelp />
              <button onClick={() => navigate("previous")} disabled={queue.length < 2} aria-label="Previous decision"><ChevronLeft size={17} /></button>
              <button onClick={() => navigate("next")} disabled={queue.length < 2} aria-label="Next decision"><ChevronRight size={17} /></button>
            </div>
          </div>
          <div className="proposal-deck">
          <AnimatePresence mode="wait">
            {active && (
              <Card
                key={active.id}
                proposal={active}
                onDecision={decide}
                onNavigate={navigate}
                onExpand={(focusChat = false) => {
                  setFocusExpandedChat(focusChat);
                  setExpandedId(active.id);
                }}
              />
            )}
          </AnimatePresence>
          </div>
        </div>
      )}

      {/* Optional context after the user explicitly marks a proposal not useful. */}
      <AnimatePresence>
        {whyNotFor && (
          <WhyNot prompt={whyNotFor.headline} onSubmit={submitWhyNot} />
        )}
      </AnimatePresence>

      {/* Undo toast */}
      <AnimatePresence>
        {undo && (
          <div className="undo-toast">
            <span>{undo.label}</span>
            <button onClick={doUndo}>
              <RotateCcw size={13} /> Undo
            </button>
          </div>
        )}
      </AnimatePresence>

      {/* Dig deeper */}
      <AnimatePresence>
        {expanded && (
          <CardExpanded
            proposal={expanded}
            focusChat={focusExpandedChat}
            onClose={() => {
              setExpandedId(null);
              setFocusExpandedChat(false);
            }}
            onRun={() => {
              setExpandedId(null);
              void runIt(expanded);
            }}
            onDismiss={() => {
              setExpandedId(null);
              void dismiss(expanded);
            }}
            onDismissWithReason={() => {
              setExpandedId(null);
              dismissWithReason(expanded);
            }}
            onTakeover={() => {
              setExpandedId(null);
              void takeover(expanded);
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

function WhyNot({ prompt, onSubmit }: { prompt: string; onSubmit: (reason: string | null) => void }) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);
  return (
    <div className="modal-backdrop" onClick={() => onSubmit(null)}>
      <form
        className="why-not-dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(value.trim() || null);
        }}
      >
        <div className="dialog-eyebrow">Help Scout learn</div>
        <div className="dialog-title">What made this miss the mark?</div>
        <input
          ref={inputRef}
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onSubmit(null);
            }
          }}
          placeholder="Press Enter to save · Escape to skip"
          aria-label={`Why this proposal missed the mark: ${prompt}`}
          className="dialog-input"
        />
      </form>
    </div>
  );
}
