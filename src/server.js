/**
 * Vigil — API Server
 * Express server with SSE (Server-Sent Events) for real-time dashboard updates.
 */
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';

import { openDb, queryAll, queryOne, execute, startAutoSave } from './db/database.js';
import { LogSimulator } from './simulator/log-generator.js';
import { AnomalyDetector } from './engine/anomaly-detector.js';
import { ContextRetriever } from './engine/context-retriever.js';
import { ReasoningEngine } from './engine/reasoning-engine.js';
import { CocoBridge } from './orchestrator/coco-bridge.js';
import { Pipeline } from './orchestrator/pipeline.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3001;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
const COCO_MODE = process.env.COCO_MODE || 'simulation';
const SNOWFLAKE_CONNECTION = process.env.SNOWFLAKE_CONNECTION || 'default';

async function main() {
  console.log('');
  console.log('  Vigil — Incident Response Automation Agent');
  console.log('  Powered by Snowflake CoCo CLI + Groq');
  console.log('');

  await openDb();
  startAutoSave(5000);

  const services = queryAll('SELECT * FROM services');
  if (services.length === 0) {
    console.error('[error] No services found. Run "npm run seed" first.');
    process.exit(1);
  }

  console.log(`[init] Loaded ${services.length} services from database`);

  // Initialize components
  const simulator = new LogSimulator(services);
  const anomalyDetector = new AnomalyDetector();
  const contextRetriever = new ContextRetriever();
  const reasoningEngine = new ReasoningEngine(GROQ_API_KEY, GROQ_MODEL);
  const cocoBridge = new CocoBridge(COCO_MODE, SNOWFLAKE_CONNECTION);

  const pipeline = new Pipeline({
    simulator,
    anomalyDetector,
    contextRetriever,
    reasoningEngine,
    cocoBridge,
  });

  // SSE client management
  const sseClients = new Set();

  function broadcastSSE(event, data) {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      client.write(msg);
    }
  }

  // Wire pipeline events to SSE
  pipeline.on('log-events', (events) => {
    const summary = {};
    for (const e of events) {
      if (!summary[e.service_id]) {
        summary[e.service_id] = { count: 0, avgLatency: 0, errors: 0, service_id: e.service_id };
      }
      summary[e.service_id].count++;
      summary[e.service_id].avgLatency += e.latency_ms;
      if (e.status_code >= 500) summary[e.service_id].errors++;
    }
    for (const s of Object.values(summary)) {
      s.avgLatency = s.avgLatency / s.count;
    }
    broadcastSSE('log-batch', { events: events.slice(-8), summary: Object.values(summary), timestamp: new Date().toISOString() });
  });

  pipeline.on('anomaly-detected', (report) => broadcastSSE('anomaly-detected', report));
  pipeline.on('context-retrieved', (context) => broadcastSSE('context-retrieved', context));
  pipeline.on('reasoning-complete', (data) => broadcastSSE('reasoning-complete', data));
  pipeline.on('action-taken', (action) => broadcastSSE('action-taken', action));
  pipeline.on('stats-update', (stats) => broadcastSSE('stats-update', stats));
  simulator.on('anomaly-injected', (info) => broadcastSSE('anomaly-injected', info));

  // Express app
  const app = express();
  app.use(cors());
  app.use(express.json());

  // SSE endpoint
  app.get('/api/events', (req, res) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    res.write(`event: connected\ndata: ${JSON.stringify({ stats: pipeline.getStats(), services })}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  });

  app.get('/api/services', (req, res) => {
    res.json(queryAll('SELECT * FROM services'));
  });

  app.get('/api/incidents', (req, res) => {
    const incidents = queryAll(`
      SELECT ai.*, s.display_name as service_display_name
      FROM active_incidents ai
      JOIN services s ON ai.service_id = s.id
      ORDER BY ai.created_at DESC LIMIT 50
    `);
    res.json(incidents.map(inc => ({
      ...inc,
      reasoning_trace: inc.reasoning_trace ? JSON.parse(inc.reasoning_trace) : null,
      similar_incidents: inc.similar_incidents ? JSON.parse(inc.similar_incidents) : [],
    })));
  });

  app.get('/api/actions', (req, res) => {
    const actions = queryAll(`
      SELECT al.*, ai.title as incident_title, s.display_name as service_display_name
      FROM action_log al
      LEFT JOIN active_incidents ai ON al.incident_id = ai.id
      LEFT JOIN services s ON ai.service_id = s.id
      ORDER BY al.timestamp DESC LIMIT 50
    `);
    res.json(actions.map(a => ({
      ...a,
      details: a.details ? JSON.parse(a.details) : null,
    })));
  });

  app.get('/api/reasoning/:incidentId', (req, res) => {
    const incident = queryOne(`
      SELECT ai.*, s.display_name as service_display_name
      FROM active_incidents ai
      JOIN services s ON ai.service_id = s.id
      WHERE ai.id = ?
    `, [req.params.incidentId]);
    if (!incident) return res.status(404).json({ error: 'Incident not found' });
    const actions = queryAll('SELECT * FROM action_log WHERE incident_id = ? ORDER BY timestamp', [req.params.incidentId]);
    res.json({
      ...incident,
      reasoning_trace: incident.reasoning_trace ? JSON.parse(incident.reasoning_trace) : null,
      similar_incidents: incident.similar_incidents ? JSON.parse(incident.similar_incidents) : [],
      actions: actions.map(a => ({ ...a, details: a.details ? JSON.parse(a.details) : null })),
    });
  });

  app.get('/api/stats', (req, res) => {
    res.json(pipeline.getStats());
  });

  app.post('/api/simulate/anomaly', (req, res) => {
    const { type } = req.body;
    const validTypes = ['latency-creep', 'error-burst', 'transient-spike', 'brute-force'];
    if (!type || !validTypes.includes(type)) {
      return res.status(400).json({ error: 'Invalid anomaly type', validTypes });
    }
    const result = pipeline.injectAnomaly(type);
    if (result) {
      res.json({ success: true, anomaly: result.name, description: result.description });
    } else {
      res.json({ success: false, message: 'Injection failed (may already be active)' });
    }
  });

  app.post('/api/reset', (req, res) => {
    pipeline.reset();
    res.json({ success: true, message: 'Sandbox reset successfully' });
  });

  app.get('/api/coco/log', (req, res) => {
    res.json(cocoBridge.getLog());
  });

  // Start
  app.listen(PORT, () => {
    console.log(`[server] http://localhost:${PORT}`);
    console.log(`[server] SSE: http://localhost:${PORT}/api/events`);
    console.log(`[config] CoCo mode: ${COCO_MODE}`);
    console.log(`[config] Groq model: ${GROQ_MODEL}`);
    console.log(`[config] Groq key: ${GROQ_API_KEY ? 'configured' : 'not set (heuristic fallback)'}`);

    pipeline.initialize();
    pipeline.start();

    console.log('');
    console.log('[demo] Inject anomalies:');
    console.log(`  curl -X POST http://localhost:${PORT}/api/simulate/anomaly -H "Content-Type: application/json" -d '{"type":"latency-creep"}'`);
    console.log(`  curl -X POST http://localhost:${PORT}/api/simulate/anomaly -H "Content-Type: application/json" -d '{"type":"error-burst"}'`);
    console.log(`  curl -X POST http://localhost:${PORT}/api/simulate/anomaly -H "Content-Type: application/json" -d '{"type":"transient-spike"}'`);
    console.log('');
  });
}

main().catch(console.error);
