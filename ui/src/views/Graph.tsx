import React from 'react';
import type { ViewProps } from '../App';
import { Panel, LaneChip, StatusChip, ContractStateChip, Empty } from '../bits';

/**
 * The module graph, laid out by lane.
 *
 * Deliberately three fixed columns rather than a force-directed cloud: the
 * whole product is about which side of the frontend/backend line something
 * sits on, so the layout should say that before you read a single label.
 * Click a module to highlight everything it is wired to.
 */
export function GraphView({ overview, go }: ViewProps) {
  const [focus, setFocus] = React.useState<string | null>(null);
  const { modules, contracts } = overview;

  const providerOf = new Map<string, string>();
  for (const m of modules) for (const k of m.provides) providerOf.set(k, m.slug);

  const related = React.useMemo(() => {
    if (!focus) return null;
    const me = modules.find((m) => m.slug === focus);
    if (!me) return null;
    const set = new Set<string>([me.slug]);
    for (const k of me.consumes) {
      const p = providerOf.get(k);
      if (p) set.add(p);
    }
    for (const other of modules) {
      if (other.consumes.some((k) => me.provides.includes(k))) set.add(other.slug);
    }
    return set;
  }, [focus, modules]);

  const columns: { lane: 'frontend' | 'shared' | 'backend'; label: string }[] = [
    { lane: 'frontend', label: 'Frontend' },
    { lane: 'shared', label: 'Shared & contracts' },
    { lane: 'backend', label: 'Backend' },
  ];

  if (modules.length === 0) {
    return (
      <div className="page">
        <div className="page-head"><h2>Graph</h2></div>
        <Empty>Nothing to draw yet. Write a brief and split it first.</Empty>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Graph</h2>
        <p>
          Modules by lane, wired by contract. Click one to see only what it touches — the two
          things that matter are what it is waiting for, and who is waiting for it.
        </p>
      </div>

      <div className="stack">
        <div className="row between">
          <div className="row" style={{ gap: 6 }}>
            <LaneChip lane="frontend" />
            <LaneChip lane="shared" />
            <LaneChip lane="backend" />
            <LaneChip lane="infra" />
          </div>
          {focus ? (
            <button className="btn small" onClick={() => setFocus(null)}>Clear focus on {focus}</button>
          ) : <span className="hint">Click any module to focus it.</span>}
        </div>

        <div className="graph">
          {columns.map((col) => {
            const rows = modules.filter((m) =>
              col.lane === 'shared' ? (m.lane === 'shared' || m.lane === 'infra') : m.lane === col.lane);
            return (
              <div className="graph-col" key={col.lane}>
                <h4>{col.label} · {rows.length}</h4>
                {rows.length === 0 ? (
                  <div className="hint" style={{ padding: '8px 0' }}>
                    {col.lane === 'backend'
                      ? 'No backend modules — if that is wrong, the brief did not describe any stored data.'
                      : col.lane === 'frontend'
                        ? 'No frontend modules — if that is wrong, the brief did not describe anything a person sees.'
                        : 'No shared modules.'}
                  </div>
                ) : rows.map((m) => (
                  <div
                    key={m.id}
                    className={`node lane-${m.lane}${related && !related.has(m.slug) ? ' dim' : ''}`}
                    onClick={() => setFocus(focus === m.slug ? null : m.slug)}
                  >
                    <div className="row between" style={{ gap: 6 }}>
                      <span className="name">{m.name}</span>
                      <StatusChip status={m.status} asserted={m.asserted} />
                    </div>
                    <div className="slug">{m.slug}</div>
                    <div className="wires">
                      {m.provides.map((k) => (
                        <span key={`p${k}`} className="chip sh" title={`provides ${k}`}>↑ {k}</span>
                      ))}
                      {m.consumes.map((k) => {
                        const c = contracts.find((x) => x.key === k);
                        const tone = c?.state === 'locked' ? 'ok' : c?.state === 'proposed' ? 'warn' : 'mute';
                        return (
                          <span key={`c${k}`} className={`chip ${tone}`} title={`consumes ${k} (${c?.state ?? 'unknown'})`}>
                            ↓ {k}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            );
          })}
        </div>

        <Panel title="Contracts" hint="Solid green means locked — the signal that both sides can start.">
          <div className="tw">
            <table>
              <thead>
                <tr><th>Contract</th><th>Kind</th><th>State</th><th>Provider</th><th>Consumers</th></tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => go('contracts', c.key)}>
                    <td className="mono">{c.key}</td>
                    <td><span className="chip mute">{c.kind}</span></td>
                    <td><ContractStateChip state={c.state} /></td>
                    <td className="mono">{c.provider ?? <span className="chip stop">none</span>}</td>
                    <td className="mono muted">
                      {c.consumers.length === 0 ? '—' : c.consumers.map((x) => x.slug).join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
