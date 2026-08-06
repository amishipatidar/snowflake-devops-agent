/**
 * Reasoning Engine — The core differentiator.
 * Uses Groq LLM to perform structured chain-of-thought reasoning
 * over anomaly data + retrieved context.
 * 
 * Outputs a fully inspectable reasoning trace, not just a verdict.
 */
import Groq from 'groq-sdk';

export class ReasoningEngine {
  constructor(apiKey, model = 'llama-3.1-70b-versatile') {
    this.groq = new Groq({ apiKey });
    this.model = model;
  }

  /**
   * Build the system prompt for the reasoning engine
   */
  buildSystemPrompt() {
    return `You are IncidentIQ, an expert DevOps incident response reasoning engine. Your job is to analyze service anomalies, determine their root cause, and recommend the appropriate action.

You MUST respond with valid JSON only. No markdown, no code blocks, no explanation outside the JSON.

Your output MUST follow this exact JSON schema:
{
  "anomaly_summary": "One-sentence summary of what's happening",
  "baseline_comparison": "How current metrics compare to THIS service's historical baseline (not global thresholds)",
  "pattern_analysis": "What pattern the anomaly matches (e.g., gradual degradation, sudden spike, error clustering)",
  "similar_incident_assessment": "Analysis of how similar past incidents relate to this one",
  "root_cause_hypothesis": "Your best hypothesis for the root cause, with reasoning",
  "confidence": "HIGH or MEDIUM or LOW",
  "confidence_reasoning": "Why you're at this confidence level",
  "recommended_action": "AUTO_RESOLVE or ESCALATE or SUPPRESS",
  "action_reasoning": "Why this action is appropriate",
  "suggested_remediation": "Specific steps to take",
  "reasoning_steps": ["Step 1 of your reasoning", "Step 2", "Step 3", "..."],
  "risk_assessment": "What could go wrong if we take this action"
}

Decision criteria:
- AUTO_RESOLVE: High confidence match with a known issue that has a safe, proven fix. The past incident was successfully auto-resolved. A runbook exists and is marked auto-resolvable.
- ESCALATE: Genuine anomaly that needs human investigation. Either no confident match, or the past incident required manual/escalated resolution. High blast radius.
- SUPPRESS: The anomaly is within normal operational variance (e.g., deployment window, brief transient spike). No actual service impact. Past incidents show this is expected behavior.

CRITICAL RULES:
1. Always compare against SERVICE-SPECIFIC baselines, not arbitrary thresholds
2. A latency increase is only meaningful if it persists or is trending upward
3. Brief transient spikes (<2 min) during known maintenance patterns should be SUPPRESSED
4. Error clustering on specific endpoints suggests a targeted failure, not general service degradation
5. When in doubt, ESCALATE — false negatives are worse than false positives for critical services`;
  }

  /**
   * Build the user prompt with anomaly data and context
   */
  buildUserPrompt(anomalyReport, context) {
    const sections = [];

    // Current anomaly data
    sections.push('## CURRENT ANOMALY');
    sections.push(`Service: ${anomalyReport.serviceName}`);
    sections.push(`Detected at: ${anomalyReport.detectedAt}`);
    sections.push(`Overall severity: ${anomalyReport.overallSeverity}`);
    sections.push(`Latency trend: ${anomalyReport.trend.latencyTrend}`);
    sections.push(`Error trend: ${anomalyReport.trend.errorTrend}`);

    sections.push('\n### Anomalous Metrics:');
    for (const a of anomalyReport.anomalies) {
      sections.push(`- ${a.metric}: current=${a.value.toFixed(2)}, historical_mean=${a.historicalMean.toFixed(2)}, z_score=${a.zScore.toFixed(2)}, baseline=${a.baselineValue}, direction=${a.direction}, severity=${a.severity}`);
    }

    sections.push('\n### Current Metrics:');
    const m = anomalyReport.currentMetrics;
    sections.push(`- Avg latency: ${m.avgLatency.toFixed(1)}ms (P95: ${m.p95Latency.toFixed(1)}ms, P99: ${m.p99Latency.toFixed(1)}ms)`);
    sections.push(`- Error rate: ${(m.errorRate * 100).toFixed(1)}%`);
    sections.push(`- Request volume: ${m.requestVolume}`);

    // Error details
    if (anomalyReport.errorDetails) {
      sections.push('\n### Error Details:');
      sections.push(`- Total errors: ${anomalyReport.errorDetails.totalErrors}`);
      sections.push(`- Error codes: ${JSON.stringify(anomalyReport.errorDetails.errorCodes)}`);
      sections.push(`- Affected endpoints: ${JSON.stringify(anomalyReport.errorDetails.affectedEndpoints)}`);
    }

    // Similar past incidents
    sections.push('\n## SIMILAR PAST INCIDENTS');
    if (context.similarIncidents.length > 0) {
      for (const inc of context.similarIncidents) {
        sections.push(`\n### ${inc.title} (Similarity: ${(inc.similarity * 100).toFixed(0)}%)`);
        sections.push(`- Service: ${inc.serviceName}`);
        sections.push(`- Severity: ${inc.severity}`);
        sections.push(`- Symptom: ${inc.symptom}`);
        sections.push(`- Root cause: ${inc.rootCause}`);
        sections.push(`- Resolution: ${inc.resolution}`);
        sections.push(`- Resolution type: ${inc.resolutionType}`);
        sections.push(`- Duration: ${inc.durationMinutes} minutes`);
      }
    } else {
      sections.push('No similar past incidents found.');
    }

    // Relevant runbooks
    sections.push('\n## RELEVANT RUNBOOKS');
    if (context.relevantRunbooks.length > 0) {
      for (const rb of context.relevantRunbooks) {
        sections.push(`\n### ${rb.title} (${rb.category})`);
        sections.push(`- Service: ${rb.serviceName}`);
        sections.push(`- Auto-resolvable: ${rb.autoResolvable ? 'YES' : 'NO'}`);
        sections.push(`- Description: ${rb.content}`);
        sections.push(`- Steps: ${rb.steps.join(' → ')}`);
      }
    } else {
      sections.push('No relevant runbooks found.');
    }

    sections.push('\n## INSTRUCTION');
    sections.push('Analyze this anomaly using the context above. Output your reasoning trace as JSON following the schema from your system prompt.');

    return sections.join('\n');
  }

