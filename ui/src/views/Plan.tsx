import React from 'react';
import type { ViewProps } from '../App';
import { api, type SplitResult } from '../api';
import { Panel, Field, Banner, Empty, money } from '../bits';

const EXAMPLE = `Build a web app that shows vehicles moving on a live map.

Users can see vehicle markers update in real time as the vehicles move, tap a
marker to see that vehicle's details, and pan and zoom the map by touch.
Vehicles report their own position to the system on a regular interval.`;

/**
 * The two front doors.
 *
 * Plan Studio for people who arrive with an idea; a plain textarea for people
 * who already have a spec. Both produce the same thing — a plan revision — and
 * everything downstream traces back to it.
 */
export function PlanView({ projectId, overview, reload, say }: ViewProps) {
  const [brief, setBrief] = React.useState(overview.plan?.body_md ?? '');
  const [idea, setIdea] = React.useState('');
  const [studioOpen, setStudioOpen] = React.useState(!overview.plan);
  const [drafting, setDrafting] = React.useState(false);
  const [splitting, setSplitting] = React.useState(false);
  const [result, setResult] = React.useState<SplitResult | null>(null);
  const [assumptions, setAssumptions] = React.useState<string[]>([]);
  const [questions, setQuestions] = React.useState<string[]>([]);

  async function draft() {
    if (!idea.trim()) return;
    setDrafting(true);
    try {
      const r = await api.draftPlan(idea, projectId);
      if (!r.ok || !r.draft) {
        say('stop', r.errors[0] ?? 'The planner could not produce a draft.');
        return;
      }
      setBrief(r.draft.brief_md);
      setAssumptions(r.draft.assumptions ?? []);
      setQuestions(r.draft.open_questions ?? []);
      setStudioOpen(false);
      say('ok', 'Draft written below. Edit it before splitting — it is yours now.');
    } catch (e) {
      say('stop', (e as Error).message);
    } finally {
      setDrafting(false);
    }
  }

  async function split() {
    setSplitting(true);
    setResult(null);
    try {
      const r = await api.split(projectId, brief);
      setResult(r);
      await reload();
      say(r.ok ? 'ok' : 'stop',
        r.ok
          ? `Split into ${r.modules.length} modules across ${r.seams.length} contracts.`
          : `Split finished with ${r.issues.filter((i) => i.severity === 'block').length} blocking issues — read them below.`);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally {
      setSplitting(false);
    }
  }

  const blocking = result?.issues.filter((i) => i.severity === 'block') ?? [];
  const warnings = result?.issues.filter((i) => i.severity === 'warn') ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h2>Brief &amp; split</h2>
        <p>
          The splitter runs three passes: capabilities, then seams, then modules. Seams before
          modules is the important part — modules are derived from boundaries rather than
          boundaries being guessed after the fact.
        </p>
      </div>

      <div className="stack">
        {studioOpen ? (
          <Panel
            title="Plan Studio"
            hint="Have an idea rather than a spec? Describe it in a sentence and get an editable plan."
            right={<button className="btn small" onClick={() => setStudioOpen(false)}>I already have a plan</button>}
          >
            <div className="stack">
              <Field label="The idea, in your own words">
                <textarea
                  rows={3}
                  value={idea}
                  placeholder="a live tracker that shows buses moving on a map"
                  onChange={(e) => setIdea(e.target.value)}
                />
              </Field>
              <div className="row">
                <button className="btn primary" disabled={drafting || !idea.trim()} onClick={() => void draft()}>
                  {drafting ? 'Drafting…' : 'Draft a plan'}
                </button>
                <span className="hint">You can edit every word of the result.</span>
              </div>
            </div>
          </Panel>
        ) : null}

        <Panel
          title="Project brief"
          hint={overview.plan ? `Revision ${overview.plan.n} of ${overview.planCount}` : 'No revision saved yet.'}
          right={
            <>
              {!studioOpen ? (
                <button className="btn small" onClick={() => setStudioOpen(true)}>Plan Studio</button>
              ) : null}
              <button className="btn small" onClick={() => setBrief(EXAMPLE)}>Use the map example</button>
            </>
          }
        >
          <div className="stack">
            <textarea
              rows={14}
              value={brief}
              placeholder="What is it, who uses it, and what can they do?"
              onChange={(e) => setBrief(e.target.value)}
            />
            <div className="row between">
              <span className="hint">
                {brief.trim().length} characters. Re-splitting never rewrites a locked contract, and
                never deletes a module somebody has claimed.
              </span>
              <button className="btn primary" disabled={splitting || brief.trim().length < 20} onClick={() => void split()}>
                {splitting ? 'Splitting…' : overview.plan ? 'Re-split' : 'Split it'}
              </button>
            </div>
          </div>
        </Panel>

        {assumptions.length > 0 || questions.length > 0 ? (
          <div className="cards">
            {assumptions.length > 0 ? (
              <Panel title="Assumptions" hint="Things the planner filled in that you did not say.">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {assumptions.map((a, i) => <li key={i}>{a}</li>)}
                </ul>
              </Panel>
            ) : null}
            {questions.length > 0 ? (
              <Panel title="Open questions" hint="Decisions that would change the split.">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {questions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </Panel>
            ) : null}
          </div>
        ) : null}

        {result ? (
          <>
            <Panel
              title="What the passes did"
              hint={`${result.totalLatencyMs}ms · ${money(result.totalCostUsd)}`}
            >
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th>Pass</th><th>Provider</th><th>Model</th>
                      <th className="num">Repairs</th><th className="num">Time</th><th className="num">Cost</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.passes.map((p) => (
                      <tr key={p.pass}>
                        <td>{p.pass}</td>
                        <td className="mono">{p.provider}{p.cached ? ' (cached)' : ''}</td>
                        <td className="mono muted">{p.model}</td>
                        <td className="num">{p.repairs}</td>
                        <td className="num">{p.latencyMs}ms</td>
                        <td className="num">{money(p.costUsd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel
              title="Capabilities"
              hint="Pass A. If something here is wrong, everything downstream is confidently wrong — fix the brief and re-split."
            >
              {result.capabilities.length === 0 ? <Empty>None found.</Empty> : (
                <div className="stack" style={{ gap: 7 }}>
                  {result.capabilities.map((c) => (
                    <div key={c.id}>
                      <div className="row" style={{ gap: 7 }}>
                        <span className="chip mute">{c.actor}</span>
                        <b>{c.text}</b>
                      </div>
                      {c.source_quote
                        ? <div className="hint" style={{ paddingLeft: 4 }}>from: “{c.source_quote}”</div>
                        : <div className="hint" style={{ paddingLeft: 4 }}>inferred — not stated in the brief</div>}
                    </div>
                  ))}
                </div>
              )}
            </Panel>

            {result.fixes.length > 0 ? (
              <Panel title="Repairs applied" hint="Mechanical fixes with exactly one correct answer. Nothing happened silently.">
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {result.fixes.map((f, i) => <li key={i} className="mono" style={{ fontSize: 11.5 }}>{f}</li>)}
                </ul>
              </Panel>
            ) : null}

            {blocking.length > 0 ? (
              <Panel title={`${blocking.length} blocking issue${blocking.length === 1 ? '' : 's'}`}>
                <div className="stack" style={{ gap: 8 }}>
                  {blocking.map((i, n) => (
                    <Banner key={n} tone="stop" title={`${i.code}${i.subject ? ` · ${i.subject}` : ''}`}>
                      {i.message}
                      <div className="hint" style={{ marginTop: 3 }}>{i.fixHint}</div>
                    </Banner>
                  ))}
                </div>
              </Panel>
            ) : null}

            {warnings.length > 0 ? (
              <Panel title={`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`}>
                <div className="stack" style={{ gap: 8 }}>
                  {warnings.map((i, n) => (
                    <Banner key={n} tone="warn" title={`${i.code}${i.subject ? ` · ${i.subject}` : ''}`}>
                      {i.message}
                      <div className="hint" style={{ marginTop: 3 }}>{i.fixHint}</div>
                    </Banner>
                  ))}
                </div>
              </Panel>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
