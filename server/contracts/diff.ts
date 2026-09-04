import type { ContractSpec } from './spec.js';

/**
 * Change classification.
 *
 * The point of this file: the *class* of a contract change is computed from the
 * schema diff, never declared by the person making it. "I thought it was a
 * small change" stops being an argument you can have.
 *
 *   additive  — nothing anyone wrote can break.        auto-approved
 *   widening  — safe for the provider, worth telling   auto-approved, flagged
 *               consumers about.
 *   breaking  — someone's code stops working.          change request required
 */

export type ChangeClass = 'additive' | 'widening' | 'breaking';

export interface DiffResult {
  changeClass: ChangeClass;
  reasons: { class: ChangeClass; message: string }[];
  nextSemver: string;
}

type Props = Record<string, any>;

function unwrap(schema: any): { props: Props; required: Set<string>; isArray: boolean } {
  let node = schema ?? {};
  let isArray = false;
  if (node.type === 'array') {
    isArray = true;
    node = node.items ?? {};
  }
  return {
    props: (node.properties ?? {}) as Props,
    required: new Set<string>(node.required ?? []),
    isArray,
  };
}

const typeOf = (p: any): string =>
  !p ? 'unknown' : p.type === 'array' ? `array<${p.items?.type ?? 'unknown'}>` : String(p.type ?? 'unknown');

export function diffContracts(
  before: ContractSpec,
  after: ContractSpec,
  currentSemver = '1.0.0',
): DiffResult {
  const reasons: DiffResult['reasons'] = [];
  const add = (cls: ChangeClass, message: string) => reasons.push({ class: cls, message });

  if (before.kind !== after.kind) {
    add('breaking', `kind changed from ${before.kind} to ${after.kind}`);
  }

  // ── transport ──────────────────────────────────────────────────────────────
  for (const k of ['method', 'path', 'symbol'] as const) {
    const b = before.transport[k] ?? '';
    const a = after.transport[k] ?? '';
    if (b !== a && (b || a)) add('breaking', `transport ${k} changed: "${b}" → "${a}"`);
  }

  // ── input: what consumers send ─────────────────────────────────────────────
  const bi = unwrap(before.input);
  const ai = unwrap(after.input);

  for (const name of Object.keys(ai.props)) {
    if (!(name in bi.props)) {
      if (ai.required.has(name)) add('breaking', `new required input field "${name}" — existing callers do not send it`);
      else add('additive', `new optional input field "${name}"`);
      continue;
    }
    if (typeOf(bi.props[name]) !== typeOf(ai.props[name])) {
      add('breaking', `input field "${name}" changed type: ${typeOf(bi.props[name])} → ${typeOf(ai.props[name])}`);
    }
    const was = bi.required.has(name);
    const is = ai.required.has(name);
    if (!was && is) add('breaking', `input field "${name}" became required`);
    if (was && !is) add('widening', `input field "${name}" became optional`);
  }
  for (const name of Object.keys(bi.props)) {
    if (!(name in ai.props)) add('breaking', `input field "${name}" was removed`);
  }

  // ── output: what consumers read ────────────────────────────────────────────
  const bo = unwrap(before.output);
  const ao = unwrap(after.output);

  if (bo.isArray !== ao.isArray) {
    add('breaking', `output changed between a single object and a list`);
  }
  for (const name of Object.keys(ao.props)) {
    if (!(name in bo.props)) {
      add('additive', `new output field "${name}"`);
      continue;
    }
    if (typeOf(bo.props[name]) !== typeOf(ao.props[name])) {
      add('breaking', `output field "${name}" changed type: ${typeOf(bo.props[name])} → ${typeOf(ao.props[name])}`);
    }
    const was = bo.required.has(name);
    const is = ao.required.has(name);
    if (was && !is) add('breaking', `output field "${name}" is no longer always present`);
    if (!was && is) add('widening', `output field "${name}" is now always present`);
  }
  for (const name of Object.keys(bo.props)) {
    if (!(name in ao.props)) add('breaking', `output field "${name}" was removed`);
  }

  // ── errors ─────────────────────────────────────────────────────────────────
  const bErr = new Set(before.errors.map((e) => e.code));
  const aErr = new Set(after.errors.map((e) => e.code));
  for (const c of aErr) if (!bErr.has(c)) add('additive', `new error code ${c}`);
  for (const c of bErr) if (!aErr.has(c)) add('breaking', `error code ${c} was removed`);

  const changeClass: ChangeClass = reasons.some((r) => r.class === 'breaking')
    ? 'breaking'
    : reasons.some((r) => r.class === 'widening')
      ? 'widening'
      : 'additive';

  return {
    changeClass,
    reasons,
    nextSemver: bump(currentSemver, changeClass, reasons.length > 0),
  };
}

export function parseSemver(v: string): [number, number, number] {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v.trim());
  if (!m) return [1, 0, 0];
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function bump(current: string, cls: ChangeClass, anyChange = true): string {
  const [maj, min, pat] = parseSemver(current);
  if (cls === 'breaking') return `${maj + 1}.0.0`;
  if (cls === 'widening') return `${maj}.${min + 1}.0`;
  return anyChange ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}
