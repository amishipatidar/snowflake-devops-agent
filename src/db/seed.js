import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = path.join(__dirname, '..', '..', 'incidentiq.db');

let SQL = null;

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export async function getDb() {
  const SqlJs = await getSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    return new SqlJs.Database(buffer);
  }
  return new SqlJs.Database();
}

export function saveDb(db) {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

export async function initializeDb() {
  const SqlJs = await getSqlJs();
  const db = new SqlJs.Database();
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.run(schema);
  return db;
}

// ─────────────────────────────────────────
// Seed Data
// ─────────────────────────────────────────

const SERVICES = [
  {
    id: 'svc-api-gateway',
    name: 'api-gateway',
    display_name: 'API Gateway',
    owner_team: 'platform-engineering',
    baseline_latency_ms: 45,
    baseline_error_rate: 0.01,
    baseline_request_volume: 1200,
  },
  {
    id: 'svc-payment',
    name: 'payment-service',
    display_name: 'Payment Service',
    owner_team: 'payments-team',
    baseline_latency_ms: 120,
    baseline_error_rate: 0.005,
    baseline_request_volume: 350,
  },
  {
    id: 'svc-auth',
    name: 'auth-service',
    display_name: 'Authentication Service',
    owner_team: 'identity-team',
    baseline_latency_ms: 35,
    baseline_error_rate: 0.008,
    baseline_request_volume: 2000,
  },
  {
    id: 'svc-notification',
    name: 'notification-service',
    display_name: 'Notification Service',
    owner_team: 'comms-team',
    baseline_latency_ms: 80,
    baseline_error_rate: 0.015,
    baseline_request_volume: 600,
  },
];

const PAST_INCIDENTS = [
  {
    id: 'inc-hist-001',
    title: 'Payment Service Latency Degradation — Connection Pool Exhaustion',
    service_id: 'svc-payment',
    severity: 'P2',
    symptom: 'Gradual latency increase from 120ms to 350ms over 10 minutes on payment-service. No error rate spike. Request volume normal.',
    root_cause: 'Database connection pool reached maximum capacity due to long-running queries from the monthly billing batch job. Connections were not being released properly after timeout.',
    resolution: 'Restarted the payment-service to flush the connection pool. Applied fix to release stale connections after 30s timeout.',
    resolution_type: 'auto-resolve',
    duration_minutes: 25,
    occurred_at: '2026-06-15T14:30:00Z',
  },
  {
    id: 'inc-hist-002',
    title: 'Auth Service Login Endpoint 5xx Errors',
    service_id: 'svc-auth',
    severity: 'P1',
    symptom: 'Burst of 500 errors on /api/auth/login endpoint. Error rate jumped from 0.8% to 45%. Latency remained normal. Affecting all regions.',
    root_cause: 'Redis session store became unreachable after a network partition in the us-east-1 availability zone. Session validation calls were timing out and returning 500.',
    resolution: 'Failover to backup Redis cluster. Investigated and resolved network partition. Implemented circuit breaker for session store calls.',
    resolution_type: 'escalated',
    duration_minutes: 45,
    occurred_at: '2026-05-22T09:15:00Z',
  },
  {
    id: 'inc-hist-003',
    title: 'API Gateway Transient CPU Spike',
    service_id: 'svc-api-gateway',
    severity: 'P4',
    symptom: 'Brief latency spike on api-gateway from 45ms to 200ms lasting approximately 90 seconds. Self-resolved. No error rate change.',
    root_cause: 'Kubernetes node autoscaler triggered a reschedule during a routine cluster upgrade. Pod was briefly running on a CPU-constrained node before migration completed.',
    resolution: 'No action needed. Self-resolved when pod migration completed. This is expected behavior during maintenance windows.',
    resolution_type: 'auto-resolve',
    duration_minutes: 2,
    occurred_at: '2026-07-01T03:45:00Z',
  },
  {
    id: 'inc-hist-004',
    title: 'Payment Service Timeout Cascade',
    service_id: 'svc-payment',
    severity: 'P1',
    symptom: 'Payment processing timeouts cascading to downstream services. Latency over 5000ms. Error rate at 60%. Transaction failures reported by merchants.',
    root_cause: 'Third-party payment gateway (Stripe) experienced a regional outage. All outbound payment API calls were timing out at the 5s mark, causing thread pool exhaustion.',
    resolution: 'Activated payment failover to backup provider. Communicated with Stripe support. Implemented automatic failover trigger when primary gateway latency exceeds 3s.',
    resolution_type: 'escalated',
    duration_minutes: 90,
    occurred_at: '2026-04-10T16:00:00Z',
  },
  {
    id: 'inc-hist-005',
    title: 'Notification Service Queue Backlog',
    service_id: 'svc-notification',
    severity: 'P3',
    symptom: 'Notification delivery delays. Processing latency increased from 80ms to 500ms. No errors, but queue depth growing linearly.',
    root_cause: 'A marketing campaign triggered 10x normal email volume. The notification worker pool was undersized for the burst, causing queue backlog.',
    resolution: 'Scaled worker pool from 4 to 12 instances. Queue drained within 20 minutes. Added auto-scaling rules for queue depth.',
    resolution_type: 'manual',
    duration_minutes: 35,
    occurred_at: '2026-06-28T11:00:00Z',
  },
  {
    id: 'inc-hist-006',
    title: 'Auth Service Token Validation Slowdown',
    service_id: 'svc-auth',
    severity: 'P3',
    symptom: 'JWT token validation latency increased from 35ms to 150ms. Affecting all authenticated API calls downstream. No errors.',
    root_cause: 'JWKS (JSON Web Key Set) cache expired and the auth service was making synchronous calls to the identity provider for every token validation instead of using cached keys.',
    resolution: 'Restarted auth-service to refresh JWKS cache. Fixed cache TTL configuration from 1 hour to 24 hours with background refresh.',
    resolution_type: 'auto-resolve',
    duration_minutes: 15,
    occurred_at: '2026-07-12T08:20:00Z',
  },
  {
    id: 'inc-hist-007',
    title: 'API Gateway Memory Leak',
    service_id: 'svc-api-gateway',
    severity: 'P2',
    symptom: 'Slow linear increase in API gateway response times over 48 hours. Latency crept from 45ms to 180ms. Memory usage at 92%.',
    root_cause: 'Memory leak in request logging middleware. Large request bodies were being held in memory for async log shipping but never garbage collected.',
    resolution: 'Rolling restart of API gateway pods. Deployed fix to stream request bodies instead of buffering.',
    resolution_type: 'manual',
    duration_minutes: 120,
    occurred_at: '2026-03-18T06:00:00Z',
  },
  {
    id: 'inc-hist-008',
    title: 'Payment Service SSL Certificate Near-Expiry',
    service_id: 'svc-payment',
    severity: 'P2',
    symptom: 'Intermittent TLS handshake failures on payment-service. Error rate spiking to 15% with ERR_SSL_PROTOCOL_ERROR. Some clients connecting fine, others failing.',
    root_cause: 'SSL certificate was 2 days from expiration. Some CDN edge nodes had cached the old cert while others had already failed over, causing inconsistent behavior.',
    resolution: 'Emergency certificate renewal and CDN cache purge. Implemented certificate expiry monitoring with 30-day advance alerts.',
    resolution_type: 'escalated',
    duration_minutes: 60,
    occurred_at: '2026-05-05T22:00:00Z',
  },
  {
    id: 'inc-hist-009',
    title: 'Notification Service False Alarm — Deployment Spike',
    service_id: 'svc-notification',
    severity: 'P4',
    symptom: 'Brief error rate spike to 8% on notification-service during deployment window. Lasted 30 seconds. Health checks temporarily failing.',
    root_cause: 'Normal behavior during rolling deployment. Old pods receiving SIGTERM while new pods were still in readiness probe phase. No actual service impact.',
    resolution: 'No action needed. This is expected during deployments. Adjusted alerting rules to suppress during known deployment windows.',
    resolution_type: 'auto-resolve',
    duration_minutes: 1,
    occurred_at: '2026-07-20T14:00:00Z',
  },
  {
    id: 'inc-hist-010',
    title: 'Auth Service Brute Force Attack',
    service_id: 'svc-auth',
    severity: 'P1',
    symptom: 'Request volume to /api/auth/login spiked 20x normal. Error rate at 98% (401 responses). Legitimate users experiencing timeouts due to rate limiting.',
    root_cause: 'Credential stuffing attack from a botnet. Over 500K login attempts per minute from distributed IP ranges. Rate limiter was configured too permissively.',
    resolution: 'Activated WAF geo-blocking rules. Tightened rate limits to 10 req/min per IP. Implemented CAPTCHA challenge after 3 failed attempts. Notified security team.',
    resolution_type: 'escalated',
    duration_minutes: 30,
    occurred_at: '2026-06-02T01:30:00Z',
  },
];

const RUNBOOKS = [
  {
    id: 'rb-001',
    title: 'Service Restart Procedure',
    service_id: null,
    category: 'general',
    content: 'Standard operating procedure for restarting any microservice. Use when a service is experiencing connection pool exhaustion, memory leaks, or cache invalidation issues that can be resolved by recycling the process.',
    steps: JSON.stringify([
      'Verify the service is actually unhealthy (check /health endpoint)',
      'Notify the #incident-response Slack channel',
      'Initiate graceful shutdown: kubectl rollout restart deployment/<service-name>',
      'Monitor new pod readiness probes (typically 30s)',
      'Verify health endpoint returns 200 on new pods',
      'Confirm latency/error metrics have returned to baseline',
      'Update incident ticket with resolution details',
    ]),
    auto_resolvable: 1,
  },
  {
    id: 'rb-002',
    title: 'Database Connection Pool Recovery',
    service_id: 'svc-payment',
    category: 'database',
    content: 'Recovery procedure for database connection pool exhaustion on payment-service. This is a known recurring issue triggered by batch jobs or connection leaks. The payment service uses HikariCP with a max pool size of 50.',
    steps: JSON.stringify([
      'Check current connection count: SELECT count(*) FROM pg_stat_activity',
      'Identify long-running queries: SELECT pid, query, state FROM pg_stat_activity WHERE state != idle',
      'If batch job is running, wait for completion or terminate',
      'Restart payment-service to flush pool: kubectl rollout restart deployment/payment-service',
      'Verify new connection count is within normal range (10-20 active)',
      'Monitor latency for 5 minutes to confirm recovery',
    ]),
    auto_resolvable: 1,
  },
  {
    id: 'rb-003',
    title: 'Authentication Service Incident Escalation',
    service_id: 'svc-auth',
    category: 'escalation',
    content: 'Escalation procedure for auth-service incidents. Authentication failures have high blast radius — every authenticated API call depends on this service. Escalate immediately for P1/P2.',
    steps: JSON.stringify([
      'Verify PagerDuty alert severity',
      'Page the identity-team primary on-call',
      'If Redis is down, initiate emergency failover to standby replica',
      'Monitor error rate during failover (expected blip of 5s)',
      'Verify JWT validation latency post-failover',
    ]),
    auto_resolvable: 0,
  },
  {
    id: 'rb-006',
    title: 'Brute Force / Credential Stuffing Mitigation',
    service_id: 'svc-auth',
    category: 'security',
    content: 'Automated lockdown procedure for credential stuffing or brute force attacks against the authentication service. Detected via massive spikes in 401 Unauthorized errors on the /login endpoint.',
    steps: JSON.stringify([
      'Identify offending IP ranges triggering the 401 spike',
      'Deploy WAF rule to block identified IP addresses via gateway configuration',
      'Apply strict rate limiting (10 req/min) to /login endpoint',
      'Enable CAPTCHA for all authentication attempts',
      'Notify Security Operations Center (SOC)',
    ]),
    auto_resolvable: 1,
  },
  {
    id: 'rb-007',
    title: 'Transient Spike Handling (Deployment/Scaling)',
    service_id: null,
    category: 'general',
    content: 'Handling transient spikes during deployments or scaling events.',
    steps: JSON.stringify([
      'Page the Identity Team on-call: @identity-team-oncall',
      'Create P1 incident in PagerDuty with tag: auth-service',
      'Check Redis session store connectivity',
      'Check identity provider status page for outages',
      'If Redis is down, initiate failover',
      'If IdP is down, enable cached token validation mode',
      'Communicate blast radius to stakeholders via #incident-comms',
    ]),
    auto_resolvable: 0,
  },
  {
    id: 'rb-004',
    title: 'API Gateway Performance Triage',
    service_id: 'svc-api-gateway',
    category: 'performance',
    content: 'Triage procedure for API gateway performance degradation. The API gateway is the entry point for all traffic — latency increases here affect every downstream service. Common causes: pod scheduling, memory leaks, SSL cert issues.',
    steps: JSON.stringify([
      'Check if this coincides with a known maintenance window or deployment',
      'Verify Kubernetes node health: kubectl get nodes',
      'Check pod resource usage: kubectl top pods -l app=api-gateway',
      'If memory > 80%, consider a rolling restart',
      'If CPU spike is transient (< 2 minutes), suppress alert and monitor',
      'For sustained degradation, check for upstream dependency issues',
      'Review recent config changes in git log for api-gateway repo',
    ]),
    auto_resolvable: 0,
  },
  {
    id: 'rb-005',
    title: 'Notification Service Queue Management',
    service_id: 'svc-notification',
    category: 'scaling',
    content: 'Procedure for managing notification service queue backlogs. The notification service processes emails, SMS, and push notifications through a RabbitMQ queue. Backlogs typically occur during marketing campaigns or system-wide alert storms.',
    steps: JSON.stringify([
      'Check queue depth: rabbitmqctl list_queues',
      'If queue depth > 10000, scale workers to 12 replicas',
      'Check for poison messages being requeued',
      'If poison messages found, move to dead-letter queue',
      'Monitor drain rate — should decrease by ~500/min per worker',
      'Once queue is drained, scale workers back to normal (4 replicas)',
      'Review if auto-scaling rules need adjustment for future bursts',
    ]),
    auto_resolvable: 1,
  },
];

// ─────────────────────────────────────────
// Main Seed Function
// ─────────────────────────────────────────

async function seed() {
  console.log('🌱 Seeding IncidentIQ database...\n');

  // Remove existing DB if present
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('  Removed existing database');
  }

  const db = await initializeDb();
  console.log('  Created fresh database with schema\n');

  // Seed services
  for (const svc of SERVICES) {
    db.run(
      `INSERT INTO services (id, name, display_name, owner_team, baseline_latency_ms, baseline_error_rate, baseline_request_volume)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [svc.id, svc.name, svc.display_name, svc.owner_team, svc.baseline_latency_ms, svc.baseline_error_rate, svc.baseline_request_volume]
    );
    console.log(`  ✅ Service: ${svc.display_name}`);
  }
  console.log(`  → ${SERVICES.length} services seeded\n`);

  // Seed past incidents
  for (const inc of PAST_INCIDENTS) {
    db.run(
      `INSERT INTO past_incidents (id, title, service_id, severity, symptom, root_cause, resolution, resolution_type, duration_minutes, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [inc.id, inc.title, inc.service_id, inc.severity, inc.symptom, inc.root_cause, inc.resolution, inc.resolution_type, inc.duration_minutes, inc.occurred_at]
    );
    console.log(`  ✅ Incident: ${inc.title.substring(0, 50)}...`);
  }
  console.log(`  → ${PAST_INCIDENTS.length} past incidents seeded\n`);

  // Seed runbooks
  for (const rb of RUNBOOKS) {
    db.run(
      `INSERT INTO runbooks (id, title, service_id, category, content, steps, auto_resolvable)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [rb.id, rb.title, rb.service_id, rb.category, rb.content, rb.steps, rb.auto_resolvable]
    );
    console.log(`  ✅ Runbook: ${rb.title}`);
  }
  console.log(`  → ${RUNBOOKS.length} runbooks seeded\n`);

  // Save to disk
  saveDb(db);
  db.close();

  console.log('🎉 Database seeded successfully!');
  console.log(`   Location: ${DB_PATH}`);
}

seed();

export { DB_PATH };
