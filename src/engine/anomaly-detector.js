/**
 * Anomaly Detector — Statistical anomaly detection using Z-score analysis
 * against per-service baselines. NOT a global threshold approach.
 */
export class AnomalyDetector {
  constructor() {
    // Rolling window of metrics per service (last N windows)
    this.history = new Map(); // service_id -> { latencies: [], errorRates: [], volumes: [] }
    this.windowSize = 15; // Number of historical windows to keep
    this.zScoreThreshold = 2.0; // Standard deviations for anomaly
  }

  /**
   * Compute metrics for a batch of log events for a single service
   */
  computeWindowMetrics(events) {
    if (events.length === 0) return null;

    const latencies = events.map(e => e.latency_ms);
    const errors = events.filter(e => e.status_code >= 500).length;
    const totalVolume = events.reduce((sum, e) => sum + e.request_volume, 0);

    return {
      avgLatency: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      p95Latency: this.percentile(latencies, 95),
      p99Latency: this.percentile(latencies, 99),
      maxLatency: Math.max(...latencies),
      errorRate: errors / events.length,
      errorCount: errors,
      totalRequests: events.length,
      requestVolume: totalVolume,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Calculate percentile of an array
   */
  percentile(arr, p) {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Calculate mean and standard deviation
   */
  stats(arr) {
    if (arr.length < 2) return { mean: arr[0] || 0, std: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / (arr.length - 1);
    return { mean, std: Math.sqrt(variance) };
  }

  /**
   * Calculate Z-score
   */
  zScore(value, mean, std) {
    if (std === 0) return value === mean ? 0 : Infinity;
    return (value - mean) / std;
  }

  /**
   * Analyze a batch of events for anomalies
   * Returns anomaly report or null if normal
   */
  analyze(serviceId, events, serviceBaseline) {
    const metrics = this.computeWindowMetrics(events);
    if (!metrics) return null;

    // Initialize history for this service
    if (!this.history.has(serviceId)) {
      this.history.set(serviceId, {
        latencies: [],
        errorRates: [],
        volumes: [],
      });
    }

    const history = this.history.get(serviceId);

    // Need at least 5 windows before we can detect anomalies
    if (history.latencies.length < 5) {
      history.latencies.push(metrics.avgLatency);
      history.errorRates.push(metrics.errorRate);
      history.volumes.push(metrics.requestVolume);
      return null;
    }

    // Compute Z-scores against rolling history
    const latencyStats = this.stats(history.latencies);
    const errorStats = this.stats(history.errorRates);
    const volumeStats = this.stats(history.volumes);

    const latencyZ = this.zScore(metrics.avgLatency, latencyStats.mean, latencyStats.std);
    const errorZ = this.zScore(metrics.errorRate, errorStats.mean, errorStats.std);
    const volumeZ = this.zScore(metrics.requestVolume, volumeStats.mean, volumeStats.std);

    // Also compare against static baseline from service config
    const latencyBaselineDeviation = (metrics.avgLatency - serviceBaseline.baseline_latency_ms) / serviceBaseline.baseline_latency_ms;
    const errorBaselineDeviation = metrics.errorRate - serviceBaseline.baseline_error_rate;

    // Store current metrics in rolling window
    history.latencies.push(metrics.avgLatency);
    history.errorRates.push(metrics.errorRate);
    history.volumes.push(metrics.requestVolume);

    // Trim history to window size
    if (history.latencies.length > this.windowSize) {
      history.latencies.shift();
      history.errorRates.shift();
      history.volumes.shift();
    }

    // Determine if anomalous
    const anomalies = [];

    if (Math.abs(latencyZ) > this.zScoreThreshold) {
      anomalies.push({
        metric: 'latency',
        value: metrics.avgLatency,
        zScore: latencyZ,
        historicalMean: latencyStats.mean,
        historicalStd: latencyStats.std,
        baselineValue: serviceBaseline.baseline_latency_ms,
        baselineDeviation: latencyBaselineDeviation,
        direction: latencyZ > 0 ? 'increasing' : 'decreasing',
        severity: Math.abs(latencyZ) > 3 ? 'critical' : 'warning',
      });
    }

    if (Math.abs(errorZ) > this.zScoreThreshold && metrics.errorRate > 0.05) {
      anomalies.push({
        metric: 'error_rate',
        value: metrics.errorRate,
        zScore: errorZ,
        historicalMean: errorStats.mean,
        historicalStd: errorStats.std,
        baselineValue: serviceBaseline.baseline_error_rate,
        baselineDeviation: errorBaselineDeviation,
        direction: errorZ > 0 ? 'increasing' : 'decreasing',
        severity: metrics.errorRate > 0.3 ? 'critical' : 'warning',
      });
    }

    if (Math.abs(volumeZ) > this.zScoreThreshold * 1.5) {
      anomalies.push({
        metric: 'request_volume',
        value: metrics.requestVolume,
        zScore: volumeZ,
        historicalMean: volumeStats.mean,
        historicalStd: volumeStats.std,
        baselineValue: serviceBaseline.baseline_request_volume,
        direction: volumeZ > 0 ? 'spike' : 'drop',
        severity: Math.abs(volumeZ) > 3 ? 'critical' : 'warning',
      });
    }

    if (anomalies.length === 0) return null;

    // Build anomaly report
    return {
      serviceId,
      serviceName: serviceBaseline.name,
      detectedAt: new Date().toISOString(),
      currentMetrics: metrics,
      anomalies,
      overallSeverity: anomalies.some(a => a.severity === 'critical') ? 'critical' : 'warning',
      // Trending info
      trend: {
        latencyTrend: this.computeTrend(history.latencies),
        errorTrend: this.computeTrend(history.errorRates),
      },
      // Error details for context
      errorDetails: this.extractErrorDetails(events),
    };
  }

  /**
   * Compute trend direction from recent history
   */
  computeTrend(values) {
    if (values.length < 3) return 'stable';
    const recent = values.slice(-3);
    const diffs = [];
    for (let i = 1; i < recent.length; i++) {
      diffs.push(recent[i] - recent[i - 1]);
    }
    const avgDiff = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    if (avgDiff > 0.1 * recent[0]) return 'increasing';
    if (avgDiff < -0.1 * recent[0]) return 'decreasing';
    return 'stable';
  }

  /**
   * Extract error details from events for context
   */
  extractErrorDetails(events) {
    const errors = events.filter(e => e.status_code >= 500);
    if (errors.length === 0) return null;

    const errorCodes = {};
    const affectedEndpoints = {};

    for (const err of errors) {
      const code = err.error_code || `HTTP_${err.status_code}`;
      errorCodes[code] = (errorCodes[code] || 0) + 1;
      affectedEndpoints[err.endpoint] = (affectedEndpoints[err.endpoint] || 0) + 1;
    }

    return {
      totalErrors: errors.length,
      errorCodes,
      affectedEndpoints,
      sampleErrors: errors.slice(0, 3).map(e => ({
        endpoint: e.endpoint,
        statusCode: e.status_code,
        errorCode: e.error_code,
        latency: e.latency_ms,
      })),
    };
  }

  /**
   * Reset history for a service (after incident resolution)
   */
  resetServiceHistory(serviceId) {
    this.history.delete(serviceId);
  }
}
