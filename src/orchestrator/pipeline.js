/**
 * Pipeline Orchestrator — Chains all components into the Ingest → Reason → Decide → Act loop.
 */
import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';
import { queryAll, execute } from '../db/database.js';

export class Pipeline extends EventEmitter {
  constructor({ simulator, anomalyDetector, contextRetriever, reasoningEngine, cocoBridge }) {
    super();
    this.simulator = simulator;
    this.anomalyDetector = anomalyDetector;
    this.contextRetriever = contextRetriever;
    this.reasoningEngine = reasoningEngine;
    this.cocoBridge = cocoBridge;

    this.services = new Map();
    this.isRunning = false;
    this.stats = {
      totalEvents: 0,
      anomaliesDetected: 0,
      autoResolved: 0,
      escalated: 0,
      suppressed: 0,
      startedAt: null,
    };

    this.cooldowns = new Map();
    this.cooldownPeriodMs = 30000;
  }

  initialize() {
    const services = queryAll('SELECT * FROM services');
    for (const svc of services) {
      this.services.set(svc.id, svc);
    }
    this.contextRetriever.initialize();
    console.log('🔧 Pipeline initialized');
  }

  start() {
    this.isRunning = true;
    this.stats.startedAt = new Date().toISOString();

    this.simulator.on('log-batch', async (batch, tick) => {
      await this.processBatch(batch, tick);
    });

    this.simulator.start(2000);
    console.log('🚀 IncidentIQ Pipeline started\n');
    this.emit('pipeline-started', this.stats);
  }

