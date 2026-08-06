---
name: incident-escalate
description: Creates and escalates incident tickets with AI-generated root cause analysis, similar past incidents, and remediation suggestions. Routes to the correct team based on service ownership.
tools:
  - snowflake_query
  - shell
---

# Skill: Incident Escalation

## When to Use
- When IncidentIQ's reasoning engine identifies a genuine anomaly requiring human investigation
- When no high-confidence auto-resolve match exists
- When the anomaly pattern is new or unfamiliar
- When the past incident resolution required manual intervention or escalation
- When service criticality demands human oversight (P1/P2 incidents)

## What This Skill Does
Creates a comprehensive incident ticket pre-filled with AI-generated analysis, routes it to the correct team, and sends notifications — ensuring responders have full context from the moment they engage.

## Instructions

When invoked, follow this exact workflow:

### Step 1: Create Incident Record in Snowflake

```sql
INSERT INTO INCIDENTIQ.PUBLIC.ACTIVE_INCIDENTS (
    id,
    title,
    service_name,
    severity,
    status,
    root_cause_hypothesis,
    confidence_level,
    reasoning_trace,
    similar_incidents,
    suggested_remediation,
    assigned_team,
    created_by,
    created_at
) VALUES (
    '{incident_id}',
    '[{severity}] {service_name} — {anomaly_summary}',
    '{service_name}',
    '{severity}',
    'investigating',
    '{root_cause_hypothesis}',
    '{confidence}',
    PARSE_JSON('{reasoning_trace_json}'),
    PARSE_JSON('{similar_incidents_json}'),
    '{suggested_remediation}',
    '{assigned_team}',
    'incidentiq-agent',
    CURRENT_TIMESTAMP()
);
```

### Step 2: Link Similar Past Incidents

For each similar past incident found by the context retriever:

```sql
INSERT INTO INCIDENTIQ.PUBLIC.INCIDENT_LINKS (
    active_incident_id,
    past_incident_id,
    similarity_score,
    linked_at
) VALUES (
    '{incident_id}',
    '{past_incident_id}',
    {similarity_score},
    CURRENT_TIMESTAMP()
);
```

### Step 3: Attach Runbook Steps

```sql
INSERT INTO INCIDENTIQ.PUBLIC.INCIDENT_RUNBOOKS (
    incident_id,
    runbook_id,
    runbook_title,
    steps,
    attached_at
) VALUES (
    '{incident_id}',
    '{runbook_id}',
    '{runbook_title}',
    PARSE_JSON('{steps_json}'),
    CURRENT_TIMESTAMP()
);
```

### Step 4: Determine Routing

Route based on service ownership and severity:
- **P1 (Critical)**: Page on-call + notify engineering leadership
- **P2 (High)**: Page on-call team
- **P3 (Medium)**: Create ticket, notify via Slack
- **P4 (Low)**: Create ticket only

Team routing:
- `api-gateway` → `platform-engineering`
- `payment-service` → `payments-team`  
- `auth-service` → `identity-team`
- `notification-service` → `comms-team`

### Step 5: Generate Notification

Compose an incident notification with:
1. **Title**: `[SEVERITY] Service — Brief description`
2. **Impact**: What's affected and estimated blast radius
3. **Root Cause Hypothesis**: From the reasoning engine
4. **Similar Past Incidents**: Titles and links
5. **Suggested Next Steps**: From runbooks
6. **Reasoning Trace Link**: For full transparency

### Step 6: Log Escalation Action

```sql
INSERT INTO INCIDENTIQ.PUBLIC.ACTION_LOG (
    id, incident_id, action_type, description, timestamp
) VALUES (
    '{action_id}', '{incident_id}', 'escalate', 
    'Incident escalated to {assigned_team}. Severity: {severity}. Notifications sent.',
    CURRENT_TIMESTAMP()
);
```

## Best Practices
- Always include the full reasoning trace so responders can audit the AI's decision
- Link ALL similar past incidents, even low-similarity ones — they provide useful context
- Include specific, actionable next steps, not vague suggestions
- Set severity based on service criticality and blast radius, not just metric deviation

## Examples

### Example 1: Auth Service Error Burst
**User:** $incident-escalate Escalate incident on Authentication Service. Severity: P1. Root cause hypothesis: Redis session store became unreachable. Error clustering on /login endpoint with REDIS_CONNECTION_REFUSED errors. Assign to: identity-team
**Assistant:**
🚨 Incident Escalated

Incident ID: INC-2026-0802-001
Service: Authentication Service
Severity: P1 — Critical
Assigned To: identity-team
Status: INVESTIGATING

Analysis:
  Root Cause: Redis session store connectivity failure
  Confidence: HIGH (87% match with INC-HIST-002)
  Blast Radius: ALL authenticated API calls affected

Past Incident Reference:
  INC-HIST-002: "Auth Service Login Endpoint 5xx Errors" — resolved by Redis failover

Suggested Next Steps:
  1. Check Redis connectivity: redis-cli -h redis-sessions.internal ping
  2. If Redis down, initiate failover: kubectl apply -f redis-failover.yaml
  3. Enable cached token validation as temporary mitigation

Notifications:
  ✅ PagerDuty: identity-team-oncall paged
  ✅ Slack: #incident-response notified
  ✅ Snowflake: Incident record created
