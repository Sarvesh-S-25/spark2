import React from 'react';
import type { ViewProps } from '../App';
import { api } from '../api';
import { Panel, Banner, Empty } from '../bits';

/**
 * Generation.
 *
 * The output lands in one directory — src/spark/ and server/spark/ — and human
 * code imports from it without editing inside it. Generated versus handwritten
 * being a directory boundary is the only kind of boundary people reliably
 * respect, and it means regeneration can never destroy anyone's work.
 */
export function GenerateView({ projectId, overview, reload, say }: ViewProps) {
  const [packs, setPacks] = React.useState<string[]>(overview.packs.map((p) => p.id));
  const [includeDrafts, setIncludeDrafts] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [result, setResult] = React.useState<any>(null);

  const generating = overview.contracts.filter(
    (c) => c.state === 'proposed' || c.state === 'locked' || c.state === 'deprecated');
  const drafts = overview.contracts.filter((c) => c.state === 'draft');

  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const r = await api.generate(projectId, packs, includeDrafts, dryRun);
      setResult({ ...r, dryRun });
      if (!dryRun) await reload();
      say('ok', r.message);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally { setBusy(false); }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Generate</h2>
        <p>
          Typed clients and example-backed mocks for the consumer side; route skeletons,
          validators and failing contract tests for the provider side. Same contract, both lanes,
          one command.
        </p>
      </div>

      <div className="stack">
        <Panel title="Language packs" hint="Adding a language is a new file in server/generate/packs — never a change to SparkX core.">
          <div className="stack">
            {overview.packs.map((p) => (
              <label key={p.id} className="row" style={{ gap: 8, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={packs.includes(p.id)}
                  onChange={(e) => setPacks(
                    e.target.checked ? [...packs, p.id] : packs.filter((x) => x !== p.id),
                  )}
                  style={{ width: 'auto' }}
                />
                <span className={`chip ${p.lane === 'frontend' ? 'fe' : p.lane === 'backend' ? 'be' : 'sh'}`}>
                  {p.lane}
                </span>
                <b>{p.label}</b>
                <span className="mono muted">{p.id}</span>
              </label>
            ))}

            <label className="row" style={{ gap: 8, cursor: 'pointer', marginTop: 6 }}>
              <input type="checkbox" checked={includeDrafts} style={{ width: 'auto' }}
                onChange={(e) => setIncludeDrafts(e.target.checked)} />
              <span>Include drafts ({drafts.length})</span>
              <span className="hint">
                Off by default: a draft is not agreed yet, and generating one invites somebody to
                build against a boundary nobody has signed off.
              </span>
            </label>

            <div className="row">
              <button className="btn" disabled={busy || packs.length === 0} onClick={() => void run(true)}>
                Preview
              </button>
              <button className="btn primary" disabled={busy || packs.length === 0} onClick={() => void run(false)}>
                {busy ? 'Working…' : 'Write files'}
              </button>
              <span className="hint">
                {generating.length} contract{generating.length === 1 ? '' : 's'} will generate
                {drafts.length > 0 && !includeDrafts ? `, ${drafts.length} draft${drafts.length === 1 ? '' : 's'} skipped` : ''}.
              </span>
            </div>
          </div>
        </Panel>

        {generating.length === 0 && !includeDrafts ? (
          <Banner tone="warn" title="Every contract is still a draft">
            Nothing will generate. Move contracts to proposed or locked on the Contracts screen —
            or tick “include drafts” if you just want to see what the output looks like.
          </Banner>
        ) : null}

        {result ? (
          <Panel
            title={result.dryRun ? 'Preview' : 'Written'}
            hint={`${result.root} · ${result.contracts} contracts`}
          >
            {result.written.length === 0 ? (
              <Empty>{result.message}</Empty>
            ) : (
              <div className="tw">
                <table>
                  <thead><tr><th>File</th><th className="num">Bytes</th></tr></thead>
                  <tbody>
                    {result.written.map((f: any) => (
                      <tr key={f.path}>
                        <td className="mono">{f.path}</td>
                        <td className="num">{f.bytes}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {result.skipped?.length ? (
              <p className="hint" style={{ marginTop: 10 }}>
                {result.skipped.length} file{result.skipped.length === 1 ? '' : 's'} already current and left alone.
              </p>
            ) : null}
          </Panel>
        ) : null}

        <Panel title="What lands where">
          <div className="tw">
            <table>
              <thead><tr><th>Path</th><th>What it is</th></tr></thead>
              <tbody>
                <tr><td className="mono">src/spark/types.ts</td><td>Every shared shape, one definition per lane.</td></tr>
                <tr><td className="mono">src/spark/client/*.ts</td><td>Typed call for each contract. Falls back to the example while mocked.</td></tr>
                <tr><td className="mono">src/spark/mocks/*.ts</td><td>The contract's own example, as data.</td></tr>
                <tr><td className="mono">server/spark/routes/*.ts</td><td>Route, validator, and a handler that throws NotImplemented.</td></tr>
                <tr><td className="mono">server/spark/tests/*.test.ts</td><td>A failing test built from the same example. Making it pass is the job.</td></tr>
                <tr><td className="mono">openapi.json</td><td>The http subset, for Swagger, Postman and anything else that speaks OpenAPI.</td></tr>
                <tr><td className="mono">.spark/</td><td>One file per module and contract version — the repo is how teammates sync.</td></tr>
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    </div>
  );
}
