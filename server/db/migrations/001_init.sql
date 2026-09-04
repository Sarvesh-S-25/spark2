-- SparkX initial schema.
--
-- Two shapes matter here:
--   1. `module` and `contract` are separate first-class objects joined by
--      `module_contract`. A contract has exactly one provider and any number of
--      consumers, and the whole dependency check is a query over that join.
--   2. `status_event` is append-only. A module's status is never stored as a
--      mutable column — it is folded from evidence. See server/status/derive.ts.

CREATE TABLE project (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  root_path   TEXT,
  repo_url    TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE plan_revision (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  n                 INTEGER NOT NULL,
  source            TEXT NOT NULL,             -- studio | pasted | imported | repo
  body_md           TEXT NOT NULL,
  capabilities_json TEXT,                      -- Pass A output, cached on the revision
  model_run_id      TEXT,
  created_at        TEXT NOT NULL,
  UNIQUE (project_id, n)
);

CREATE TABLE module (
  id                   TEXT PRIMARY KEY,
  project_id           TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  plan_revision_id     TEXT REFERENCES plan_revision(id),
  slug                 TEXT NOT NULL,          -- stable identity across re-splits
  name                 TEXT NOT NULL,
  lane                 TEXT NOT NULL CHECK (lane IN ('frontend','backend','shared','infra')),
  kind                 TEXT NOT NULL,
  summary              TEXT,
  responsibilities_json TEXT,
  non_goals_json       TEXT,
  files_json           TEXT,
  acceptance_json      TEXT,
  est_size             TEXT CHECK (est_size IN ('S','M','L')),
  manual_status        TEXT,                   -- the visible "asserted" override
  created_at           TEXT NOT NULL,
  UNIQUE (project_id, slug)
);

CREATE TABLE contract (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,               -- e.g. markers.list
  kind            TEXT NOT NULL CHECK (kind IN ('http','function','event','type','config')),
  owner_module_id TEXT REFERENCES module(id),
  current_version TEXT,                        -- semver of the newest non-removed version
  created_at      TEXT NOT NULL,
  UNIQUE (project_id, key)
);

CREATE TABLE contract_version (
  id            TEXT PRIMARY KEY,
  contract_id   TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  semver        TEXT NOT NULL,
  state         TEXT NOT NULL CHECK (state IN ('draft','proposed','locked','deprecated','removed')),
  spec_json     TEXT NOT NULL,
  examples_json TEXT NOT NULL,
  spec_hash     TEXT NOT NULL,                 -- drift-detection anchor
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  locked_at     TEXT,
  UNIQUE (contract_id, semver)
);

CREATE TABLE module_contract (
  module_id      TEXT NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  contract_id    TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  role           TEXT NOT NULL CHECK (role IN ('provides','consumes')),
  pinned_version TEXT,
  PRIMARY KEY (module_id, contract_id, role)
);

-- Invariant: exactly one module may provide a contract. Enforced in SQL rather
-- than application code so no code path can violate it.
CREATE UNIQUE INDEX one_provider_per_contract
  ON module_contract (contract_id) WHERE role = 'provides';

CREATE TABLE claim (
  module_id        TEXT PRIMARY KEY REFERENCES module(id) ON DELETE CASCADE,
  assignee         TEXT NOT NULL,
  claimed_at       TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);

CREATE TABLE status_event (
  id            TEXT PRIMARY KEY,
  module_id     TEXT NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  from_status   TEXT,
  to_status     TEXT NOT NULL,
  cause         TEXT NOT NULL,                 -- derived | claimed | asserted | check
  actor         TEXT,
  evidence_json TEXT,
  at            TEXT NOT NULL
);

CREATE TABLE check_run (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  commit_sha   TEXT,
  levels       TEXT NOT NULL,                  -- e.g. "1,2"
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  summary_json TEXT
);

CREATE TABLE finding (
  id           TEXT PRIMARY KEY,
  check_run_id TEXT NOT NULL REFERENCES check_run(id) ON DELETE CASCADE,
  severity     TEXT NOT NULL CHECK (severity IN ('block','warn','info')),
  code         TEXT NOT NULL,                  -- stable id, e.g. ORPHAN_CONTRACT
  module_id    TEXT,
  contract_id  TEXT,
  message      TEXT NOT NULL,
  fix_hint     TEXT
);

CREATE TABLE change_request (
  id                 TEXT PRIMARY KEY,
  contract_id        TEXT NOT NULL REFERENCES contract(id) ON DELETE CASCADE,
  from_semver        TEXT,
  to_semver          TEXT NOT NULL,
  proposed_spec_json TEXT NOT NULL,
  reason             TEXT NOT NULL,
  change_class       TEXT NOT NULL CHECK (change_class IN ('additive','widening','breaking')),
  state              TEXT NOT NULL CHECK (state IN ('open','accepted','rejected','withdrawn')),
  opened_by          TEXT,
  opened_at          TEXT NOT NULL,
  resolved_at        TEXT,
  break_glass        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE change_ack (
  change_request_id TEXT NOT NULL REFERENCES change_request(id) ON DELETE CASCADE,
  module_id         TEXT NOT NULL REFERENCES module(id) ON DELETE CASCADE,
  decision          TEXT NOT NULL CHECK (decision IN ('ack','object')),
  reason            TEXT,
  at                TEXT NOT NULL,
  PRIMARY KEY (change_request_id, module_id)
);

CREATE TABLE model_run (
  id           TEXT PRIMARY KEY,
  project_id   TEXT,
  provider     TEXT NOT NULL,
  model        TEXT NOT NULL,
  purpose      TEXT NOT NULL,                  -- pass:A | pass:B | pass:C | ...
  prompt_hash  TEXT NOT NULL,
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  cost_usd     REAL,
  latency_ms   INTEGER,
  ok           INTEGER NOT NULL,
  repair_count INTEGER NOT NULL DEFAULT 0,
  cached       INTEGER NOT NULL DEFAULT 0,
  error        TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE prompt_cache (
  prompt_hash   TEXT PRIMARY KEY,
  response_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE INDEX idx_module_project     ON module (project_id);
CREATE INDEX idx_contract_project   ON contract (project_id);
CREATE INDEX idx_cv_contract        ON contract_version (contract_id);
CREATE INDEX idx_mc_contract        ON module_contract (contract_id);
CREATE INDEX idx_mc_module          ON module_contract (module_id);
CREATE INDEX idx_status_module      ON status_event (module_id);
CREATE INDEX idx_finding_run        ON finding (check_run_id);
