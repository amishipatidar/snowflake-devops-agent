---
name: incident-auto-resolve
description: Automatically resolves known infrastructure incidents by executing proven remediation steps. Triggered when the IncidentIQ reasoning engine identifies a high-confidence match with a previously resolved issue.
tools:
  - snowflake_query
  - shell
---

# Skill: Incident Auto-Resolve

## When to Use
- When IncidentIQ's reasoning engine determines an anomaly matches a known, previously auto-resolved incident with HIGH confidence
- When a verified runbook exists for the detected pattern and is marked as auto-resolvable
- When the root cause hypothesis matches a safe-fix category (service restart, cache flush, connection pool reset, config reload)

## What This Skill Does
Executes a safe, proven remediation action for a known infrastructure issue WITHOUT requiring human intervention. This is the core automation capability — reducing MTTR from minutes to seconds for recurring issues.

## Instructions

When invoked, follow this exact workflow:

### Step 1: Validate the Auto-Resolve Decision
Before taking any action, verify:
1. The confidence level from the reasoning engine is HIGH
2. The matched past incident was successfully resolved via auto-resolve (not escalation)
3. A runbook exists and is marked auto-resolvable
4. The affected service is not currently in a maintenance window or degraded state from another incident

If ANY validation fails, DO NOT auto-resolve. Instead, trigger `$incident-escalate`.

### Step 2: Execute Remediation
Based on the root cause hypothesis, execute the appropriate remediation:

**Connection Pool Exhaustion:**
```sql
-- Log the remediation action to Snowflake
INSERT INTO INCIDENTIQ.PUBLIC.REMEDIATION_LOG (
    incident_id, service_name, action, status, executed_at, executed_by
) VALUES (
    '{incident_id}', '{service_name}', 'connection_pool_reset', 'executing', CURRENT_TIMESTAMP(), 'incidentiq-agent'
);
```
Then simulate: `kubectl rollout restart deployment/{service-name}`

**Cache Invalidation:**
```sql
INSERT INTO INCIDENTIQ.PUBLIC.REMEDIATION_LOG (
    incident_id, service_name, action, status, executed_at, executed_by
) VALUES (
    '{incident_id}', '{service_name}', 'cache_flush', 'executing', CURRENT_TIMESTAMP(), 'incidentiq-agent'
);
```

**Service Restart (Generic):**
```sql
INSERT INTO INCIDENTIQ.PUBLIC.REMEDIATION_LOG (
    incident_id, service_name, action, status, executed_at, executed_by
) VALUES (
    '{incident_id}', '{service_name}', 'service_restart', 'executing', CURRENT_TIMESTAMP(), 'incidentiq-agent'
);
```

### Step 3: Verify Recovery
After executing remediation:
1. Wait for the service health check to pass (30 seconds)
2. Verify that the anomalous metrics have returned to baseline
3. Log the successful resolution

```sql
UPDATE INCIDENTIQ.PUBLIC.REMEDIATION_LOG
SET status = 'completed', completed_at = CURRENT_TIMESTAMP()
WHERE incident_id = '{incident_id}';

UPDATE INCIDENTIQ.PUBLIC.ACTIVE_INCIDENTS
SET status = 'resolved', resolved_at = CURRENT_TIMESTAMP(), resolution_notes = 'Auto-resolved by IncidentIQ agent'
WHERE id = '{incident_id}';
```

### Step 4: Notify
Send a confirmation summary:
- What was detected
- What action was taken
- Current service health status
- Link to the full reasoning trace

## Best Practices
- Always verify before acting — never auto-resolve without validation
- Log every action for audit trail
- If remediation fails, immediately escalate to `$incident-escalate`
- Keep auto-resolve actions limited to LOW-RISK remediations only

## Examples

### Example 1: Connection Pool Reset
**User:** $incident-auto-resolve Auto-resolve anomaly on Payment Service. Root cause: Database connection pool exhaustion from batch job. Remediation: Restart service to flush connection pool.
**Assistant:** 
🔧 Auto-Remediation Executed
Service: Payment Service
Root Cause: Connection pool exhaustion (matches INC-HIST-001)
Action Taken: Rolling restart of payment-service deployment
Verification: ✅ Latency returned to baseline (120ms), connection pool at 12/50
Logged to Snowflake: REMEDIATION_LOG entry created
