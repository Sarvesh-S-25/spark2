import React from 'react';
import type { ViewProps } from '../App';
import { Panel, Stat, LaneChip, StatusChip, Empty, Banner } from '../bits';

/**
 * The screen you open in the morning.
 *
 * It answers three questions in order: what can I start right now, what is one
 * lock away from unblocking the most people, and is anything broken.
 */
export function OverviewView({ overview, go }: ViewProps) {
  const { modules, contracts, unblockRanking, criticalPath, lastCheck, changeRequests } = overview;

  const by = (s: string) => modules.filter((m) => m.status === s);
  const ready = by('ready');
  const locked = contracts.filter((c) => c.state === 'locked').length;
  const blocking = lastCheck?.findings.filter((f) => f.severity === 'block') ?? [];
  const openCrs = changeRequests.filter((c) => c.state === 'open');

  return (
    <div className="page">
      <div className="page-head">
        <h2>{overview.project.name}</h2>
        <p>
          A module is startable when everything it consumes is locked — not when the module
          providing it is finished. That is the only rule this screen is really showing you.
        </p>
      </div>

      <div className="stack">
        <dl className="stat-row">
          <Stat label="Ready to start" value={ready.length} note={`of ${modules.length}`} />
          <Stat label="Building" value={by('building').length} />
          <Stat label="Contract met" value={by('contract_met').length + by('completed').length} />
          <Stat label="Blocked" value={by('blocked').length} />
          <Stat label="Contracts locked" value={locked} note={`of ${contracts.length}`} />
          <Stat label="Blocking findings" value={blocking.length} />
        </dl>

        {openCrs.length > 0 ? (
          <Banner tone="warn" title={`${openCrs.length} open change request${openCrs.length === 1 ? '' : 's'}`}>
            {openCrs.map((c) => c.key).join(', ')} — consumers are waiting to answer.{' '}
            <button className="btn small" onClick={() => go('contracts')}>Review</button>
          </Banner>
        ) : null}

        {blocking.length > 0 ? (
          <Banner tone="stop" title={`${blocking.length} blocking finding${blocking.length === 1 ? '' : 's'}`}>
            {blocking.slice(0, 2).map((f) => f.message).join(' · ')}
            {blocking.length > 2 ? ` · and ${blocking.length - 2} more` : ''}{' '}
            <button className="btn small" onClick={() => go('checks')}>Open the check</button>
          </Banner>
        ) : null}

        <div className="cards">
          <Panel
            title="Start now"
            hint="Everything these modules consume is locked. Nobody has claimed them."
            right={<button className="btn small" onClick={() => go('modules')}>All modules</button>}
          >
            {ready.length === 0 ? (
              <Empty>
                Nothing is unblocked yet. Lock some contracts — the ranking beside this panel
                says which one buys the most.
              </Empty>
            ) : (
              <div className="stack" style={{ gap: 8 }}>
                {ready.slice(0, 8).map((m) => (
                  <div key={m.id} className="row between" style={{ gap: 8 }}>
                    <div className="grow">
                      <div className="row" style={{ gap: 6 }}>
                        <LaneChip lane={m.lane} />
                        <b>{m.name}</b>
                      </div>
                      <div className="mono muted">{m.slug} · {m.reason}</div>
                    </div>
                    <span className="chip mute">{m.est_size}</span>
                  </div>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Lock this next" hint="Which contract, once locked, moves the most modules into Ready.">
            {unblockRanking.length === 0 ? (
              <Empty>Nothing is waiting on a contract. Everything that can start, can start.</Empty>
            ) : (
              <div className="tw">
                <table>
                  <thead><tr><th>Contract</th><th className="num">Unblocks</th></tr></thead>
                  <tbody>
                    {unblockRanking.slice(0, 8).map((r) => (
                      <tr key={r.key} className="clickable" onClick={() => go('contracts', r.key)}>
                        <td className="mono">{r.key}</td>
                        <td className="num">{r.blocks}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>

          <Panel title="Critical path" hint="The longest chain of unfinished work. Shortening this shortens the project.">
            {criticalPath.length === 0 ? (
              <Empty>No chain left — nothing unfinished depends on anything else unfinished.</Empty>
            ) : (
              <div className="stack" style={{ gap: 5 }}>
                {criticalPath.map((slug, i) => {
                  const m = modules.find((x) => x.slug === slug);
                  return (
                    <div key={slug} className="row" style={{ gap: 8 }}>
                      <span className="mono muted" style={{ minWidth: 18 }}>{i + 1}</span>
                      {m ? <LaneChip lane={m.lane} /> : null}
                      <span className="mono grow">{slug}</span>
                      {m ? <StatusChip status={m.status} asserted={m.asserted} /> : null}
                    </div>
                  );
                })}
              </div>
            )}
          </Panel>

          <Panel title="Lanes" hint="Who has how much left to do.">
            <div className="tw">
              <table>
                <thead>
                  <tr><th>Lane</th><th className="num">Total</th><th className="num">Ready</th><th className="num">Done</th></tr>
                </thead>
                <tbody>
                  {(['frontend', 'backend', 'shared', 'infra'] as const).map((lane) => {
                    const rows = modules.filter((m) => m.lane === lane);
                    if (rows.length === 0) return null;
                    return (
                      <tr key={lane}>
                        <td><LaneChip lane={lane} /></td>
                        <td className="num">{rows.length}</td>
                        <td className="num">{rows.filter((m) => m.status === 'ready').length}</td>
                        <td className="num">
                          {rows.filter((m) => m.status === 'contract_met' || m.status === 'completed').length}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
