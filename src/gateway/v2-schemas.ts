/**
 * TDAI Memory Gateway — v2 API Schemas.
 *
 * Generated baseline: `generated/schemas.ts` (Kubb, do not edit).
 * This file re-exports everything from the generated baseline, then adds
 * hand-written overrides that OpenAPI cannot express:
 *   - safePath refine (path traversal prevention)
 *   - conversationDelete mutual exclusion refine
 *   - Generic ApiResponseEnvelope<T> interface
 *   - formatZodError utility
 */

import { z } from "zod";

// ============================
// Re-export all generated schemas as-is
// ============================

export {
  apiResponseEnvelopeSchema,
  conversationRoleSchema,
  paginationSchema,
  conversationItemSchema,
  conversationAddRequestSchema,
  conversationAddDataSchema,
  conversationQueryRequestSchema,
  conversationQueryDataSchema,
  conversationDeleteDataSchema,
  atomicDetailSchema,
  atomicUpdateRequestSchema,
  atomicUpdateDataSchema,
  atomicDeleteRequestSchema,
  atomicDeleteDataSchema,
  atomicQueryRequestSchema,
  atomicQueryDataSchema,
  scenarioListRequestSchema,
  scenarioEntrySchema,
  scenarioListDataSchema,
  scenarioFileSchema,
  scenarioWriteDataSchema,
  coreFileSchema,
  coreReadRequestSchema,
  coreWriteRequestSchema,
  coreWriteDataSchema,
  conversationSearchRequestSchema,
  conversationSearchHitSchema,
  conversationSearchDataSchema,
  atomicSearchRequestSchema,
  atomicSearchHitSchema,
  atomicSearchDataSchema,
} from "./generated/schemas.js";

// Re-export generated types
export type {
  ConversationRole,
  Pagination,
  ConversationItem,
  ConversationAddRequest,
  ConversationAddData,
  ConversationQueryRequest,
  ConversationQueryData,
  ConversationDeleteData,
  AtomicDetail,
  AtomicUpdateRequest,
  AtomicUpdateData,
  AtomicDeleteRequest,
  AtomicDeleteData,
  AtomicQueryRequest,
  AtomicQueryData,
  ScenarioListRequest,
  ScenarioEntry,
  ScenarioListData,
  ScenarioFile,
  ScenarioWriteData,
  CoreFile,
  CoreReadRequest,
  CoreWriteRequest,
  CoreWriteData,
  ConversationSearchRequest,
  ConversationSearchHit,
  ConversationSearchData,
  AtomicSearchRequest,
  AtomicSearchHit,
  AtomicSearchData,
} from "./generated/types.js";

// Import schemas we need to override
import {
  scenarioReadRequestSchema as _scenarioReadRequestSchema,
  scenarioWriteRequestSchema as _scenarioWriteRequestSchema,
  scenarioRmRequestSchema as _scenarioRmRequestSchema,
  conversationDeleteRequestSchema as _conversationDeleteRequestSchema,
} from "./generated/schemas.js";

// ============================
// Override: safe path (prevent path traversal)
// ============================

const safePath = z.string().min(1).refine(
  (p) => !p.includes("..") && !p.startsWith("/"),
  { message: "Path must be relative (no '..', no leading '/')" },
);

/** scenarioRead with path traversal prevention. */
export const scenarioReadRequestSchema = z.object({ path: safePath });
export type ScenarioReadRequest = z.infer<typeof scenarioReadRequestSchema>;

/** scenarioWrite with path traversal prevention + summary. */
export const scenarioWriteRequestSchema = z.object({
  path: safePath,
  content: z.string(),
  summary: z.string().optional(),
});
export type ScenarioWriteRequest = z.infer<typeof scenarioWriteRequestSchema>;

/** scenarioRm with path traversal prevention. */
export const scenarioRmRequestSchema = z.object({ path: safePath });
export type ScenarioRmRequest = z.infer<typeof scenarioRmRequestSchema>;

// ============================
// Override: conversation delete mutual exclusion
// ============================

/** conversationDelete with mutual exclusion refine. */
export const conversationDeleteRequestSchema = z.object({
  message_ids: z.array(z.string()).min(1).max(100).optional(),
  session_id: z.string().optional(),
}).refine(
  (data) => {
    const hasIds = data.message_ids !== undefined && data.message_ids.length > 0;
    const hasSession = data.session_id !== undefined && data.session_id.trim().length > 0;
    return (hasIds || hasSession) && !(hasIds && hasSession);
  },
  { message: "Exactly one of message_ids or session_id must be provided (mutually exclusive)" },
);
export type ConversationDeleteRequest = z.infer<typeof conversationDeleteRequestSchema>;

// ============================
// Generic API Response Envelope
// ============================

export interface ApiResponseEnvelope<T = unknown> {
  code: number;
  message: string;
  request_id: string;
  data?: T;
}

// ============================
// Zod error formatter
// ============================

export function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

// ============================
// Auth context
// ============================

export const v2AuthContextSchema = z.object({
  apiKey: z.string().min(1),
  serviceId: z.string().min(1),
});
export type V2AuthContext = z.infer<typeof v2AuthContextSchema>;
