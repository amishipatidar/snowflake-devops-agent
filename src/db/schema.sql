-- IncidentIQ Database Schema
-- SQLite schema for the DevOps Incident Response Automation Agent

-- Service catalog with per-service baselines
CREATE TABLE IF NOT EXISTS services (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    owner_team TEXT NOT NULL,
    baseline_latency_ms REAL NOT NULL DEFAULT 100,
    baseline_error_rate REAL NOT NULL DEFAULT 0.02,
    baseline_request_volume INTEGER NOT NULL DEFAULT 500,
    status TEXT NOT NULL DEFAULT 'healthy',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Raw ingested log events
CREATE TABLE IF NOT EXISTS log_events (
    id TEXT PRIMARY KEY,
    service_id TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    endpoint TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'GET',
    latency_ms REAL NOT NULL,
    status_code INTEGER NOT NULL,
    error_code TEXT,
    request_volume INTEGER NOT NULL DEFAULT 1,
    metadata TEXT, -- JSON blob for extra context
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id)
);

-- Historical incident reports (structured knowledge base)
CREATE TABLE IF NOT EXISTS past_incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    service_id TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('P1', 'P2', 'P3', 'P4')),
    symptom TEXT NOT NULL,
    root_cause TEXT NOT NULL,
    resolution TEXT NOT NULL,
    resolution_type TEXT NOT NULL CHECK (resolution_type IN ('auto-resolve', 'manual', 'escalated')),
    duration_minutes INTEGER NOT NULL,
    occurred_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id)
);

-- Runbook documents (remediation guides)
CREATE TABLE IF NOT EXISTS runbooks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    service_id TEXT,
    category TEXT NOT NULL,
    content TEXT NOT NULL,
    steps TEXT NOT NULL, -- JSON array of step strings
    auto_resolvable INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id)
);

-- Active incidents created by the agent
CREATE TABLE IF NOT EXISTS active_incidents (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    service_id TEXT NOT NULL,
    severity TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'investigating', 'resolved', 'suppressed')),
    root_cause_hypothesis TEXT,
    reasoning_trace TEXT, -- Full JSON reasoning trace
    similar_incidents TEXT, -- JSON array of similar past incident IDs
    suggested_remediation TEXT,
    assigned_team TEXT,
    action_taken TEXT NOT NULL CHECK (action_taken IN ('auto-resolved', 'escalated', 'suppressed')),
    confidence REAL NOT NULL DEFAULT 0,
    resolved_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (service_id) REFERENCES services(id)
);

-- Agent action audit trail
CREATE TABLE IF NOT EXISTS action_log (
    id TEXT PRIMARY KEY,
    incident_id TEXT,
    action_type TEXT NOT NULL CHECK (action_type IN ('detect', 'analyze', 'auto-resolve', 'escalate', 'suppress', 'notify')),
    description TEXT NOT NULL,
    details TEXT, -- JSON blob
    coco_command TEXT, -- The CoCo CLI command executed
    coco_response TEXT, -- CoCo CLI response
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (incident_id) REFERENCES active_incidents(id)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_log_events_service ON log_events(service_id, timestamp);
CREATE INDEX IF NOT EXISTS idx_log_events_timestamp ON log_events(timestamp);
CREATE INDEX IF NOT EXISTS idx_past_incidents_service ON past_incidents(service_id);
CREATE INDEX IF NOT EXISTS idx_active_incidents_status ON active_incidents(status);
CREATE INDEX IF NOT EXISTS idx_action_log_incident ON action_log(incident_id);
