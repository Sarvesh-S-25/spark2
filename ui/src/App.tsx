import React from 'react';
import { api, type Overview, type Project } from './api';
import { Toast } from './bits';
import { OverviewView } from './views/Overview';
import { PlanView } from './views/Plan';
import { ModulesView } from './views/Modules';
import { GraphView } from './views/Graph';
import { ContractsView } from './views/Contracts';
import { GenerateView } from './views/Generate';
import { ChecksView } from './views/Checks';
import { SettingsView } from './views/Settings';
import { ProjectsView } from './views/Projects';

export type ViewId =
  | 'projects' | 'overview' | 'plan' | 'modules' | 'graph'
  | 'contracts' | 'generate' | 'checks' | 'settings';

export interface ViewProps {
  projectId: string;
  overview: Overview;
  reload: () => Promise<void>;
  say: (tone: 'ok' | 'stop' | 'info', message: string) => void;
  go: (view: ViewId, arg?: string) => void;
  arg?: string;
}

const LAST_PROJECT = 'spark.lastProject';

export function App() {
  const [projects, setProjects] = React.useState<Project[] | null>(null);
  const [projectId, setProjectId] = React.useState<string | null>(null);
  const [overview, setOverview] = React.useState<Overview | null>(null);
  const [view, setView] = React.useState<ViewId>('projects');
  const [arg, setArg] = React.useState<string | undefined>();
  const [toast, setToast] = React.useState<{ tone: 'ok' | 'stop' | 'info'; message: string } | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const say = React.useCallback(
    (tone: 'ok' | 'stop' | 'info', message: string) => setToast({ tone, message }),
    [],
  );

  const loadProjects = React.useCallback(async () => {
    const list = await api.projects();
    setProjects(list);
    return list;
  }, []);

  const reload = React.useCallback(async () => {
    if (!projectId) return;
    try {
      setOverview(await api.overview(projectId));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [projectId]);

  // First load: pick up whatever project was open last time.
  React.useEffect(() => {
    (async () => {
      try {
        await api.health();
        const list = await loadProjects();
        let remembered: string | null = null;
        try { remembered = localStorage.getItem(LAST_PROJECT); } catch { /* private window */ }
        const pick = list.find((p) => p.id === remembered) ?? list[0];
        if (pick) {
          setProjectId(pick.id);
          setView('overview');
        }
      } catch (e) {
        setError(
          `Cannot reach the SparkX server. Start it with "npm run dev" (or "npm run start") and reload. — ${(e as Error).message}`,
        );
      }
    })();
  }, [loadProjects]);

  React.useEffect(() => { void reload(); }, [reload]);
  React.useEffect(() => {
    if (!projectId) return;
    try { localStorage.setItem(LAST_PROJECT, projectId); } catch { /* ignore */ }
  }, [projectId]);

  const go = React.useCallback((v: ViewId, a?: string) => {
    setView(v);
    setArg(a);
  }, []);

  if (error) {
    return (
      <div style={{ padding: 40, maxWidth: 640 }}>
        <h2 style={{ marginTop: 0 }}>SparkX cannot start</h2>
        <p className="muted">{error}</p>
        <button className="btn primary" onClick={() => location.reload()}>Try again</button>
      </div>
    );
  }

  const counts = {
    modules: overview?.modules.length ?? 0,
    contracts: overview?.contracts.length ?? 0,
    findings: overview?.lastCheck?.findings.filter((f) => f.severity === 'block').length ?? 0,
    crs: overview?.changeRequests.filter((c) => c.state === 'open').length ?? 0,
    ready: overview?.modules.filter((m) => m.status === 'ready').length ?? 0,
  };

  const props: ViewProps | null = projectId && overview
    ? { projectId, overview, reload, say, go, arg }
    : null;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <h1>SparkX</h1>
          <p>{overview?.project.name ?? 'no project'}</p>
        </div>

        <nav className="nav">
          <button onClick={() => go('projects')} aria-current={view === 'projects'}>Projects</button>

          {props ? (
            <>
              <div className="nav-heading">Plan</div>
              <button onClick={() => go('overview')} aria-current={view === 'overview'}>
                Overview
                {counts.ready > 0 ? <span className="count">{counts.ready} ready</span> : null}
              </button>
              <button onClick={() => go('plan')} aria-current={view === 'plan'}>Brief &amp; split</button>

              <div className="nav-heading">Build</div>
              <button onClick={() => go('modules')} aria-current={view === 'modules'}>
                Requirements<span className="count">{counts.modules}</span>
              </button>
              <button onClick={() => go('graph')} aria-current={view === 'graph'}>Graph</button>
              <button onClick={() => go('contracts')} aria-current={view === 'contracts'}>
                Contracts<span className="count">{counts.crs ? `${counts.contracts} · ${counts.crs} CR` : counts.contracts}</span>
              </button>
              <button onClick={() => go('generate')} aria-current={view === 'generate'}>Generate</button>

              <div className="nav-heading">Verify</div>
              <button onClick={() => go('checks')} aria-current={view === 'checks'}>
                Dependency check
                {counts.findings > 0 ? <span className="count">{counts.findings}</span> : null}
              </button>
            </>
          ) : null}

          <div className="nav-heading">Setup</div>
          <button onClick={() => go('settings')} aria-current={view === 'settings'}>Settings</button>
        </nav>

        <div className="sidebar-foot">
          <span>{counts.modules} modules · {counts.contracts} contracts</span>
          <span>{overview?.project.root_path ?? '—'}</span>
        </div>
      </aside>

      <main className="main">
        {view === 'projects' ? (
          <ProjectsView
            projects={projects}
            activeId={projectId}
            onPick={(id) => { setProjectId(id); go('overview'); }}
            onChanged={async () => { await loadProjects(); await reload(); }}
            say={say}
          />
        ) : view === 'settings' && !props ? (
          <SettingsView projectId={''} overview={null as any} reload={async () => {}} say={say} go={go} />
        ) : !props ? (
          <div className="page">
            <div className="empty">Pick a project, or create one, to get started.</div>
          </div>
        ) : view === 'overview' ? <OverviewView {...props} />
          : view === 'plan' ? <PlanView {...props} />
            : view === 'modules' ? <ModulesView {...props} />
              : view === 'graph' ? <GraphView {...props} />
                : view === 'contracts' ? <ContractsView {...props} />
                  : view === 'generate' ? <GenerateView {...props} />
                    : view === 'checks' ? <ChecksView {...props} />
                      : <SettingsView {...props} />}
      </main>

      {toast ? <Toast tone={toast.tone} message={toast.message} onDone={() => setToast(null)} /> : null}
    </div>
  );
}
