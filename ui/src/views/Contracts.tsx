import React from 'react';
import type { ViewProps } from '../App';
import { api, type ContractRow, type ContractState } from '../api';
import { Panel, ContractStateChip, LaneChip, Banner, Empty, Field, SchemaFields } from '../bits';

/**
 * Contracts, and the governance around changing them.
 *
 * Two rules run this screen:
 *   • locked is the unblock signal, and a locked contract cannot be edited —
 *     only superseded through a change request;
 *   • the class of a change (additive / widening / breaking) is computed from
 *     the schema diff, never declared. "I thought it was a small change" stops
 *     being an argument you can have.
 */
export function ContractsView({ projectId, overview, reload, say, arg }: ViewProps) {
  const [selected, setSelected] = React.useState<string | null>(
    arg ? overview.contracts.find((c) => c.key === arg)?.id ?? null : null,
  );
  const [busy, setBusy] = React.useState(false);

  const contracts = overview.contracts;
  const openCrs = overview.changeRequests.filter((c) => c.state === 'open');
  const current = contracts.find((c) => c.id === selected) ?? null;

  const counts = (state: ContractState) => contracts.filter((c) => c.state === state).length;

  async function bulk(from: ContractState, to: ContractState) {
    setBusy(true);
    try {
      const r = await api.bulkState(projectId, from, to);
      await reload();
      const refusedNote = r.refused.length
        ? ` ${r.refused.length} refused: ${r.refused.slice(0, 2).map((x) => `${x.key} (${x.reason})`).join('; ')}`
        : '';
      say(r.moved.length ? 'ok' : 'stop', `${r.moved.length} moved from ${from} to ${to}.${refusedNote}`);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Contracts</h2>
        <p>
          A contract is the frozen description of one boundary. Once it locks, both sides can
          build — and neither side can move it without telling the other.
        </p>
      </div>

      <div className="stack">
        {openCrs.length > 0 ? (
          <Panel title={`${openCrs.length} open change request${openCrs.length === 1 ? '' : 's'}`}
            hint="Breaking changes never auto-ack. That is the difference between fair and careless.">
            <div className="stack" style={{ gap: 12 }}>
              {openCrs.map((cr) => (
                <ChangeRequestCard key={cr.id} cr={cr} reload={reload} say={say} />
              ))}
            </div>
          </Panel>
        ) : null}

        <div className="row between">
          <div className="row" style={{ gap: 6 }}>
            <span className="chip mute">draft {counts('draft')}</span>
            <span className="chip warn">proposed {counts('proposed')}</span>
            <span className="chip ok">locked {counts('locked')}</span>
            <span className="chip warn">deprecated {counts('deprecated')}</span>
          </div>
          <div className="row" style={{ gap: 6 }}>
            <button className="btn small" disabled={busy || counts('draft') === 0}
              onClick={() => void bulk('draft', 'proposed')}>
              Propose all drafts
            </button>
            <button className="btn small primary" disabled={busy || counts('proposed') === 0}
              onClick={() => void bulk('proposed', 'locked')}>
              Lock everything ready
            </button>
          </div>
        </div>

        <Panel title={`${contracts.length} contracts`}>
          {contracts.length === 0 ? (
            <Empty>No contracts yet. Split a brief first.</Empty>
          ) : (
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Contract</th><th>Kind</th><th>Version</th><th>State</th>
                    <th>Provider</th><th>Consumers</th><th className="num">Examples</th>
                  </tr>
                </thead>
                <tbody>
                  {contracts.map((c) => (
                    <tr key={c.id} className="clickable"
                      onClick={() => setSelected(selected === c.id ? null : c.id)}>
                      <td className="mono"><b>{c.key}</b></td>
                      <td><span className="chip mute">{c.kind}</span></td>
                      <td className="mono">{c.semver}</td>
                      <td><ContractStateChip state={c.state} /></td>
                      <td className="mono">{c.provider ?? <span className="chip stop">none</span>}</td>
                      <td className="mono muted">
                        {c.consumers.length === 0 ? '—' : c.consumers.map((x) => x.slug).join(', ')}
                      </td>
                      <td className="num">
                        {c.examples.length === 0
                          ? <span className="chip stop">0</span>
                          : c.examples.length}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        {current ? <ContractDetail key={current.id} row={current} reload={reload} say={say} /> : null}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────

function ContractDetail({ row, reload, say }: {
  row: ContractRow;
  reload: () => Promise<void>;
  say: (t: 'ok' | 'stop' | 'info', m: string) => void;
}) {
  const [specText, setSpecText] = React.useState(() => JSON.stringify(row.spec, null, 2));
  const [examplesText, setExamplesText] = React.useState(() => JSON.stringify(row.examples, null, 2));
  const [reason, setReason] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const [diff, setDiff] = React.useState<any>(null);

  const editable = row.state === 'draft';

  function parsed(): { spec: any; examples: any } | null {
    try {
      return { spec: JSON.parse(specText), examples: JSON.parse(examplesText) };
    } catch (e) {
      say('stop', `That is not valid JSON — ${(e as Error).message}`);
      return null;
    }
  }

  async function save() {
    const p = parsed();
    if (!p) return;
    setBusy(true);
    try {
      await api.saveDraft(row.id, p.spec, p.examples);
      await reload();
      say('ok', 'Draft saved.');
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function move(to: ContractState) {
    setBusy(true);
    try {
      await api.setContractState(row.id, to);
      await reload();
      say('ok', to === 'locked'
        ? `${row.key} is locked. Everything consuming it is now startable.`
        : `${row.key} is ${to}.`);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function propose() {
    const p = parsed();
    if (!p) return;
    if (!reason.trim()) { say('stop', 'Say why. Consumers will read this.'); return; }
    setBusy(true);
    try {
      let me = 'someone';
      try { me = localStorage.getItem('spark.me') || 'someone'; } catch { /* ignore */ }
      const r = await api.changeRequest(row.id, p.spec, p.examples, reason.trim(), me);
      setDiff(r);
      await reload();
      say(r.applied ? 'ok' : 'info', r.message);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <Panel
      title={row.key}
      hint={`${row.kind} · ${row.semver} · ${row.spec_hash?.slice(0, 20)}…`}
      right={
        <>
          {row.state === 'draft' ? (
            <>
              <button className="btn small" disabled={busy} onClick={() => void save()}>Save draft</button>
              <button className="btn small" disabled={busy} onClick={() => void move('proposed')}>Propose</button>
            </>
          ) : null}
          {row.state === 'proposed' ? (
            <>
              <button className="btn small" disabled={busy} onClick={() => void move('draft')}>Back to draft</button>
              <button className="btn small primary" disabled={busy} onClick={() => void move('locked')}>Lock</button>
            </>
          ) : null}
          {row.state === 'locked' ? (
            <button className="btn small" disabled={busy} onClick={() => void move('deprecated')}>Deprecate</button>
          ) : null}
        </>
      }
    >
      <div className="stack">
        <p style={{ margin: 0 }}>{row.spec?.summary || <span className="muted">No summary.</span>}</p>

        <div className="cards">
          <div>
            <FieldLabel>Transport</FieldLabel>
            <div className="mono">
              {row.kind === 'http' || row.kind === 'config'
                ? `${row.spec?.transport?.method ?? ''} ${row.spec?.transport?.path ?? ''}`
                : row.spec?.transport?.symbol ?? '—'}
            </div>
            <FieldLabel>Direction</FieldLabel>
            <div className="mono muted">{row.spec?.direction ?? '—'}</div>
            <FieldLabel>Wiring</FieldLabel>
            <div className="row" style={{ gap: 5 }}>
              <span className="chip ok">↑ {row.provider ?? 'no provider'}</span>
              {row.consumers.map((c) => (
                <span key={c.id} className="row" style={{ gap: 3 }}>
                  <LaneChip lane={c.lane} />
                  <span className="mono" style={{ fontSize: 11 }}>{c.slug}</span>
                </span>
              ))}
            </div>
          </div>

          <div>
            <FieldLabel>Input</FieldLabel>
            <SchemaFields schema={row.spec?.input} />
            <FieldLabel>Output</FieldLabel>
            <SchemaFields schema={row.spec?.output} />
          </div>

          <div>
            <FieldLabel>Errors</FieldLabel>
            {(row.spec?.errors ?? []).length === 0 ? (
              <div className="hint">None declared. Anything the server returns other than success is then a bug, not a contract.</div>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12.5 }}>
                {row.spec.errors.map((e: any) => (
                  <li key={e.code}>
                    <span className="mono">{e.code}</span> <span className="muted">({e.http}) {e.when}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {row.examples.length === 0 ? (
          <Banner tone="stop" title="No examples">
            A contract cannot lock without one. The example is simultaneously the frontend's mock,
            the backend's test fixture and the human readability check — three jobs, one field.
          </Banner>
        ) : null}

        <details className="disclosure">
          <summary>Spec JSON {editable ? '(editable)' : '(read-only — locked contracts change through a request)'}</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <Field label="spec">
              <textarea rows={16} value={specText} readOnly={false} onChange={(e) => setSpecText(e.target.value)} />
            </Field>
            <Field label="examples">
              <textarea rows={8} value={examplesText} onChange={(e) => setExamplesText(e.target.value)} />
            </Field>

            {!editable ? (
              <>
                <Field label="Why are you changing this? Consumers read it.">
                  <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
                    placeholder="the heading field needs units in its name" />
                </Field>
                <div className="row">
                  <button className="btn primary" disabled={busy} onClick={() => void propose()}>
                    Propose this change
                  </button>
                  <span className="hint">
                    Additive and widening changes apply immediately. Breaking ones open a request
                    every consumer has to answer.
                  </span>
                </div>
              </>
            ) : null}

            {diff ? (
              <Banner tone={diff.applied ? 'ok' : 'warn'} title={`${diff.changeClass} → ${diff.semver}`}>
                <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
                  {(diff.reasons ?? []).map((r: any, i: number) => (
                    <li key={i}><span className="chip mute">{r.class}</span> {r.message}</li>
                  ))}
                </ul>
              </Banner>
            ) : null}
          </div>
        </details>
      </div>
    </Panel>
  );
}

function ChangeRequestCard({ cr, reload, say }: {
  cr: any;
  reload: () => Promise<void>;
  say: (t: 'ok' | 'stop' | 'info', m: string) => void;
}) {
  const [busy, setBusy] = React.useState(false);
  const [objection, setObjection] = React.useState('');

  const acked = new Set(cr.acks.filter((a: any) => a.decision === 'ack').map((a: any) => a.module_id));
  const outstanding = cr.consumers.filter((c: any) => !acked.has(c.id));

  async function decide(moduleId: string, decision: 'ack' | 'object') {
    setBusy(true);
    try {
      await api.ack(cr.id, moduleId, decision, decision === 'object' ? objection : undefined);
      await reload();
      say('ok', decision === 'ack' ? 'Acked.' : 'Objection recorded.');
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  async function apply(breakGlass: boolean) {
    if (breakGlass && !confirm(
      'Break glass forces this through now.\n\nIt records who did it and why, notifies every consumer, and opens a remediation task that blocks the project from being marked complete.\n\nContinue?',
    )) return;
    setBusy(true);
    try {
      let me = 'someone';
      try { me = localStorage.getItem('spark.me') || 'someone'; } catch { /* ignore */ }
      const r = await api.applyCr(cr.id, breakGlass, me);
      await reload();
      say('ok', r.message);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="banner warn">
      <b>{cr.key} · {cr.from_semver} → {cr.to_semver} · {cr.change_class}</b>
      <div style={{ marginBottom: 6 }}>“{cr.reason}” — {cr.opened_by}</div>

      <div className="row" style={{ gap: 6, marginBottom: 8 }}>
        {cr.consumers.map((c: any) => (
          <span key={c.id} className={`chip ${acked.has(c.id) ? 'ok' : 'mute'}`}>
            {acked.has(c.id) ? '✓ ' : '· '}{c.slug}
          </span>
        ))}
        {cr.consumers.length === 0 ? <span className="hint">No consumers — nothing to wait for.</span> : null}
      </div>

      {outstanding.length > 0 ? (
        <div className="stack" style={{ gap: 6, marginBottom: 8 }}>
          <input type="text" placeholder="reason, if you are objecting — “no” alone is not a valid answer"
            value={objection} onChange={(e) => setObjection(e.target.value)} />
          <div className="row" style={{ gap: 6 }}>
            {outstanding.map((c: any) => (
              <React.Fragment key={c.id}>
                <button className="btn small" disabled={busy} onClick={() => void decide(c.id, 'ack')}>
                  Ack as {c.slug}
                </button>
                <button className="btn small danger" disabled={busy || !objection.trim()}
                  onClick={() => void decide(c.id, 'object')}>
                  Object
                </button>
              </React.Fragment>
            ))}
          </div>
        </div>
      ) : null}

      <div className="row" style={{ gap: 6 }}>
        <button className="btn small primary" disabled={busy || outstanding.length > 0}
          onClick={() => void apply(false)}>
          Apply
        </button>
        <button className="btn small danger" disabled={busy} onClick={() => void apply(true)}>
          Break glass
        </button>
        <button className="btn small" disabled={busy}
          onClick={async () => { await api.withdrawCr(cr.id); await reload(); }}>
          Withdraw
        </button>
        {outstanding.length > 0 ? (
          <span className="hint">Waiting on {outstanding.map((c: any) => c.slug).join(', ')}.</span>
        ) : null}
      </div>
    </div>
  );
}

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.12em',
      textTransform: 'uppercase', color: 'var(--muted)', margin: '10px 0 3px',
    }}>{children}</div>
  );
}
