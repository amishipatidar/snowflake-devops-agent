import { useState, useEffect, useRef } from 'react'
import './App.css'

// In production (when served from Express), use relative path. In dev, use localhost.
const API_BASE = import.meta.env.PROD ? '/api' : 'http://localhost:3001/api';

// ─── Hook: SSE Event Stream ──────────────────────────────
function useEventStream() {
  const [connected, setConnected] = useState(false);
  const [stats, setStats] = useState({ totalEvents: 0, anomaliesDetected: 0, autoResolved: 0, escalated: 0, suppressed: 0 });
  const [services, setServices] = useState([]);
  const [logEvents, setLogEvents] = useState([]);
  const [reasoningTraces, setReasoningTraces] = useState([]);
  const [actions, setActions] = useState([]);
  const [serviceSummary, setServiceSummary] = useState({});

  // Audio effects
  const playSound = (type) => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      if (type === 'beep') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(880, ctx.currentTime);
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.1);
        osc.start();
        osc.stop(ctx.currentTime + 0.1);
      } else if (type === 'chime') {
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(523.25, ctx.currentTime); // C5
        osc.frequency.setValueAtTime(659.25, ctx.currentTime + 0.1); // E5
        gain.gain.setValueAtTime(0.1, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      }
    } catch (e) { /* ignore audio errors */ }
  };

  useEffect(() => {
    const es = new EventSource(`${API_BASE}/events`);

    es.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      setConnected(true);
      setStats(data.stats);
      setServices(data.services);
    });

    es.addEventListener('log-batch', (e) => {
      const data = JSON.parse(e.data);
      setLogEvents(prev => [...prev.slice(-50), ...data.events]);
      const summaryMap = {};
      for (const s of data.summary) summaryMap[s.service_id] = s;
      setServiceSummary(prev => ({ ...prev, ...summaryMap }));
    });

    es.addEventListener('anomaly-detected', (e) => {
      playSound('beep');
      setReasoningTraces(prev => prev);
    });

    es.addEventListener('reasoning-complete', (e) => {
      const data = JSON.parse(e.data);
      setReasoningTraces(prev => [data, ...prev].slice(0, 20));
    });

    es.addEventListener('action-taken', (e) => {
      const data = JSON.parse(e.data);
      if (data.action === 'AUTO_RESOLVE') playSound('chime');
      setActions(prev => [data, ...prev].slice(0, 30));
    });

    es.addEventListener('stats-update', (e) => {
      setStats(JSON.parse(e.data));
    });

    es.onerror = () => setConnected(false);
    return () => es.close();
  }, []);

  return { connected, stats, services, logEvents, reasoningTraces, actions, serviceSummary };
}

// ─── Component: Stat Card ────────────────────────────────
function StatCard({ label, value, icon, variant }) {
  return (
    <div className={`stat-card stat-card--${variant}`}>
      <div className="stat-card__icon">{icon}</div>
      <div className="stat-card__data">
        <span className="stat-card__value">{typeof value === 'number' ? value.toLocaleString() : value}</span>
        <span className="stat-card__label">{label}</span>
      </div>
    </div>
  );
}

