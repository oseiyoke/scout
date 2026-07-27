import { useEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ArrowRight, ArrowUpRight, Bot, CircleX, ExternalLink, MessageCircle, Send } from "lucide-react";
import type { EvidenceItem, Proposal } from "../lib/types";
import { reviseProposal } from "../lib/judgments";
import { emit } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ActionPlan, actionSummary } from "./Card";
import KeyboardHelp from "./KeyboardHelp";

interface Props {
  proposal: Proposal;
  focusChat?: boolean;
  onClose: () => void;
  onRun: () => void;
  onDismiss: () => void;
  onDismissWithReason: () => void;
  onTakeover: () => void;
}

export default function CardExpanded({
  proposal,
  focusChat = false,
  onClose,
  onRun,
  onDismiss,
  onDismissWithReason,
  onTakeover,
}: Props) {
  const [recommendation, setRecommendation] = useState(() => actionSummary(proposal));
  const [draft, setDraft] = useState(proposal.draft);
  const [message, setMessage] = useState("");
  const [history, setHistory] = useState<{ role: "user" | "assistant"; content: string }[]>([]);
  const [responding, setResponding] = useState(false);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const evidence = safeParse<EvidenceItem[]>(proposal.evidence, []);

  useEffect(() => {
    setRecommendation(actionSummary(proposal));
    setDraft(proposal.draft);
  }, [proposal]);

  useEffect(() => {
    if (focusChat) requestAnimationFrame(() => composerRef.current?.focus());
  }, [focusChat]);

  const sendMessage = async () => {
    const instruction = message.trim();
    if (!instruction || responding) return;
    const nextHistory = [...history, { role: "user" as const, content: instruction }];
    setHistory(nextHistory);
    setResponding(true);
    setMessage("");
    try {
      const current = { ...proposal, draft, recommended_action: recommendation };
      const response = await reviseProposal(current, instruction, history);
      setRecommendation(response.recommendedAction);
      setDraft(response.draft);
      setHistory([...nextHistory, { role: "assistant", content: response.message }]);
      await emit("scout:proposals", {});
    } catch (error) {
      setHistory([
        ...nextHistory,
        { role: "assistant", content: `I couldn’t complete that: ${error instanceof Error ? error.message : String(error)}` },
      ]);
    } finally {
      setResponding(false);
    }
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const tag = (event.target as HTMLElement | null)?.tagName;
      const composing = tag === "INPUT" || tag === "TEXTAREA";
      if (event.key === "Escape" && !composing) onClose();
      if (composing) return;
      const key = event.key.toLowerCase();
      if (key === "a" && event.shiftKey) {
        event.preventDefault();
        composerRef.current?.focus();
      } else if (key === "a") {
        event.preventDefault();
        onRun();
      } else if (key === "d" && event.shiftKey) {
        event.preventDefault();
        onDismissWithReason();
      } else if (key === "d") {
        event.preventDefault();
        onDismiss();
      } else if (key === "m") {
        event.preventDefault();
        onTakeover();
      } else if (key === "c") {
        event.preventDefault();
        composerRef.current?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onRun, onDismiss, onDismissWithReason, onTakeover]);

  return (
    <motion.div
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 24 }}
      className="proposal-detail"
    >
      <div className="proposal-detail-header">
        <button onClick={onClose} className="detail-back-button">
          <ArrowLeft size={15} /> Back to queue
        </button>
        <div className="detail-header-help"><KeyboardHelp /></div>
      </div>

      <div className="proposal-detail-body scroll-thin">
        <div className="detail-context-column">
          <div className="detail-eyebrow">Signal</div>
          <h1 className="detail-title">{proposal.headline}</h1>
          <p className="detail-observation">{proposal.observation}</p>

          <section className="detail-recommendation">
            <div className="detail-recommendation-icon"><Bot size={17} /></div>
            <div>
              <div className="detail-recommendation-label">Scout recommends</div>
              <p>{recommendation}</p>
              {draft && <blockquote>{draft}</blockquote>}
            </div>
          </section>

          {proposal.action_kind === "tool_call" && <ActionPlan plan={proposal.action_plan} />}

          <h3 className="detail-section-title">Evidence <span>{evidence.length} source{evidence.length === 1 ? "" : "s"}</span></h3>
          <div className="evidence-list">
            {evidence.map((item, index) => (
              <details key={index} className="evidence-detail">
                <summary>
                  <span>{item.source}</span><small>{item.ref}</small>
                </summary>
                <blockquote>“{item.quote}”</blockquote>
                {item.url && (
                  <button onClick={() => void openUrl(item.url!)}>
                    Open source <ExternalLink size={12} />
                  </button>
                )}
              </details>
            ))}
          </div>
        </div>

        <section className="task-chat-panel">
          <div className="task-chat-header">
            <div className="task-chat-avatar"><Bot size={17} /></div>
            <div><strong>Scout on this task</strong><span>Can inspect sources and update the plan</span></div>
          </div>
          <div className="task-chat-history scroll-thin" aria-live="polite">
            {history.length === 0 && (
              <div className="task-chat-empty">Ask Scout to investigate the source, explain the recommendation, or change the plan.</div>
            )}
            {history.map((item, index) => (
              <div key={index} className={`task-chat-message task-chat-message-${item.role}`}>
                <span>{item.role === "user" ? "You" : "Scout"}</span>
                <p>{item.content}</p>
              </div>
            ))}
            {responding && <div className="task-chat-thinking"><i /><i /><i /></div>}
          </div>
          <div className="task-chat-composer">
            <textarea
              ref={composerRef}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  void sendMessage();
                }
              }}
              rows={2}
              placeholder="Ask Scout about this task…"
              aria-label="Message Scout about this task"
            />
            <button onClick={() => void sendMessage()} disabled={responding || !message.trim()} aria-label="Send message">
              <Send size={16} />
            </button>
          </div>
        </section>
      </div>

      <div className="proposal-detail-footer">
        <VerbButton label="Not useful" shortcut="D" icon={<CircleX size={16} />} onClick={onDismiss} tone="danger" />
        <VerbButton label="I’ll take it" shortcut="M" icon={<ArrowUpRight size={16} />} onClick={onTakeover} tone="muted" />
        <VerbButton label="Comment" shortcut="C" icon={<MessageCircle size={16} />} onClick={() => composerRef.current?.focus()} tone="muted" />
        <VerbButton label="Advance" shortcut="A" icon={<ArrowRight size={16} />} onClick={onRun} tone="primary" />
      </div>
    </motion.div>
  );
}

function VerbButton({ label, shortcut, icon, onClick, tone }: { label: string; shortcut: string; icon: ReactNode; onClick: () => void; tone: "primary" | "danger" | "muted" }) {
  return (
    <button
      onClick={onClick}
      className={`detail-verb-button ${tone === "primary" ? "detail-verb-button-primary" : tone === "danger" ? "detail-verb-button-danger" : ""}`}
    >
      {icon}<span>{label}</span><kbd>{shortcut}</kbd>
    </button>
  );
}

function safeParse<T>(json: string, fallback: T): T {
  try {
    return JSON.parse(json) as T;
  } catch {
    return fallback;
  }
}
