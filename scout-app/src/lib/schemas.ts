import { z } from "zod";
import { CATEGORIES, URGENCIES } from "./constants";

export const evidenceSchema = z.object({
  source: z.string(),
  connector_id: z.string(),
  ref: z.string(),
  quote: z.string(),
  url: z.string().optional(),
});

export const plannedToolCallSchema = z.object({
  connector_id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()).default({}),
});

export const proposalSchema = z.object({
  category: z.enum(CATEGORIES),
  urgency: z.enum(URGENCIES),
  confidence: z.number().min(0).max(1),
  headline: z.string().min(1),
  observation: z.string().min(1),
  recommended_action: z.string().min(1).max(200),
  evidence: z.array(evidenceSchema).min(1),
  action_kind: z.enum(["tool_call", "draft_only", "fyi"]),
  action_plan: z.array(plannedToolCallSchema).default([]),
  draft: z.string().nullable().default(null),
  dedupe_key: z.string().min(1),
});

export const sweepResultSchema = z.object({
  proposals: z.array(proposalSchema).max(6),
});

export type SweepResult = z.infer<typeof sweepResultSchema>;
export type ProposalDraft = z.infer<typeof proposalSchema>;

export const plannerResultSchema = z.object({
  calls: z
    .array(
      z.object({
        connector_id: z.string(),
        tool: z.string(),
        args: z.record(z.string(), z.unknown()).default({}),
        why: z.string().default(""),
      }),
    )
    .max(12),
});

export type PlannerResult = z.infer<typeof plannerResultSchema>;

export const denialLessonSchema = z.object({
  lesson: z.string().min(1),
});

export const reviseResultSchema = z.object({
  message: z.string().min(1),
  recommended_action: z.string().min(1).max(200),
  draft: z.string().nullable().default(null),
  action_plan: z.array(plannedToolCallSchema).default([]),
});