// ─── Component: Service Health ───────────────────────────
function ServiceHealth({ services, serviceSummary }) {
  const getStatus = (svc) => {
    const s = serviceSummary[svc.id];
    if (!s) return 'healthy';
    const errRate = s.errors / Math.max(s.count, 1);
    const latRatio = s.avgLatency / svc.baseline_latency_ms;
    if (errRate > 0.3 || latRatio > 3) return 'critical';
    if (errRate > 0.1 || latRatio > 1.5) return 'degraded';
    return 'healthy';
  };

  const statusLabel = { healthy: 'Operational', degraded: 'Degraded', critical: 'Critical' };

  return (
    <section className="panel service-panel">
      <h2 className="panel__title">Services</h2>
      <div className="service-list">
        {services.map(svc => {
          const status = getStatus(svc);
          const s = serviceSummary[svc.id];
          const latency = s ? s.avgLatency.toFixed(0) : svc.baseline_latency_ms;
          const errRate = s ? ((s.errors / Math.max(s.count, 1)) * 100).toFixed(1) : (svc.baseline_error_rate * 100).toFixed(1);
          return (
            <div key={svc.id} className={`service-row service-row--${status}`}>
              <div className="service-row__status">
                <span className={`dot dot--${status}`} />
              </div>
              <div className="service-row__name">
                <span className="service-row__display-name">{svc.display_name}</span>
                <span className="service-row__team">{svc.owner_team}</span>
              </div>
              <div className="service-row__metrics">
                <span className="service-row__metric">{latency}<small>ms</small></span>
                <span className="service-row__divider">|</span>
                <span className="service-row__metric">{errRate}<small>%</small></span>
              </div>
              <span className={`service-row__badge badge--${status}`}>{statusLabel[status]}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

// ─── Component: Log Feed ─────────────────────────────────
function LogFeed({ logEvents }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logEvents]);

  return (
    <section className="panel log-panel">
      <h2 className="panel__title">Live Feed</h2>
      <div className="log-feed" ref={ref}>
        {logEvents.length === 0 ? (
          <div className="log-feed__empty">
            <span className="log-feed__empty-dot" />
            Listening for events…
          </div>
        ) : (
          logEvents.slice(-25).map((ev, i) => {
            const isErr = ev.status_code >= 500;
            return (
              <div key={ev.id || i} className={`log-row ${isErr ? 'log-row--error' : ''}`}>
                <span className="log-row__time">{new Date(ev.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
                <span className={`log-row__code log-row__code--${isErr ? 'err' : ev.status_code >= 400 ? 'warn' : 'ok'}`}>{ev.status_code}</span>
                <span className="log-row__method">{ev.method}</span>
                <span className="log-row__path">{ev.endpoint}</span>
                <span className="log-row__latency">{ev.latency_ms.toFixed(0)}ms</span>
                {ev.error_code && <span className="log-row__error-tag">{ev.error_code}</span>}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

// ─── Component: Reasoning Inspector ──────────────────────
function ReasoningInspector({ reasoningTraces }) {
  const [selected, setSelected] = useState(null);
  const [showPrompt, setShowPrompt] = useState(false);

  if (reasoningTraces.length === 0) {
    return (
      <section className="panel reasoning-panel">
        <h2 className="panel__title">Reasoning</h2>
        <div className="reasoning-empty">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="reasoning-empty__icon">
            <circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>
          </svg>
          <p>Waiting for anomalies.</p>
          <span>Use the control panel to inject a scenario.</span>
        </div>
      </section>
    );
  }

  const active = selected !== null ? reasoningTraces[selected] : reasoningTraces[0];
  const r = active?.reasoning;

  const actionColors = { 'AUTO_RESOLVE': 'green', 'ESCALATE': 'red', 'SUPPRESS': 'neutral' };
  const actionIcons = { 'AUTO_RESOLVE': 'Auto-Resolved', 'ESCALATE': 'Escalated', 'SUPPRESS': 'Suppressed' };

  return (
    <section className="panel reasoning-panel">
      <h2 className="panel__title">Reasoning</h2>

      {/* Trace selector tabs */}
      <div className="reasoning-tabs">
        {reasoningTraces.slice(0, 8).map((t, i) => (
          <button
            key={i}
            className={`reasoning-tab ${(selected === null ? 0 : selected) === i ? 'reasoning-tab--active' : ''} reasoning-tab--${actionColors[t.reasoning?.recommended_action] || 'neutral'}`}
            onClick={() => setSelected(i)}
            title={t.reasoning?.anomaly_summary}
          >
            <span className={`dot dot--${actionColors[t.reasoning?.recommended_action] || 'neutral'}`} />
            <span className="reasoning-tab__label">{t.reasoning?.recommended_action?.replace('_', ' ') || '?'}</span>
          </button>
        ))}
      </div>

      {/* Active trace detail */}
      {r && (
        <div className="reasoning-detail">
          <div className="reasoning-detail__header">
            <span className={`reasoning-badge reasoning-badge--${actionColors[r.recommended_action]}`}>
              {actionIcons[r.recommended_action]}
            </span>
            <span className={`confidence-tag confidence-tag--${r.confidence?.toLowerCase()}`}>
              {r.confidence} confidence
            </span>
            {r._prompts && (
              <button 
                className={`prompt-toggle ${showPrompt ? 'prompt-toggle--active' : ''}`}
                onClick={() => setShowPrompt(!showPrompt)}
              >
                {showPrompt ? 'Hide Prompt' : 'View Raw Prompt'}
              </button>
            )}
          </div>
          <p className="reasoning-detail__summary">{r.anomaly_summary}</p>

          <div className="reasoning-sections">
            <ReasoningSection title="Root Cause" content={r.root_cause_hypothesis} />
            <ReasoningSection title="Pattern" content={r.pattern_analysis} />
            <ReasoningSection title="Baseline" content={r.baseline_comparison} />
            <ReasoningSection title="Similar Incidents" content={r.similar_incident_assessment} />
            <ReasoningSection title="Remediation" content={r.suggested_remediation} />
            <ReasoningSection title="Risk" content={r.risk_assessment} />
          </div>

          {r.reasoning_steps && (
            <div className="reasoning-chain">
              <h4 className="reasoning-chain__title">Reasoning Chain</h4>
              <ol>
                {r.reasoning_steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </div>
          )}

          {r._meta && (
            <div className="reasoning-meta">
              {r._meta.model} · {r._meta.processingTimeMs}ms · {r._meta.tokensUsed} tokens
            </div>
          )}

          {showPrompt && r._prompts && (
            <div className="reasoning-prompt-view">
              <h4>System Prompt</h4>
              <pre>{r._prompts.system}</pre>
              <h4>User Prompt</h4>
              <pre>{r._prompts.user}</pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function ReasoningSection({ title, content }) {
  if (!content) return null;
  return (
    <div className="reasoning-section">
      <h4>{title}</h4>
      <p>{content}</p>
    </div>
  );
}

// ─── Component: Action Feed ──────────────────────────────
function ActionFeed({ actions }) {
  const actionColors = { 'AUTO_RESOLVE': 'green', 'ESCALATE': 'red', 'SUPPRESS': 'neutral' };
  const actionIcons = { 'AUTO_RESOLVE': '✓', 'ESCALATE': '!', 'SUPPRESS': '—' };

  return (
    <section className="panel action-panel">
      <h2 className="panel__title">Actions</h2>
      {actions.length === 0 ? (
        <div className="action-empty">No actions recorded yet</div>
      ) : (
        <div className="action-list">
          {actions.map((a, i) => (
            <div key={i} className={`action-item action-item--${actionColors[a.action]}`}>
              <div className={`action-item__icon action-item__icon--${actionColors[a.action]}`}>
                {actionIcons[a.action]}
              </div>
              <div className="action-item__body">
                <div className="action-item__top">
                  <span className="action-item__service">{a.serviceName}</span>
                  <span className="action-item__time">{new Date(a.timestamp).toLocaleTimeString('en-US', { hour12: false })}</span>
                </div>
                <p className="action-item__desc">{a.reasoning?.anomaly_summary}</p>
                {a.cocoResponse && (
                  <details className="action-item__coco">
                    <summary>CoCo Response</summary>
                    <pre>{a.cocoResponse}</pre>
                  </details>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Component: Control Panel ────────────────────────────
function ControlPanel() {
  const [loading, setLoading] = useState(null);
  const [msg, setMsg] = useState('');

  const inject = async (type) => {
    setLoading(type);
    setMsg('');
    try {
      const res = await fetch(`${API_BASE}/simulate/anomaly`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      const data = await res.json();
      setMsg(data.success ? `Injected: ${data.anomaly}` : data.message);
    } catch (e) {
      setMsg(`Error: ${e.message}`);
    }
    setLoading(null);
    setTimeout(() => setMsg(''), 4000);
  };

  const scenarios = [
    { type: 'latency-creep', label: 'Latency Creep', sub: 'Payment Service', expected: 'Auto-Resolve', color: 'green' },
    { type: 'error-burst', label: 'Error Burst', sub: 'Auth Service', expected: 'Escalate', color: 'red' },
    { type: 'transient-spike', label: 'Transient Spike', sub: 'API Gateway', expected: 'Suppress', color: 'neutral' },
    { type: 'brute-force', label: 'Brute Force', sub: 'Auth Service', expected: 'Lockdown', color: 'orange' },
  ];

  const resetSandbox = async () => {
    if (!window.confirm('Clear all incidents and reset the sandbox?')) return;
    try {
      await fetch(`${API_BASE}/reset`, { method: 'POST' });
      setMsg('Sandbox reset');
      setTimeout(() => setMsg(''), 2000);
    } catch (e) {
      setMsg('Reset failed');
    }
  };

  return (
    <section className="panel control-panel">
      <div className="panel__header-row">
        <h2 className="panel__title">Inject Scenario</h2>
        <button className="reset-btn" onClick={resetSandbox}>Reset Sandbox</button>
      </div>
      <div className="control-buttons">
        {scenarios.map(s => (
          <button
            key={s.type}
            className={`control-btn control-btn--${s.color} ${loading === s.type ? 'control-btn--loading' : ''}`}
            onClick={() => inject(s.type)}
            disabled={loading !== null}
          >
            <span className="control-btn__label">{s.label}</span>
            <span className="control-btn__sub">{s.sub}</span>
            <span className={`control-btn__expected control-btn__expected--${s.color}`}>→ {s.expected}</span>
          </button>
        ))}
      </div>
      {msg && <div className="control-msg">{msg}</div>}
    </section>
  );
}

// ─── Main App ─────────────────────────────────────────────
function App() {
  const { connected, stats, services, logEvents, reasoningTraces, actions, serviceSummary } = useEventStream();

  return (
    <div className="app">
      {/* Top Bar */}
      <header className="topbar">
        <div className="topbar__brand">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="url(#grad)" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <defs><linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stopColor="#818cf8"/><stop offset="100%" stopColor="#22d3ee"/></linearGradient></defs>
            <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
          </svg>
          <span className="topbar__name">Vigil</span>
          <span className={`topbar__status ${connected ? 'topbar__status--on' : 'topbar__status--off'}`}>
            <span className="topbar__status-dot" />
            {connected ? 'Connected' : 'Offline'}
          </span>
        </div>
        <nav className="topbar__nav">
          <span className="topbar__tag">Snowflake CoCo CLI</span>
          <span className="topbar__tag">Groq LLM</span>
        </nav>
      </header>

      {/* Stats Row */}
      <div className="stats-row">
        <StatCard label="Events Processed" value={stats.totalEvents} icon="◉" variant="blue" />
        <StatCard label="Anomalies Found" value={stats.anomaliesDetected} icon="△" variant="orange" />
        <StatCard label="Auto-Resolved" value={stats.autoResolved} icon="✓" variant="green" />
        <StatCard label="Escalated" value={stats.escalated} icon="↑" variant="red" />
        <StatCard label="Suppressed" value={stats.suppressed} icon="—" variant="neutral" />
      </div>

      {/* Main Grid */}
      <div className="grid">
        {/* Left Column */}
        <div className="grid__left">
          <ServiceHealth services={services} serviceSummary={serviceSummary} />
          <LogFeed logEvents={logEvents} />
          <ControlPanel />
        </div>

        {/* Right Column */}
        <div className="grid__right">
          <ReasoningInspector reasoningTraces={reasoningTraces} />
          <ActionFeed actions={actions} />
        </div>
      </div>
    </div>
  );
}

export default App;
