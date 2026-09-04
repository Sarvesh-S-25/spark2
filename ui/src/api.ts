/**
 * The API client.
 *
 * Thin on purpose. Everything the UI knows about the server is in this file, so
 * the future CLI and VS Code extension can be written against the same list of
 * endpoints without reading any React.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    throw new ApiError(body?.code ?? 'ERROR', res.status, body?.message ?? res.statusText);
  }
  return body as T;
}

const get = <T>(p: string) => call<T>(p);
const post = <T>(p: string, body?: unknown) =>
  call<T>(p, { method: 'POST', body: JSON.stringify(body ?? {}) });
const patch = <T>(p: string, body: unknown) =>
  call<T>(p, { method: 'PATCH', body: JSON.stringify(body) });
const put = <T>(p: string, body: unknown) =>
  call<T>(p, { method: 'PUT', body: JSON.stringify(body) });
const del = <T>(p: string) => call<T>(p, { method: 'DELETE' });

// ── shapes the UI cares about ────────────────────────────────────────────────

export type Lane = 'frontend' | 'backend' | 'shared' | 'infra';
export type ContractState = 'draft' | 'proposed' | 'locked' | 'deprecated' | 'removed';
export type ModuleStatus =
  | 'planned' | 'ready' | 'building' | 'blocked' | 'contract_met' | 'completed' | 'orphaned';

export interface Project {
  id: string; name: string; root_path: string | null; repo_url: string | null;
  created_at: string; module_count?: number; contract_count?: number;
}

export interface DerivedModule {
  id: string; slug: string; name: string; lane: Lane; kind: string; summary: string;
  est_size: string; files: string[]; acceptance: string[]; responsibilities: string[];
  non_goals: string[]; provides: string[]; consumes: string[]; waitingOn: string[];
  status: ModuleStatus; asserted: boolean; reason: string; assignee: string | null;
  filesPresent: number; filesTotal: number;
}

export interface ContractRow {
  id: string; key: string; kind: string; semver: string; state: ContractState;
  spec: any; examples: any[]; spec_hash: string;
  provider: string | null; consumer_count: number;
  consumers: { slug: string; lane: Lane; id: string }[];
}

export interface Finding {
  id: string; severity: 'block' | 'warn' | 'info'; code: string;
  module_id: string | null; contract_id: string | null; message: string; fix_hint: string;
}

export interface ChangeRequest {
  id: string; key: string; contract_id: string; from_semver: string; to_semver: string;
  reason: string; change_class: string; state: string; opened_by: string; opened_at: string;
  break_glass: number; proposedSpec: any;
  acks: { module_id: string; slug: string; decision: string; reason: string | null }[];
  consumers: { id: string; slug: string }[];
}

export interface Overview {
  project: Project;
  plan: { id: string; n: number; body_md: string; capabilities: any[] } | null;
  planCount: number;
  modules: DerivedModule[];
  contracts: ContractRow[];
  unblockRanking: { key: string; blocks: number }[];
  criticalPath: string[];
  changeRequests: ChangeRequest[];
  lastCheck: { id: string; started_at: string; levels: string; findings: Finding[] } | null;
  packs: { id: string; label: string; lane: string }[];
}

export interface SplitResult {
  ok: boolean;
  capabilities: { id: string; text: string; actor: string; source_quote: string }[];
  seams: any[];
  modules: any[];
  issues: { code: string; severity: string; message: string; fixHint: string; subject?: string }[];
  fixes: string[];
  passes: { pass: string; provider: string; model: string; ok: boolean; cached: boolean; repairs: number; latencyMs: number; costUsd: number; errors: string[] }[];
  totalCostUsd: number;
  totalLatencyMs: number;
}

export const api = {
  health: () => get<{ ok: boolean; at: string }>('/health'),
  models: () => get<any>('/models'),
  usage: (projectId?: string) => get<any>(`/usage${projectId ? `?projectId=${projectId}` : ''}`),

  projects: () => get<Project[]>('/projects'),
  createProject: (name: string, rootPath?: string) => post<Project>('/projects', { name, rootPath }),
  updateProject: (id: string, body: Partial<Project> & { rootPath?: string; repoUrl?: string }) =>
    patch<Project>(`/projects/${id}`, body),
  deleteProject: (id: string) => del<{ deleted: boolean }>(`/projects/${id}`),
  overview: (id: string) => get<Overview>(`/projects/${id}/overview`),

  draftPlan: (idea: string, projectId?: string) =>
    post<{ ok: boolean; draft: any; errors: string[]; meta: any }>('/plan/draft', { idea, projectId }),
  split: (id: string, brief: string, source = 'pasted') =>
    post<SplitResult>(`/projects/${id}/split`, { brief, source }),
  plans: (id: string) => get<any[]>(`/projects/${id}/plans`),

  claim: (moduleId: string, assignee: string) => post(`/modules/${moduleId}/claim`, { assignee }),
  unclaim: (moduleId: string) => del(`/modules/${moduleId}/claim`),
  setStatus: (moduleId: string, status: string | null, actor: string) =>
    post(`/modules/${moduleId}/status`, { status, actor }),
  updateModule: (moduleId: string, body: Record<string, unknown>) => patch(`/modules/${moduleId}`, body),

  contract: (id: string) => get<any>(`/contracts/${id}`),
  saveDraft: (id: string, spec: unknown, examples: unknown) => put(`/contracts/${id}`, { spec, examples }),
  setContractState: (id: string, to: ContractState) => post(`/contracts/${id}/state`, { to }),
  bulkState: (projectId: string, from: ContractState, to: ContractState) =>
    post<{ moved: string[]; refused: { key: string; reason: string }[] }>(
      `/projects/${projectId}/contracts/bulk-state`, { from, to }),
  changeRequest: (contractId: string, spec: unknown, examples: unknown, reason: string, actor: string) =>
    post<any>(`/contracts/${contractId}/change-request`, { spec, examples, reason, actor }),
  ack: (crId: string, moduleId: string, decision: 'ack' | 'object', reason?: string) =>
    post(`/change-requests/${crId}/ack`, { moduleId, decision, reason }),
  applyCr: (crId: string, breakGlass: boolean, actor: string) =>
    post<any>(`/change-requests/${crId}/apply`, { breakGlass, actor }),
  withdrawCr: (crId: string) => post(`/change-requests/${crId}/withdraw`),

  generate: (id: string, packs: string[], includeDrafts: boolean, dryRun = false) =>
    post<any>(`/projects/${id}/generate`, { packs, includeDrafts, dryRun }),
  openapi: (id: string) => get<any>(`/projects/${id}/openapi`),

  check: (id: string, levels: number[]) => post<any>(`/projects/${id}/check`, { levels }),
  checks: (id: string) => get<any[]>(`/projects/${id}/checks`),
};
