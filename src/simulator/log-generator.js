import { v4 as uuidv4 } from 'uuid';
import { EventEmitter } from 'events';

/**
 * Log Simulator — Generates realistic service log events with injectable anomalies.
 * 
 * Emits events: 'log-batch', 'anomaly-injected'
 */
export class LogSimulator extends EventEmitter {
  constructor(services) {
    super();
    this.services = services;
    this.intervalId = null;
    this.tick = 0;
    this.activeAnomalies = new Map(); // service_id -> anomaly config
    this.endpoints = {
      'svc-api-gateway': [
        { path: '/api/v1/users', method: 'GET', weight: 30 },
        { path: '/api/v1/orders', method: 'GET', weight: 25 },
        { path: '/api/v1/products', method: 'GET', weight: 20 },
        { path: '/api/v1/health', method: 'GET', weight: 15 },
        { path: '/api/v1/orders', method: 'POST', weight: 10 },
      ],
      'svc-payment': [
        { path: '/api/payments/charge', method: 'POST', weight: 35 },
        { path: '/api/payments/refund', method: 'POST', weight: 15 },
        { path: '/api/payments/status', method: 'GET', weight: 30 },
        { path: '/api/payments/webhook', method: 'POST', weight: 20 },
      ],
      'svc-auth': [
        { path: '/api/auth/login', method: 'POST', weight: 40 },
        { path: '/api/auth/token/refresh', method: 'POST', weight: 25 },
        { path: '/api/auth/validate', method: 'GET', weight: 25 },
        { path: '/api/auth/logout', method: 'POST', weight: 10 },
      ],
      'svc-notification': [
        { path: '/api/notify/email', method: 'POST', weight: 35 },
        { path: '/api/notify/sms', method: 'POST', weight: 20 },
        { path: '/api/notify/push', method: 'POST', weight: 25 },
        { path: '/api/notify/status', method: 'GET', weight: 20 },
      ],
    };
  }

  /**
   * Pick a random endpoint weighted by traffic distribution
   */
  pickEndpoint(serviceId) {
    const eps = this.endpoints[serviceId] || this.endpoints['svc-api-gateway'];
    const totalWeight = eps.reduce((sum, ep) => sum + ep.weight, 0);
    let rand = Math.random() * totalWeight;
    for (const ep of eps) {
      rand -= ep.weight;
      if (rand <= 0) return ep;
    }
    return eps[0];
  }

  /**
   * Generate a single log event for a service
   */
  generateEvent(service) {
    const endpoint = this.pickEndpoint(service.id);
    const anomaly = this.activeAnomalies.get(service.id);

    let latency = service.baseline_latency_ms * (0.7 + Math.random() * 0.6); // ±30% jitter
    let statusCode = 200;
    let errorCode = null;

    // Apply anomaly modifiers if active
    if (anomaly) {
      const result = anomaly.modifier(latency, statusCode, endpoint, this.tick - anomaly.startTick);
      latency = result.latency;
      statusCode = result.statusCode;
      errorCode = result.errorCode;
    } else {
      // Normal error rate
      if (Math.random() < service.baseline_error_rate) {
        statusCode = Math.random() > 0.5 ? 500 : 503;
        errorCode = statusCode === 500 ? 'INTERNAL_SERVER_ERROR' : 'SERVICE_UNAVAILABLE';
      }
    }

    return {
      id: uuidv4(),
      service_id: service.id,
      timestamp: new Date().toISOString(),
      endpoint: endpoint.path,
      method: endpoint.method,
      latency_ms: Math.max(1, Math.round(latency * 100) / 100),
      status_code: statusCode,
      error_code: errorCode,
      request_volume: Math.floor(service.baseline_request_volume / 60 * (0.8 + Math.random() * 0.4)),
      metadata: JSON.stringify({
        region: 'us-east-1',
        pod: `${service.name}-${Math.floor(Math.random() * 4)}`,
      }),
    };
  }

  /**
   * Generate a batch of log events
   */
  generateBatch() {
    const events = [];
    for (const service of this.services) {
      // 3-6 events per service per tick
      const count = 3 + Math.floor(Math.random() * 4);
      for (let i = 0; i < count; i++) {
        events.push(this.generateEvent(service));
      }
    }
    return events;
  }

