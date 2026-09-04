import React from 'react';
import type { ViewProps } from '../App';
import { api } from '../api';
import { Panel, Banner, Field, Stat, money, Empty } from '../bits';

/**
 * Settings: which model runs which pass, what it has cost, and where this
 * project's source lives.
 *
 * Providers are configured in `.env` rather than here on purpose — keys should
 * live in one file you can gitignore, not in a database the app syncs.
 */
export function SettingsView({ projectId = '', overview, reload, say }: Partial<ViewProps> & {
  say: (t: 'ok' | 'stop' | 'info', m: string) => void;
}) {
  const [models, setModels] = React.useState<any>(null);
  const [usage, setUsage] = React.useState<any>(null);
  const [root, setRoot] = React.useState(overview?.project.root_path ?? '');
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    try {
      setModels(await api.models());
      setUsage(await api.usage(projectId || undefined));
    } catch (e) {
      say('stop', (e as Error).message);
    }
  }, [projectId, say]);

  React.useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="page">
      <div className="page-head">
        <h2>Settings</h2>
        <p>
          SparkX works with no key and no network on its built-in heuristic planner. A cloud key
          makes the splitter better; it is never the price of entry.
        </p>
      </div>

      <div className="stack">
        {models ? (
          <>
            <Panel
              title="Model routing"
              hint="Pass B — finding the seams — is the hard one. If you have one good key, spend it there."
              right={<button className="btn small" onClick={() => void refresh()}>Re-probe</button>}
            >
              <div className="stack">
                <div className="row" style={{ gap: 14 }}>
                  {(['A', 'B', 'C'] as const).map((p) => (
                    <div key={p}>
                      <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.12em' }}>PASS {p}</div>
                      <b className="mono">{models.routing[p]}</b>
                    </div>
                  ))}
                  <div>
                    <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.12em' }}>TEMPERATURE</div>
                    <b className="mono">{models.temperature}</b>
                  </div>
                  <div>
                    <div className="mono muted" style={{ fontSize: 10, letterSpacing: '.12em' }}>PROMPT CACHE</div>
                    <b className="mono">{models.cacheEnabled ? 'on' : 'off'}</b>
                  </div>
                </div>

                <div className="tw">
                  <table>
                    <thead>
                      <tr><th>Provider</th><th>Model</th><th>Status</th><th>Used for</th></tr>
                    </thead>
                    <tbody>
                      {models.providers.map((p: any) => (
                        <tr key={p.id}>
                          <td>
                            <b className="mono">{p.id}</b>
                            {p.id === models.defaultProvider ? <span className="chip ok" style={{ marginLeft: 6 }}>default</span> : null}
                          </td>
                          <td className="mono muted">{p.model}</td>
                          <td>
                            <span className={`chip ${p.ok ? 'ok' : 'mute'}`}>{p.ok ? 'ready' : 'unavailable'}</span>
                            <div className="hint">{p.detail}</div>
                          </td>
                          <td className="mono">{p.usedForPasses.length ? p.usedForPasses.join(', ') : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <Banner title="Changing any of this">
                  Edit <code className="inline">.env</code> in the project root and restart the server.
                  The keys are <code className="inline">SPARK_PROVIDER</code>,{' '}
                  <code className="inline">OPENAI_API_KEY</code>, <code className="inline">GOOGLE_API_KEY</code>,{' '}
                  <code className="inline">OLLAMA_HOST</code>, and the per-pass overrides{' '}
                  <code className="inline">SPARK_PROVIDER_PASS_A|B|C</code>. Copy{' '}
                  <code className="inline">.env.example</code> if you have not already.
                </Banner>
              </div>
            </Panel>

            {usage?.totals ? (
              <Panel title="What the models have cost" hint="Every call is logged. Local inference is free and shows as $0.00.">
                <div className="stack">
                  <dl className="stat-row">
                    <Stat label="Calls" value={usage.totals.runs ?? 0} />
                    <Stat label="Cached" value={usage.totals.cached ?? 0} />
                    <Stat label="Repairs" value={usage.totals.repairs ?? 0} />
                    <Stat label="Tokens in" value={usage.totals.tokens_in ?? 0} />
                    <Stat label="Tokens out" value={usage.totals.tokens_out ?? 0} />
                    <Stat label="Cost" value={money(usage.totals.cost_usd ?? 0)} />
                  </dl>
                  {usage.recent?.length ? (
                    <details className="disclosure">
                      <summary>Recent calls</summary>
                      <div className="tw" style={{ marginTop: 8 }}>
                        <table>
                          <thead>
                            <tr><th>When</th><th>Purpose</th><th>Provider</th><th className="num">ms</th><th className="num">Cost</th><th>Result</th></tr>
                          </thead>
                          <tbody>
                            {usage.recent.map((r: any, i: number) => (
                              <tr key={i}>
                                <td className="mono muted">{new Date(r.created_at).toLocaleTimeString()}</td>
                                <td className="mono">{r.purpose}</td>
                                <td className="mono muted">{r.provider}/{r.model}</td>
                                <td className="num">{r.latency_ms}</td>
                                <td className="num">{money(r.cost_usd ?? 0)}</td>
                                <td>
                                  <span className={`chip ${r.ok ? 'ok' : 'stop'}`}>{r.ok ? 'ok' : 'failed'}</span>
                                  {r.cached ? <span className="chip mute" style={{ marginLeft: 4 }}>cached</span> : null}
                                  {r.repair_count > 0 ? <span className="chip warn" style={{ marginLeft: 4 }}>{r.repair_count} repair</span> : null}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </details>
                  ) : null}
                </div>
              </Panel>
            ) : null}
          </>
        ) : <Empty>Probing providers…</Empty>}

        {projectId && overview ? (
          <Panel title="This project">
            <div className="stack">
              <Field label="Source directory">
                <input type="text" value={root} onChange={(e) => setRoot(e.target.value)} />
              </Field>
              <div className="row">
                <button className="btn primary" disabled={busy} onClick={async () => {
                  setBusy(true);
                  try {
                    await api.updateProject(projectId, { rootPath: root });
                    await reload?.();
                    say('ok', 'Saved. The dependency check will scan there from now on.');
                  } catch (e) { say('stop', (e as Error).message); }
                  finally { setBusy(false); }
                }}>Save</button>
                <span className="hint">
                  Generated contracts are written here, and level 2 and 3 checks read from it.
                  Point it at your repo when you have one.
                </span>
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
