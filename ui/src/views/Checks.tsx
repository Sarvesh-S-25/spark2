import React from 'react';
import type { ViewProps } from '../App';
import { api } from '../api';
import { Panel, Banner, Empty } from '../bits';

const LEVEL_NOTE: Record<number, string> = {
  1: 'Graph — orphan and dead contracts, cycles, lane leaks. Pure SQL, milliseconds.',
  2: 'Drift — has anyone edited generated code, or a locked contract, or fallen behind a version.',
  3: 'Code — does the repo actually contain what the contracts promised.',
};

/**
 * The dependency check.
 *
 * Every finding carries a stable code and a fix hint, because a checker that
 * says "something is wrong" is a checker people turn off.
 */
export function ChecksView({ projectId, overview, reload, say }: ViewProps) {
  const [levels, setLevels] = React.useState<number[]>([1, 2, 3]);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<any>(overview.lastCheck ?? null);

  async function run() {
    setBusy(true);
    try {
      const r = await api.check(projectId, levels);
      setResult(r);
      await reload();
      say(r.counts.block > 0 ? 'stop' : 'ok',
        `${r.counts.block} blocking · ${r.counts.warn} warnings · ${r.counts.info} info`);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  const findings: any[] = result?.findings ?? [];
  const bySeverity = (s: string) => findings.filter((f) => (f.severity ?? '') === s);
  const moduleName = (id: string | null) => overview.modules.find((m) => m.id === id)?.slug;
  const contractKey = (id: string | null) => overview.contracts.find((c) => c.id === id)?.key;

  return (
    <div className="page">
      <div className="page-head">
        <h2>Dependency check</h2>
        <p>
          Three levels, cheapest first. Level 3 is currently a text scan rather than a parse —
          it reports at warning strength where a real parser would block, and says so.
        </p>
      </div>

      <div className="stack">
        <Panel title="Run" hint={overview.project.root_path ? `Scanning ${overview.project.root_path}` : 'This project has no source directory set.'}>
          <div className="stack">
            {[1, 2, 3].map((lv) => (
              <label key={lv} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                <input type="checkbox" checked={levels.includes(lv)} style={{ width: 'auto' }}
                  onChange={(e) => setLevels(e.target.checked
                    ? [...levels, lv].sort()
                    : levels.filter((x) => x !== lv))} />
                <b>Level {lv}</b>
                <span className="hint">{LEVEL_NOTE[lv]}</span>
              </label>
            ))}
            <div className="row">
              <button className="btn primary" disabled={busy || levels.length === 0} onClick={() => void run()}>
                {busy ? 'Checking…' : 'Run check'}
              </button>
            </div>
          </div>
        </Panel>

        {!result ? (
          <Empty>No check has run yet.</Empty>
        ) : findings.length === 0 ? (
          <Banner tone="ok" title="Clean">
            Nothing to report. Every contract has one owner, nothing has drifted, and the code
            matches what was promised.
          </Banner>
        ) : (
          <>
            {(['block', 'warn', 'info'] as const).map((sev) => {
              const rows = bySeverity(sev);
              if (rows.length === 0) return null;
              return (
                <Panel
                  key={sev}
                  title={sev === 'block' ? `${rows.length} blocking` : sev === 'warn' ? `${rows.length} warnings` : `${rows.length} notes`}
                  hint={sev === 'block'
                    ? 'These stop the two halves fitting together. Fix before merging.'
                    : sev === 'warn'
                      ? 'Not broken yet. Usually the cheapest moment to fix them is now.'
                      : 'Opportunities rather than problems.'}
                >
                  <div className="stack" style={{ gap: 9 }}>
                    {rows.map((f) => (
                      <div key={f.id ?? f.message} className={`banner ${sev === 'info' ? '' : sev === 'block' ? 'stop' : 'warn'}`}>
                        <b>
                          <span className="mono">{f.code}</span>
                          {moduleName(f.module_id) ? <span className="muted"> · {moduleName(f.module_id)}</span> : null}
                          {contractKey(f.contract_id) ? <span className="muted"> · {contractKey(f.contract_id)}</span> : null}
                        </b>
                        {f.message}
                        <div className="hint" style={{ marginTop: 3 }}>{f.fix_hint ?? f.fixHint}</div>
                      </div>
                    ))}
                  </div>
                </Panel>
              );
            })}
          </>
        )}

        <Panel title="What each code means">
          <div className="tw">
            <table>
              <thead><tr><th>Code</th><th>Level</th><th>Meaning</th></tr></thead>
              <tbody>
                <tr><td className="mono">ORPHAN_CONTRACT</td><td>1</td><td>Consumed, but nothing provides it.</td></tr>
                <tr><td className="mono">DEAD_CONTRACT</td><td>1</td><td>Provided, but nothing consumes it.</td></tr>
                <tr><td className="mono">CYCLE</td><td>1</td><td>Circular dependency between modules.</td></tr>
                <tr><td className="mono">LANE_LEAK</td><td>1</td><td>Frontend reaching into a server-internal boundary.</td></tr>
                <tr><td className="mono">UNOWNED_MODULE</td><td>1</td><td>Startable and unclaimed — free parallelism.</td></tr>
                <tr><td className="mono">CONTRACT_TAMPERED</td><td>2</td><td>A locked contract changed without a request.</td></tr>
                <tr><td className="mono">GENERATED_EDITED</td><td>2</td><td>Somebody hand-edited generated code.</td></tr>
                <tr><td className="mono">CONTRACT_DRIFT</td><td>2</td><td>Generated code is behind the contract. Regenerate.</td></tr>
                <tr><td className="mono">VERSION_SKEW</td><td>2</td><td>Two majors live at once past the migration window.</td></tr>
                <tr><td className="mono">MISSING_IMPL</td><td>3</td><td>No code mentions the contract's path.</td></tr>
                <tr><td className="mono">UNDECLARED_CALL</td><td>3</td><td>Code calls an endpoint no contract covers.</td></tr>
                <tr><td className="mono">STUB_REMAINING</td><td>3</td><td>Still throws NotImplemented but marked completed.</td></tr>
                <tr><td className="mono">MISSING_FILE</td><td>3</td><td>Marked completed but a declared file is absent.</td></tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