  /**
   * Inject an anomaly scenario
   */
  injectAnomaly(type) {
    const scenarios = {
      // Scenario 1: Slow-drip latency on payment-service (AUTO-RESOLVE)
      'latency-creep': {
        serviceId: 'svc-payment',
        name: 'Slow-Drip Latency Increase',
        description: 'Payment service latency gradually increasing — connection pool exhaustion pattern',
        duration: 30, // ticks (~60 seconds)
        modifier: (baseLatency, baseStatus, endpoint, elapsed) => {
          // Latency increases linearly over time
          const multiplier = 1 + (elapsed / 10) * 0.5; // Up to 2.5x over 30 ticks
          return {
            latency: baseLatency * multiplier,
            statusCode: baseStatus,
            errorCode: null,
          };
        },
      },

      // Scenario 2: Error clustering on auth-service /login (ESCALATE)
      'error-burst': {
        serviceId: 'svc-auth',
        name: 'Auth Login Error Clustering',
        description: 'Burst of 500 errors on auth-service /login endpoint — session store failure pattern',
        duration: 40, // ticks
        modifier: (baseLatency, baseStatus, endpoint, elapsed) => {
          if (endpoint.path === '/api/auth/login' || endpoint.path === '/api/auth/validate') {
            // 60% chance of 500 error on login/validate endpoints
            if (Math.random() < 0.6) {
              return {
                latency: baseLatency * 1.2,
                statusCode: 500,
                errorCode: 'REDIS_CONNECTION_REFUSED',
              };
            }
          }
          return {
            latency: baseLatency * 1.1,
            statusCode: baseStatus,
            errorCode: null,
          };
        },
      },

      // Scenario 3: Brief CPU spike on api-gateway (SUPPRESS)
      'transient-spike': {
        serviceId: 'svc-api-gateway',
        name: 'Transient CPU Spike',
        description: 'Brief latency spike on API gateway — pod rescheduling pattern',
        duration: 8, // short duration — only ~16 seconds
        modifier: (baseLatency, baseStatus, endpoint, elapsed) => {
          // Sharp spike that self-resolves
          const spikeFactor = elapsed < 4 ? 3.5 : 1 + (8 - elapsed) * 0.3;
          return {
            latency: baseLatency * Math.max(1, spikeFactor),
            statusCode: baseStatus,
            errorCode: null,
          };
        },
      },

      // Scenario 4: Brute Force Attack (SECURITY/LOCKDOWN)
      'brute-force': {
        serviceId: 'svc-auth',
        name: 'Brute Force Attack',
        description: 'Massive spike of 401 Unauthorized errors on /login endpoint — Credential stuffing pattern',
        duration: 20, // ticks
        modifier: (baseLatency, baseStatus, endpoint, elapsed) => {
          if (endpoint.path === '/api/auth/login') {
            // 90% chance of 401 error
            if (Math.random() < 0.9) {
              return {
                latency: baseLatency * 1.5,
                statusCode: 401,
                errorCode: 'UNAUTHORIZED_ACCESS',
              };
            }
          }
          return {
            latency: baseLatency * 1.1,
            statusCode: baseStatus,
            errorCode: null,
          };
        },
      },
    };

    const scenario = scenarios[type];
    if (!scenario) {
      console.error(`Unknown anomaly type: ${type}`);
      return null;
    }

    // Check if this service already has an active anomaly
    if (this.activeAnomalies.has(scenario.serviceId)) {
      console.log(`[simulator] Anomaly already active on ${scenario.serviceId}, skipping`);
      return null;
    }

    const anomalyConfig = {
      ...scenario,
      startTick: this.tick,
      type,
    };

    this.activeAnomalies.set(scenario.serviceId, anomalyConfig);

    console.log(`[simulator] Anomaly injected: ${scenario.name} on ${scenario.serviceId}`);
    this.emit('anomaly-injected', {
      type,
      serviceId: scenario.serviceId,
      name: scenario.name,
      description: scenario.description,
      startedAt: new Date().toISOString(),
    });

    return anomalyConfig;
  }

  /**
   * Start generating log events on interval
   */
  start(intervalMs = 2000) {
    console.log(`[simulator] Started (interval: ${intervalMs}ms)`);

    this.intervalId = setInterval(() => {
      this.tick++;

      // Check and expire finished anomalies
      for (const [serviceId, anomaly] of this.activeAnomalies.entries()) {
        if (this.tick - anomaly.startTick >= anomaly.duration) {
          this.activeAnomalies.delete(serviceId);
          console.log(`[simulator] Anomaly expired: ${anomaly.name} on ${serviceId}`);
        }
      }

      const batch = this.generateBatch();
      this.emit('log-batch', batch, this.tick);
    }, intervalMs);
  }

  /**
   * Stop the simulator
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log('[simulator] Stopped');
    }
  }
}
