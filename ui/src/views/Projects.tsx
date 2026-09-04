import React from 'react';
import { api, type Project } from '../api';
import { Panel, Field, Empty } from '../bits';

export function ProjectsView({ projects, activeId, onPick, onChanged, say }: {
  projects: Project[] | null;
  activeId: string | null;
  onPick: (id: string) => void;
  onChanged: () => Promise<void>;
  say: (tone: 'ok' | 'stop' | 'info', m: string) => void;
}) {
  const [name, setName] = React.useState('');
  const [root, setRoot] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function create() {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const p = await api.createProject(name.trim(), root.trim() || undefined);
      setName('');
      setRoot('');
      await onChanged();
      onPick(p.id);
      say('ok', `Created ${p.name}.`);
    } catch (e) {
      say('stop', (e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <h2>Projects</h2>
        <p>
          One project per codebase. The source directory is where SparkX writes generated
          contracts and where the dependency check looks for your code — point it at your
          repo, or leave it and SparkX will use a folder under <code className="inline">workspace/</code>.
        </p>
      </div>

      <div className="stack">
        <Panel title="New project">
          <div className="stack">
            <Field label="Name">
              <input
                type="text"
                value={name}
                placeholder="Live map tracker"
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void create(); }}
              />
            </Field>
            <Field label="Source directory (optional)">
              <input
                type="text"
                value={root}
                placeholder="workspace/live-map-tracker"
                onChange={(e) => setRoot(e.target.value)}
              />
            </Field>
            <div className="row">
              <button className="btn primary" disabled={busy || !name.trim()} onClick={() => void create()}>
                Create project
              </button>
            </div>
          </div>
        </Panel>

        <Panel title="Existing" hint={projects ? `${projects.length} project${projects.length === 1 ? '' : 's'}` : undefined}>
          {!projects ? (
            <span className="spinner">loading…</span>
          ) : projects.length === 0 ? (
            <Empty>
              No projects yet. Create one above, or run <code className="inline">npm run seed</code> in a
              terminal to load the worked example from the plan.
            </Empty>
          ) : (
            <div className="tw">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th className="mono">Source directory</th>
                    <th className="num">Modules</th>
                    <th className="num">Contracts</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {projects.map((p) => (
                    <tr key={p.id} className="clickable" onClick={() => onPick(p.id)}>
                      <td>
                        <b>{p.name}</b>{' '}
                        {p.id === activeId ? <span className="chip ok">open</span> : null}
                      </td>
                      <td className="mono muted">{p.root_path ?? '—'}</td>
                      <td className="num">{p.module_count ?? 0}</td>
                      <td className="num">{p.contract_count ?? 0}</td>
                      <td>
                        <button
                          className="btn small danger"
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm(`Delete "${p.name}"? Generated files on disk are left alone.`)) return;
                            await api.deleteProject(p.id);
                            await onChanged();
                            say('ok', `Deleted ${p.name}.`);
                          }}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
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
