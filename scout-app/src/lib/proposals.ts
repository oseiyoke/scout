import { getDb, nowIso, uuid } from "./db";
import type { Proposal, ProposalStatus } from "./types";
import { emit } from "@tauri-apps/api/event";

// ── Four-verb state machine ──────────────────────────────────────────────────
// proposed ──Run with it──► approved ──► executing ──► executed
//    │                                         └─────► failed ──(re-queue)──► proposed
//    ├─Not worth it─► dismissed
//    ├─I'll take it─► handled_by_human
//    └─(48h)────────► expired

const LEGAL: Record<ProposalStatus, ProposalStatus[]> = {
  proposed: ["approved", "dismissed", "handled_by_human", "expired"],
  approved: ["executing", "proposed"],
  executing: ["executed", "failed"],
  executed: [],
  failed: ["proposed", "approved"], // re-queue / retry
  dismissed: ["proposed"], // undo
  handled_by_human: ["proposed"], // undo
  expired: ["proposed"], // undo
};

export function canTransition(from: ProposalStatus, to: ProposalStatus): boolean {
  return LEGAL[from]?.includes(to) ?? false;
}

export class IllegalTransition extends Error {
  constructor(from: ProposalStatus, to: ProposalStatus) {
    super(`Illegal proposal transition: ${from} → ${to}`);
  }
}

async function emitChanged() {
  try {
    await emit("scout:proposals", {});
  } catch {
    // tests
  }
}

export async function getProposal(id: string): Promise<Proposal | null> {
  const db = await getDb();
  const rows = await db.select<Proposal[]>("SELECT * FROM proposals WHERE id=$1;", [id]);
  return rows[0] ?? null;
}

export async function transition(
  id: string,
  to: ProposalStatus,
  extra: Partial<Pick<Proposal, "denial_reason" | "execution_result">> = {},
): Promise<Proposal> {
  const p = await getProposal(id);
  if (!p) throw new Error(`Proposal ${id} not found`);
  if (!canTransition(p.status, to)) throw new IllegalTransition(p.status, to);
  const db = await getDb();
  const decided =
    to === "executed" || to === "dismissed" || to === "handled_by_human" || to === "expired" || to === "failed";
  await db.execute(
    `UPDATE proposals SET status=$1,
       decided_at = CASE WHEN $2 THEN $3 ELSE decided_at END,
       denial_reason = COALESCE($4, denial_reason),
       execution_result = COALESCE($5, execution_result)
     WHERE id=$6;`,
    [to, decided ? 1 : 0, nowIso(), extra.denial_reason ?? null, extra.execution_result ?? null, id],
  );
  await emitChanged();
  return (await getProposal(id))!;
}

export type Verb = "run" | "dismiss" | "takeover";

/** The user-facing verbs. "run" approves; the Executor picks it up from there. */
export async function applyVerb(id: string, verb: Verb, denialReason?: string): Promise<Proposal> {
  switch (verb) {
    case "run": {
      const proposal = await getProposal(id);
      if (!proposal) throw new Error(`Proposal ${id} not found`);
      if (!canTransition(proposal.status, "approved")) throw new IllegalTransition(proposal.status, "approved");
      const db = await getDb();
      await db.execute(
        "UPDATE proposals SET status='approved', approved_action_plan=action_plan WHERE id=$1;",
        [id],
      );
      await emitChanged();
      return (await getProposal(id))!;
    }
    case "dismiss":
      return transition(id, "dismissed", { denial_reason: denialReason ?? null });
    case "takeover":
      return transition(id, "handled_by_human");
  }
}

/** Undo a swipe: return a decided proposal to the inbox. */
export async function undoDecision(id: string): Promise<Proposal> {
  return transition(id, "proposed");
}

export async function listOpenProposals(): Promise<Proposal[]> {
  const db = await getDb();
  return db.select<Proposal[]>(
    `SELECT * FROM proposals WHERE status IN ('proposed','approved','executing','failed')
     ORDER BY CASE urgency WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, created_at DESC;`,
  );
}

export async function listDoneProposals(limit = 200): Promise<Proposal[]> {
  const db = await getDb();
  return db.select<Proposal[]>(
    `SELECT * FROM proposals WHERE status IN ('executed','dismissed','handled_by_human','expired')
     ORDER BY decided_at DESC LIMIT $1;`,
    [limit],
  );
}

export async function openDedupeKeys(): Promise<Set<string>> {
  const db = await getDb();
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();
  const rows = await db.select<{ dedupe_key: string }[]>(
    `SELECT dedupe_key FROM proposals
     WHERE status='proposed' OR (decided_at IS NOT NULL AND decided_at > $1);`,
    [since],
  );
  return new Set(rows.map((r) => r.dedupe_key));
}

/** Expire proposals older than 48h so the inbox never rots. */
export async function expireStaleProposals(expiryHours = 48): Promise<number> {
  const db = await getDb();
  const cutoff = new Date(Date.now() - expiryHours * 3600 * 1000).toISOString();
  const stale = await db.select<{ id: string }[]>(
    "SELECT id FROM proposals WHERE status='proposed' AND created_at < $1;",
    [cutoff],
  );
  for (const row of stale) await transition(row.id, "expired");
  return stale.length;
}

export async function insertProposal(
  p: Omit<Proposal, "id" | "created_at" | "status" | "decided_at" | "denial_reason" | "execution_result" | "approved_action_plan">,
): Promise<string | null> {
  const open = await openDedupeKeys();
  if (open.has(p.dedupe_key)) return null; // code-level dedupe (see plan §3 note)
  const db = await getDb();
  const id = uuid();
  await db.execute(
    `INSERT INTO proposals (id, sweep_id, created_at, status, category, urgency, confidence, headline,
       observation, recommended_action, evidence, action_kind, action_plan, draft, dedupe_key)
     VALUES ($1,$2,$3,'proposed',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14);`,
    [
      id,
      p.sweep_id,
      nowIso(),
      p.category,
      p.urgency,
      p.confidence,
      p.headline,
      p.observation,
      p.recommended_action,
      p.evidence,
      p.action_kind,
      p.action_plan,
      p.draft,
      p.dedupe_key,
    ],
  );
  await emitChanged();
  return id;
}
