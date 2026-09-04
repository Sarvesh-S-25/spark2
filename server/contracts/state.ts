import type { ContractState, ContractExample } from './spec.js';

/**
 * The contract state machine, and the one rule the whole product turns on:
 * `locked` is the unblock signal. A module is startable when everything it
 * consumes is locked — not when the module providing it is finished.
 */

export const STATE_ORDER: ContractState[] = ['draft', 'proposed', 'locked', 'deprecated', 'removed'];

const ALLOWED: Record<ContractState, ContractState[]> = {
  draft: ['proposed', 'removed'],
  proposed: ['draft', 'locked', 'removed'],
  // A locked contract does not move by hand. A change request produces a NEW
  // version; this version only ever ages out.
  locked: ['deprecated'],
  deprecated: ['removed'],
  removed: [],
};

export interface TransitionCheck {
  ok: boolean;
  reason?: string;
}

export function canTransition(
  from: ContractState,
  to: ContractState,
  ctx: { examples: ContractExample[]; hasProvider: boolean; consumerCount: number },
): TransitionCheck {
  if (from === to) return { ok: false, reason: `already ${from}` };
  if (!ALLOWED[from].includes(to)) {
    return {
      ok: false,
      reason: from === 'locked'
        ? 'a locked contract cannot be edited directly — open a change request instead'
        : `${from} → ${to} is not a legal transition`,
    };
  }
  if (to === 'locked') {
    if (ctx.examples.length === 0) {
      return {
        ok: false,
        reason: 'a contract needs at least one example before it can lock — the example is the frontend mock, the backend test fixture and the human readability check',
      };
    }
    if (!ctx.hasProvider) {
      return { ok: false, reason: 'no module provides this contract yet' };
    }
  }
  return { ok: true };
}

/** Contracts in these states generate code. */
export function generates(state: ContractState): boolean {
  return state === 'proposed' || state === 'locked' || state === 'deprecated';
}

/** Contracts in this state unblock their consumers. */
export function unblocks(state: ContractState): boolean {
  return state === 'locked' || state === 'deprecated';
}
