import React from 'react';
import type { ViewProps } from '../App';
import { api, type DerivedModule, type ModuleStatus } from '../api';
import { Panel, LaneChip, StatusChip, Empty, Field } from '../bits';

const FILTERS: { id: string; label: string; test: (m: DerivedModule) => boolean }[] = [
  { id: 'all', label: 'Everything', test: () => true },
  { id: 'ready', label: 'I can start now', test: (m) => m.status === 'ready' },
  { id: 'mine', label: 'Claimed', test: (m) => Boolean(m.assignee) },
  { id: 'waiting', label: 'Waiting on a lock', test: (m) => m.waitingOn.length > 0 },
  { id: 'done', label: 'Done', test: (m) => m.status === 'contract_met' || m.status === 'completed' },
  { id: 'trouble', label: 'Blocked', test: (m) => m.status === 'blocked' || m.status === 'orphaned' },
];

/**
 * The requirements roster.
 *
 * The whole list, its lane, who has it, what it is waiting on, and an honest
 * status. Filter it to "I can start now" and it becomes a work queue.
 */
export function ModulesView({ overview, reload, say }: ViewProps) {
  const [filter, setFilter] = React.useState('all');
  const [lane, setLane] = React.useState<string>('all');
  const [open, setOpen] = React.useState<string | null>(null);
  const [who, setWho] = React.useState(() => {
    try { return localStorage.getItem('spark.me') ?? ''; } catch { return ''; }
  });

  React.useEffect(() => {
    try { localStorage.setItem('spark.me', who); } catch { /* ignore */ }
  }, [who]);

  const shown = overview.modules
    .filter((m) => FILTERS.find((f) => f.id === filter)!.test(m))
    .filter((m) => lane === 'all' || m.lane === lane);

  async function claim(m: DerivedModule) {
    if (!who.trim()) {
      say('stop', 'Put your name in the box first — claims are how the board knows who is on what.');
      return;
    }
    await api.claim(m.id, who.trim());
    await reload();
    say('ok', `${m.slug} is yours.`);
  }

  async function assert(m: DerivedModule, status: ModuleStatus | null) {
    await api.setStatus(m.id, status, who.trim() || 'someone');
    await reload();
    say('ok', status
      ? `${m.slug} marked ${status} — recorded as asserted, not derived.`
      : `${m.slug} handed back to derivation.`);
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Requirements</h2>
        <p>
          Status is derived from evidence — contract states, files on disk, findings — not typed
          in. You can still override it; the badge goes hollow and your name goes on it.
        </p>
      </div>

      <div className="stack">
        <div className="row between">
          <div className="row" style={{ gap: 6 }}>
            {FILTERS.map((f) => (
              <button
                key={f.id}
                className={`btn small${filter === f.id ? ' primary' : ''}`}
                onClick={() => setFilter(f.id)}
              >
                {f.label} <span className="mono">{overview.modules.filter(f.test).length}</span>
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 6 }}>
            <select value={lane} onChange={(e) => setLane(e.target.value)} style={{ width: 130 }}>
              <option value="all">All lanes</option>
              <option value="frontend">Frontend</option>
              <option value="backend">Backend</option>
              <option value="shared">Shared</option>
              <option value="infra">Infra</option>
            </select>
            <input
              type="text"
              value={who}
              placeholder="your name"
              onChange={(e) => setWho(e.target.value)}
              style={{ width: 130 }}
            />
          </div>
        </div>

        <Panel title={`${shown.length} module${shown.length === 1 ? '' : 's'}`}>
          {shown.length === 0 ? (
            <Empty>Nothing matches that filter.</Empty>
          ) : (
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Lane</th><th>Module</th><th>Status</th><th>Waiting on</th>
                    <th>Who</th><th className="num">Files</th><th />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((m) => (
                    <React.Fragment key={m.id}>
                      <tr className="clickable" onClick={() => setOpen(open === m.id ? null : m.id)}>
                        <td><LaneChip lane={m.lane} /></td>
                        <td>
                          <b>{m.name}</b>
                          <div className="mono muted">{m.slug}</div>
                        </td>
                        <td>
                          <StatusChip status={m.status} asserted={m.asserted} />
                          <div className="hint">{m.reason}</div>
                        </td>
                        <td className="mono">
                          {m.waitingOn.length === 0
                            ? <span className="muted">—</span>
                            : m.waitingOn.join(', ')}
                        </td>
                        <td>{m.assignee ?? <span className="muted">unclaimed</span>}</td>
                        <td className="num mono">{m.filesTotal ? `${m.filesPresent}/${m.filesTotal}` : '—'}</td>
                        <td>
                          {m.assignee ? (
                            <button
                              className="btn small"
                              onClick={async (e) => { e.stopPropagation(); await api.unclaim(m.id); await reload(); }}
                            >Release</button>
                          ) : (
                            <button
                              className="btn small"
                              onClick={(e) => { e.stopPropagation(); void claim(m); }}
                            >Claim</button>
                          )}
                        </td>
                      </tr>

                      {open === m.id ? (
                        <tr>
                          <td colSpan={7} style={{ background: 'var(--surface-2)' }}>
                            <div className="stack" style={{ gap: 12, padding: '6px 2px' }}>
                              <p style={{ margin: 0 }}>{m.summary}</p>

                              <div className="cards">
                                <DetailList title="Provides" items={m.provides} empty="nothing — this is a leaf module" />
                                <DetailList title="Consumes" items={m.consumes} empty="nothing — startable immediately" />
                                <DetailList title="Responsibilities" items={m.responsibilities} />
                                <DetailList
                                  title="Non-goals"
                                  items={m.non_goals}
                                  empty="none recorded — worth filling in, it is what stops two people building the same thing"
                                />
                                <DetailList title="Files" items={m.files} mono />
                                <DetailList title="Acceptance" items={m.acceptance} />
                              </div>

                              <div className="row">
                                <span className="hint">Override status:</span>
                                <button className="btn small" onClick={() => void assert(m, 'building')}>building</button>
                                <button className="btn small" onClick={() => void assert(m, 'completed')}>completed</button>
                                <button className="btn small" onClick={() => void assert(m, null)}>back to derived</button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      ) : null}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </div>
  );
}

function DetailList({ title, items, empty, mono }: {
  title: string; items: string[]; empty?: string; mono?: boolean;
}) {
  return (
    <div>
      <div style={{
        fontFamily: 'var(--mono)', fontSize: 9.5, letterSpacing: '.12em',
        textTransform: 'uppercase', color: 'var(--muted)', marginBottom: 4,
      }}>{title}</div>
      {items.length === 0 ? (
        <div className="hint">{empty ?? '—'}</div>
      ) : (
        <ul style={{ margin: 0, paddingLeft: 16, fontSize: mono ? 11.5 : 13, fontFamily: mono ? 'var(--mono)' : undefined }}>
          {items.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      )}
    </div>
  );
}
