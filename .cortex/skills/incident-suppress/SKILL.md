---
name: incident-suppress
description: Intelligently suppresses false-positive alerts when the reasoning engine determines an anomaly is within normal operational variance. Logs the decision with full reasoning for audit compliance.
tools:
  - snowflake_query
---

# Skill: Intelligent Alert Suppression

## When to Use
- When IncidentIQ's reasoning engine determines an anomaly is within normal operational variance
- When the pattern matches known benign events (deployments, maintenance windows, autoscaler activity)
- When a brief transient spike self-resolves before causing measurable impact
- When historical data shows similar patterns were false positives

## What This Skill Does
Suppresses an alert WITHOUT escalating, but logs the suppression decision with full reasoning trace for audit compliance. This is critical for reducing alert fatigue — the #1 pain point in enterprise DevOps (avg 70% false positive rate).

## Why This Matters
Most monitoring systems create noise by alerting on every threshold breach. IncidentIQ's suppress skill proves the agent can distinguish between genuine incidents and operational noise, which is the single biggest value proposition for enterprise adoption.

## Instructions

When invoked, follow this exact workflow:

### Step 1: Validate Suppression Decision
Before suppressing, verify:
1. The anomaly is NOT on a critical path (payment processing, authentication)
2. Error rate has NOT increased (latency-only anomalies are safer to suppress)
3. The trend is stable or decreasing (not worsening)
4. Duration is short (< 2 minutes) OR matches a known benign pattern

If ANY of these checks fail on a critical service, DO NOT suppress. Escalate instead.

### Step 2: Log Suppression with Reasoning

```sql
INSERT INTO INCIDENTIQ.PUBLIC.SUPPRESSED_ALERTS (
    id,
    service_name,
    anomaly_summary,
    suppression_reason,
    confidence_level,
    reasoning_trace,
    matching_pattern,
    baseline_comparison,
    suppressed_by,
    suppressed_at
) VALUES (
    '{alert_id}',
    '{service_name}',
    '{anomaly_summary}',
    '{suppression_reason}',
    '{confidence}',
    PARSE_JSON('{reasoning_trace_json}'),
    '{matching_pattern}',
    '{baseline_comparison}',
    'incidentiq-agent',
    CURRENT_TIMESTAMP()
);
```

### Step 3: Update Alert Statistics

```sql
-- Track suppression rate for dashboard metrics
MERGE INTO INCIDENTIQ.PUBLIC.ALERT_METRICS AS target
USING (SELECT '{service_name}' AS service_name) AS source
ON target.service_name = source.service_name
WHEN MATCHED THEN
    UPDATE SET 
        total_alerts = total_alerts + 1,
        suppressed_alerts = suppressed_alerts + 1,
        last_updated = CURRENT_TIMESTAMP()
WHEN NOT MATCHED THEN
    INSERT (service_name, total_alerts, suppressed_alerts, last_updated)
    VALUES ('{service_name}', 1, 1, CURRENT_TIMESTAMP());
```

### Step 4: Consider Baseline Update
If the suppressed anomaly represents a "new normal" (e.g., service was upgraded and now has higher baseline latency):

```sql
-- Only update if this is a sustained pattern, not a one-off
UPDATE INCIDENTIQ.PUBLIC.SERVICE_BASELINES
SET baseline_latency_ms = {new_baseline},
    baseline_updated_at = CURRENT_TIMESTAMP(),
    baseline_update_reason = 'Auto-adjusted after sustained pattern change'
WHERE service_name = '{service_name}'
AND '{new_baseline}' < baseline_latency_ms * 1.5;  -- Safety: max 50% increase
```

### Step 5: Generate Suppression Summary
Provide a clear summary of why the alert was suppressed:
1. What was detected
2. Why it was classified as non-actionable
3. What historical pattern it matches
4. Confirmation that no action is needed

## Known Benign Patterns
- **Pod rescheduling**: Brief latency spike during Kubernetes maintenance (< 2 min, no errors)
- **Rolling deployments**: Error rate spike during pod rotation (< 1 min, < 10% error rate)
- **Autoscaler activity**: Volume/latency fluctuation during scale-up/down events
- **Batch job interference**: Periodic latency increase during scheduled batch processing
- **Health check noise**: Sporadic endpoint failures from aggressive health probes

## Best Practices
- ALWAYS log suppressions — they're as important as escalations for audit
- Track suppression rate per service — if it's too high, the baseline may need adjustment
- Never suppress errors on critical services without extreme confidence
- Include the reasoning trace so humans can review suppression quality

## Examples

### Example 1: Transient CPU Spike
**User:** $incident-suppress Suppress alert on API Gateway. Reason: Brief latency spike matching pod rescheduling pattern. Self-resolved within 90 seconds. No error rate increase.
**Assistant:**
🔇 Alert Suppressed

Service: API Gateway
Pattern: Transient CPU spike (pod rescheduling)
Duration: ~90 seconds
Error Impact: None

Assessment:
  → Pattern matches INC-HIST-003 (API Gateway Transient CPU Spike)
  → Previous occurrence classified as P4, no action needed
  → Anomaly self-resolved — latency returned to 45ms baseline
  → No error rate increase observed
  → Coincides with Kubernetes maintenance window

Decision: SUPPRESS — this is expected operational behavior
Logged to Snowflake: SUPPRESSED_ALERTS entry created
Baseline: No update needed (within normal range)

False positive avoided. ✅
