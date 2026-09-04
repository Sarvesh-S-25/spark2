import React from 'react';
import type { Lane, ModuleStatus, ContractState } from './api';

/** Small shared pieces. Nothing here knows about the server. */

const LANE_CLASS: Record<Lane, string> = {
  frontend: 'fe', backend: 'be', shared: 'sh', infra: 'infra',
};
const LANE_LABEL: Record<Lane, string> = {
  frontend: 'Frontend', backend: 'Backend', shared: 'Shared', infra: 'Infra',
};

export function LaneChip({ lane }: { lane: Lane }) {
  return <span className={`chip ${LANE_CLASS[lane] ?? 'mute'}`}>{LANE_LABEL[lane] ?? lane}</span>;
}

const STATUS_TONE: Record<ModuleStatus, string> = {
  planned: 'mute',
  ready: 'ok',
  building: 'warn',
  blocked: 'stop',
  contract_met: 'ok',
  completed: 'ok',
  orphaned: 'stop',
};
const STATUS_LABEL: Record<ModuleStatus, string> = {
  planned: 'Planned',
  ready: 'Ready',
  building: 'Building',
  blocked: 'Blocked',
  contract_met: 'Contract met',
  completed: 'Completed',
  orphaned: 'Orphaned',
};

/**
 * A status badge. An asserted status renders hollow — a person typed it in
 * rather than SparkX deriving it, and that difference must always be visible.
 */
export function StatusChip({ status, asserted }: { status: ModuleStatus; asserted?: boolean }) {
  return (
    <span
      className={`chip ${STATUS_TONE[status] ?? 'mute'}${asserted ? ' hollow' : ''}`}
      title={asserted ? 'Asserted by a person, not derived from evidence' : undefined}
    >
      {STATUS_LABEL[status] ?? status}{asserted ? ' ·' : ''}
    </span>
  );
}

const CONTRACT_TONE: Record<ContractState, string> = {
  draft: 'mute', proposed: 'warn', locked: 'ok', deprecated: 'warn', removed: 'stop',
};

export function ContractStateChip({ state }: { state: ContractState }) {
  return <span className={`chip ${CONTRACT_TONE[state] ?? 'mute'}`}>{state}</span>;
}

export function KindChip({ kind }: { kind: string }) {
  return <span className="chip mute">{kind}</span>;
}

export function Panel({ title, hint, right, children }: {
  title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <header>
        <div>
          <h3>{title}</h3>
          {hint ? <p>{hint}</p> : null}
        </div>
        {right ? <div className="row">{right}</div> : null}
      </header>
      <div className="body">{children}</div>
    </section>
  );
}

export function Empty({ children }: { children: React.ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Banner({ tone = 'info', title, children }: {
  tone?: 'info' | 'ok' | 'warn' | 'stop'; title?: string; children: React.ReactNode;
}) {
  return (
    <div className={`banner ${tone === 'info' ? '' : tone}`}>
      {title ? <b>{title}</b> : null}
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export function Stat({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <div className="stat">
      <dt>{label}</dt>
      <dd>{value}{note ? <small> {note}</small> : null}</dd>
    </div>
  );
}

export function Toast({ tone, message, onDone }: {
  tone: 'ok' | 'stop' | 'info'; message: string; onDone: () => void;
}) {
  React.useEffect(() => {
    const t = setTimeout(onDone, 6000);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <div className={`toast ${tone === 'info' ? '' : tone}`} role="status" onClick={onDone}>
      {message}
    </div>
  );
}

/** Formats a JSON Schema as a compact readable field list. */
export function SchemaFields({ schema }: { schema: any }) {
  const node = schema?.type === 'array' ? schema.items ?? {} : schema ?? {};
  const props = (node.properties ?? {}) as Record<string, any>;
  const required = new Set<string>(node.required ?? []);
  const entries = Object.entries(props);

  if (entries.length === 0) return <span className="muted">—</span>;

  return (
    <div className="stack" style={{ gap: 3 }}>
      {schema?.type === 'array' ? <span className="mono muted">array of:</span> : null}
      {entries.map(([name, prop]) => (
        <div key={name} className="mono" style={{ display: 'flex', gap: 8 }}>
          <span style={{ minWidth: 130 }}>
            {name}{required.has(name) ? '' : <span className="muted">?</span>}
          </span>
          <span className="muted">{typeName(prop)}</span>
          {prop.description ? <span className="muted">— {prop.description}</span> : null}
        </div>
      ))}
    </div>
  );
}

function typeName(prop: any): string {
  if (!prop) return 'unknown';
  if (prop.type === 'array') return `${typeName(prop.items ?? {})}[]`;
  if (prop.format === 'date-time') return 'datetime';
  return String(prop.type ?? 'unknown');
}

export const money = (n: number): string => (n > 0 && n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`);
