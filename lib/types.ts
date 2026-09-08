export * from "./domain/schema";

import type { RaidPlanDocument } from "./domain/schema";

export interface PublicationBinding {
  shareId: string;
  editId: string;
  revisionId: string;
  publishedAt: number;
  contentHash: string;
}

export interface LocalPlanRecord {
  id: string;
  document: RaidPlanDocument;
  localRevision: number;
  createdAt: number;
  updatedAt: number;
  activePublication?: PublicationBinding;
}

export type SnapshotReason = "minute" | "publish" | "preset" | "destructive" | "manual";

export interface PlanSnapshot {
  id: string;
  planId: string;
  localRevision: number;
  reason: SnapshotReason;
  createdAt: number;
  bytes: number;
  document: RaidPlanDocument;
}

export interface PublishedPlan {
  shareId: string;
  editId: string;
  revisionId: string;
  publishedAt: number;
  contentHash: string;
  document: RaidPlanDocument;
}

export type PublicPublication = Omit<PublishedPlan, "editId">;

export type ExportTarget = "mrt-reading";

export interface ExportRequest {
  target: ExportTarget;
  document: RaidPlanDocument;
  skillLibrary?: readonly import("./domain/schema").PlayerSkillDefinition[];
}

export interface ExportDiagnostic {
  code: string;
  severity: "warning" | "error";
  message: string;
  objectId?: string;
}

export interface ExportResult {
  target: ExportTarget;
  text: string;
  diagnostics: ExportDiagnostic[];
  omittedObjectIds: string[];
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown;
}
