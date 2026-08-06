/**
 * Context Retriever — TF-IDF based similarity search for past incidents and runbooks.
 * Uses the 'natural' library for text processing — no external embedding API needed.
 */
import natural from 'natural';
import { queryAll } from '../db/database.js';

const TfIdf = natural.TfIdf;
const tokenizer = new natural.WordTokenizer();

export class ContextRetriever {
  constructor() {
    this.incidentIndex = new TfIdf();
    this.runbookIndex = new TfIdf();
    this.incidents = [];
    this.runbooks = [];
    this.initialized = false;
  }

  /**
   * Build the TF-IDF indices from database content
   */
  initialize() {
    // Load past incidents
    this.incidents = queryAll(`
      SELECT pi.*, s.name as service_name, s.display_name as service_display_name
      FROM past_incidents pi
      JOIN services s ON pi.service_id = s.id
    `);

    // Build incident index — combine relevant text fields
    for (const incident of this.incidents) {
      const doc = [
        incident.title,
        incident.symptom,
        incident.root_cause,
        incident.resolution,
        incident.service_name,
        incident.severity,
      ].join(' ');
      this.incidentIndex.addDocument(doc);
    }

    // Load runbooks
    this.runbooks = queryAll(`
      SELECT r.*, s.name as service_name
      FROM runbooks r
      LEFT JOIN services s ON r.service_id = s.id
    `);

    // Build runbook index
    for (const runbook of this.runbooks) {
      const doc = [
        runbook.title,
        runbook.content,
        runbook.category,
        runbook.service_name || 'all-services',
      ].join(' ');
      this.runbookIndex.addDocument(doc);
    }

    this.initialized = true;
    console.log(`📚 Context Retriever initialized: ${this.incidents.length} incidents, ${this.runbooks.length} runbooks indexed`);
  }

  /**
   * Convert anomaly report to a search query
   */
  anomalyToQuery(anomalyReport) {
    const parts = [
      anomalyReport.serviceName,
    ];

    for (const anomaly of anomalyReport.anomalies) {
      parts.push(anomaly.metric);
      parts.push(anomaly.direction);
      parts.push(anomaly.severity);
    }

    if (anomalyReport.errorDetails) {
      for (const code of Object.keys(anomalyReport.errorDetails.errorCodes)) {
        parts.push(code);
      }
      for (const endpoint of Object.keys(anomalyReport.errorDetails.affectedEndpoints)) {
        parts.push(endpoint);
      }
    }

    // Add trend context
    if (anomalyReport.trend.latencyTrend === 'increasing') {
      parts.push('latency increase gradual degradation');
    }
    if (anomalyReport.trend.errorTrend === 'increasing') {
      parts.push('error burst spike failure');
    }

    return parts.join(' ');
  }

  /**
   * Find similar past incidents
   */
  findSimilarIncidents(anomalyReport, topK = 3) {
    if (!this.initialized) this.initialize();

    const query = this.anomalyToQuery(anomalyReport);
    const scores = [];

    this.incidentIndex.tfidfs(query, (docIndex, score) => {
      scores.push({
        index: docIndex,
        score: score,
        incident: this.incidents[docIndex],
      });
    });

    // Sort by score descending and take top K
    scores.sort((a, b) => b.score - a.score);
    const topResults = scores.slice(0, topK);

    // Calculate normalized similarity (0-1 scale)
    const maxScore = topResults.length > 0 ? topResults[0].score : 1;

    return topResults.map(r => ({
      incidentId: r.incident.id,
      title: r.incident.title,
      similarity: maxScore > 0 ? Math.min(1, r.score / maxScore) : 0,
      rawScore: r.score,
      severity: r.incident.severity,
      symptom: r.incident.symptom,
      rootCause: r.incident.root_cause,
      resolution: r.incident.resolution,
      resolutionType: r.incident.resolution_type,
      serviceName: r.incident.service_name,
      durationMinutes: r.incident.duration_minutes,
    }));
  }

  /**
   * Find relevant runbooks
   */
  findRelevantRunbooks(anomalyReport, topK = 2) {
    if (!this.initialized) this.initialize();

    const query = this.anomalyToQuery(anomalyReport);
    const scores = [];

    this.runbookIndex.tfidfs(query, (docIndex, score) => {
      scores.push({
        index: docIndex,
        score: score,
        runbook: this.runbooks[docIndex],
      });
    });

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);

    // Boost runbooks that match the service
    const boostedScores = scores.map(r => {
      let boost = 1;
      if (r.runbook.service_id === anomalyReport.serviceId) boost = 1.5;
      if (!r.runbook.service_id) boost = 0.8; // General runbooks get slight penalty
      return { ...r, score: r.score * boost };
    });

    boostedScores.sort((a, b) => b.score - a.score);
    const topResults = boostedScores.slice(0, topK);

    return topResults.map(r => ({
      runbookId: r.runbook.id,
      title: r.runbook.title,
      category: r.runbook.category,
      content: r.runbook.content,
      steps: JSON.parse(r.runbook.steps),
      autoResolvable: r.runbook.auto_resolvable === 1,
      serviceName: r.runbook.service_name || 'all services',
      score: r.score,
    }));
  }

  /**
   * Get full context for an anomaly (incidents + runbooks)
   */
  getContext(anomalyReport) {
    const similarIncidents = this.findSimilarIncidents(anomalyReport);
    const relevantRunbooks = this.findRelevantRunbooks(anomalyReport);

    return {
      similarIncidents,
      relevantRunbooks,
      hasHighConfidenceMatch: similarIncidents.length > 0 && similarIncidents[0].similarity > 0.7,
      bestMatch: similarIncidents.length > 0 ? similarIncidents[0] : null,
      isAutoResolvable: relevantRunbooks.some(rb => rb.autoResolvable) &&
        similarIncidents.some(inc => inc.resolutionType === 'auto-resolve' && inc.similarity > 0.5),
    };
  }
}