  /**
   * Run the reasoning engine on an anomaly with context
   */
  async reason(anomalyReport, context) {
    const startTime = Date.now();

    try {
      const systemPrompt = this.buildSystemPrompt();
      const userPrompt = this.buildUserPrompt(anomalyReport, context);

      const completion = await this.groq.chat.completions.create({
        model: this.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.1, // Low temperature for consistent reasoning
        max_tokens: 2000,
        response_format: { type: 'json_object' },
      });

      const responseText = completion.choices[0]?.message?.content;
      if (!responseText) {
        throw new Error('Empty response from Groq');
      }

      const reasoning = JSON.parse(responseText);
      reasoning._meta = {
        model: this.model,
        processingTimeMs: Date.now() - startTime,
        tokensUsed: completion.usage?.total_tokens || 0,
        timestamp: new Date().toISOString(),
      };

      reasoning._prompts = {
        system: systemPrompt,
        user: userPrompt
      };

      return reasoning;
    } catch (error) {
      console.error('Reasoning engine error:', error.message);

      // Return a fallback reasoning trace on error
      return this.fallbackReasoning(anomalyReport, context, error.message);
    }
  }

  /**
   * Fallback reasoning when LLM is unavailable
   * Uses heuristic rules instead of LLM
   */
  fallbackReasoning(anomalyReport, context, errorMsg) {
    const hasLatencyAnomaly = anomalyReport.anomalies.some(a => a.metric === 'latency');
    const hasErrorAnomaly = anomalyReport.anomalies.some(a => a.metric === 'error_rate');
    const isTransient = anomalyReport.trend.latencyTrend === 'stable' || anomalyReport.trend.latencyTrend === 'decreasing';
    const hasAutoResolvableMatch = context.isAutoResolvable;

    let action = 'ESCALATE';
    let confidence = 'MEDIUM';

    if (isTransient && !hasErrorAnomaly) {
      action = 'SUPPRESS';
      confidence = 'MEDIUM';
    } else if (hasAutoResolvableMatch && hasLatencyAnomaly && !hasErrorAnomaly) {
      action = 'AUTO_RESOLVE';
      confidence = 'HIGH';
    }

    return {
      anomaly_summary: `Anomaly detected on ${anomalyReport.serviceName}: ${anomalyReport.anomalies.map(a => `${a.metric} ${a.direction}`).join(', ')}`,
      baseline_comparison: `Metrics deviated from service baseline by ${anomalyReport.anomalies.map(a => `${a.metric}: z=${a.zScore.toFixed(1)}`).join(', ')}`,
      pattern_analysis: 'Heuristic analysis (LLM unavailable)',
      similar_incident_assessment: context.bestMatch ? `Best match: ${context.bestMatch.title} (${(context.bestMatch.similarity * 100).toFixed(0)}%)` : 'No close matches',
      root_cause_hypothesis: context.bestMatch?.rootCause || 'Unable to determine without LLM reasoning',
      confidence,
      confidence_reasoning: `Fallback heuristic reasoning used. LLM error: ${errorMsg}`,
      recommended_action: action,
      action_reasoning: 'Based on heuristic rules (transient pattern → suppress, known auto-resolve match → auto-resolve, otherwise → escalate)',
      suggested_remediation: context.relevantRunbooks.length > 0 ? context.relevantRunbooks[0].steps.join('; ') : 'Follow standard incident procedure',
      reasoning_steps: [
        'LLM unavailable — using heuristic fallback',
        `Checked anomaly type: ${hasLatencyAnomaly ? 'latency' : ''} ${hasErrorAnomaly ? 'errors' : ''}`,
        `Checked trend: ${anomalyReport.trend.latencyTrend}`,
        `Checked context match: ${hasAutoResolvableMatch ? 'auto-resolvable' : 'not auto-resolvable'}`,
        `Decision: ${action}`,
      ],
      risk_assessment: 'Heuristic reasoning has limited context — review recommended',
      _meta: {
        model: 'heuristic-fallback',
        processingTimeMs: 0,
        tokensUsed: 0,
        timestamp: new Date().toISOString(),
        fallbackReason: errorMsg,
      },
      _prompts: {
        system: this.buildSystemPrompt(),
        user: this.buildUserPrompt(anomalyReport, context)
      }
    };
  }
}