  async processBatch(batch, tick) {
    // Store events in DB
    for (const event of batch) {
      execute(
        `INSERT INTO log_events (id, service_id, timestamp, endpoint, method, latency_ms, status_code, error_code, request_volume, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [event.id, event.service_id, event.timestamp, event.endpoint, event.method, event.latency_ms, event.status_code, event.error_code, event.request_volume, event.metadata]
      );
    }

    this.stats.totalEvents += batch.length;
    this.emit('log-events', batch);

    // Group by service
    const byService = new Map();
    for (const event of batch) {
      if (!byService.has(event.service_id)) byService.set(event.service_id, []);
      byService.get(event.service_id).push(event);
    }

    // Anomaly detection per service
    for (const [serviceId, events] of byService) {
      const service = this.services.get(serviceId);
      if (!service) continue;

      const cooldown = this.cooldowns.get(serviceId);
      if (cooldown && Date.now() < cooldown.until) continue;

      const anomalyReport = this.anomalyDetector.analyze(serviceId, events, service);

      if (anomalyReport) {
        this.emit('anomaly-detected', anomalyReport);
        this.stats.anomaliesDetected++;
        this.cooldowns.set(serviceId, { until: Date.now() + this.cooldownPeriodMs });
        await this.processAnomaly(anomalyReport);
      }
    }

    this.emit('stats-update', this.stats);
  }

  async processAnomaly(anomalyReport) {
    console.log('[detect] Anomaly detected:', {
      service: anomalyReport.serviceId,
      severity: anomalyReport.overallSeverity,
      metrics: anomalyReport.anomalies.map(a => `${a.metric} (z=${a.zScore.toFixed(1)})`).join(', ')
    });

    // Step 1: Retrieve context
    console.log('[context] Retrieving context...');
    const context = this.contextRetriever.getContext(anomalyReport);

    this.emit('context-retrieved', {
      serviceId: anomalyReport.serviceId,
      similarIncidents: context.similarIncidents,
      relevantRunbooks: context.relevantRunbooks,
    });

    if (context.bestMatch) {
      console.log(`[context] Best match: ${context.bestMatch.title} (${(context.bestMatch.similarity * 100).toFixed(0)}%)`);
    }

    // Step 2: Run reasoning engine
    console.log('[reasoning] Running reasoning engine...');
    const reasoning = await this.reasoningEngine.reason(anomalyReport, context);

    this.emit('reasoning-complete', {
      serviceId: anomalyReport.serviceId,
      reasoning,
    });

    console.log(`[reasoning] Recommendation: ${reasoning.recommended_action}`);
    console.log(`[reasoning] Confidence: ${reasoning.confidence}`);

    // Step 3: Create incident record
    const incidentId = uuidv4();
    const actionMap = { 'AUTO_RESOLVE': 'auto-resolve', 'ESCALATE': 'escalate', 'SUPPRESS': 'suppress' };
    const incidentActionMap = { 'AUTO_RESOLVE': 'auto-resolved', 'ESCALATE': 'escalated', 'SUPPRESS': 'suppressed' };
    const service = this.services.get(anomalyReport.serviceId);

    execute(
      `INSERT INTO active_incidents (id, title, service_id, severity, status, root_cause_hypothesis, reasoning_trace, similar_incidents, suggested_remediation, assigned_team, action_taken, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        incidentId,
        reasoning.anomaly_summary || 'Anomaly detected',
        anomalyReport.serviceId,
        anomalyReport.overallSeverity === 'critical' ? 'P1' : 'P2',
        reasoning.recommended_action === 'SUPPRESS' ? 'suppressed' : 'open',
        reasoning.root_cause_hypothesis,
        JSON.stringify(reasoning),
        JSON.stringify(context.similarIncidents.map(i => i.incidentId)),
        reasoning.suggested_remediation,
        service.owner_team,
        incidentActionMap[reasoning.recommended_action] || 'escalated',
        reasoning.confidence === 'HIGH' ? 0.9 : reasoning.confidence === 'MEDIUM' ? 0.6 : 0.3,
      ]
    );

    // Step 4: Execute action via CoCo CLI
    console.log('[action] Executing action via CoCo CLI...');
    const cocoContext = {
      serviceName: service.display_name,
      severity: anomalyReport.overallSeverity === 'critical' ? 'P1' : 'P2',
      team: service.owner_team,
      remediation: reasoning.suggested_remediation,
      similarIncidentCount: context.similarIncidents.length,
    };

    let cocoResult;

    switch (reasoning.recommended_action) {
      case 'AUTO_RESOLVE':
        cocoResult = await this.cocoBridge.execute(
          'incident-auto-resolve',
          `Auto-resolve anomaly on ${service.display_name}. Root cause: ${reasoning.root_cause_hypothesis}. Remediation: ${reasoning.suggested_remediation}`,
          cocoContext,
        );
        this.stats.autoResolved++;
        execute('UPDATE active_incidents SET status = ?, resolved_at = ? WHERE id = ?',
          ['resolved', new Date().toISOString(), incidentId]);
        break;

      case 'ESCALATE':
        cocoResult = await this.cocoBridge.execute(
          'incident-escalate',
          `Escalate incident on ${service.display_name}. Severity: ${cocoContext.severity}. Root cause: ${reasoning.root_cause_hypothesis}. Assign to: ${service.owner_team}`,
          cocoContext,
        );
        this.stats.escalated++;
        break;

      case 'SUPPRESS':
        cocoResult = await this.cocoBridge.execute(
          'incident-suppress',
          `Suppress alert on ${service.display_name}. Reason: ${reasoning.action_reasoning}`,
          cocoContext,
        );
        this.stats.suppressed++;
        break;

      default:
        console.error(`Unknown action: ${reasoning.recommended_action}`);
        return;
    }

    // Log the action
    execute(
      `INSERT INTO action_log (id, incident_id, action_type, description, details, coco_command, coco_response)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        uuidv4(),
        incidentId,
        actionMap[reasoning.recommended_action] || 'escalate',
        reasoning.anomaly_summary,
        JSON.stringify({
          reasoning,
          context: {
            similarIncidents: context.similarIncidents.map(i => ({ id: i.incidentId, title: i.title, similarity: i.similarity })),
            runbooks: context.relevantRunbooks.map(r => ({ id: r.runbookId, title: r.title })),
          },
        }),
        cocoResult.command,
        cocoResult.response,
      ]
    );

    // Emit action taken event
    this.emit('action-taken', {
      incidentId,
      serviceId: anomalyReport.serviceId,
      serviceName: service.display_name,
      action: reasoning.recommended_action,
      confidence: reasoning.confidence,
      reasoning,
      cocoResponse: cocoResult.response,
      timestamp: new Date().toISOString(),
    });

    console.log(`[action] Completed: ${reasoning.recommended_action}`);
  }

  injectAnomaly(type) {
    return this.simulator.injectAnomaly(type);
  }

  reset() {
    execute('DELETE FROM action_log');
    execute('DELETE FROM active_incidents');
    execute('DELETE FROM log_events');
    
    this.stats.anomaliesDetected = 0;
    this.stats.autoResolved = 0;
    this.stats.escalated = 0;
    this.stats.suppressed = 0;
    
    // Clear simulator active anomalies
    if (this.simulator.activeAnomalies) {
      this.simulator.activeAnomalies.clear();
    }
    
    // Reset baseline tracking
    this.anomalyDetector.recentMetrics.clear();
    
    this.emit('stats-update', this.stats);
    console.log('[pipeline] Sandbox reset successfully');
  }

  getStats() {
    return { ...this.stats };
  }

  stop() {
    this.isRunning = false;
    this.simulator.stop();
    console.log('🛑 Pipeline stopped');
  }
}
