/**
 * frontend/src/pages/reconciliation/[jobId]/review.jsx
 *
 * Pages Router version — place exactly here:
 *   frontend/src/pages/reconciliation/[jobId]/review.jsx
 *
 * All logic identical to the App Router version.
 * Only difference: uses next/router instead of next/navigation,
 * and params come from router.query instead of props.params.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useRouter } from 'next/router';
import ProcurementCopilot from '../../components/copilot/ProcurementCopilot';

// ── Constants ──────────────────────────────────────────────────────────────────
const QUICK_OPTIONS = {
  no_po_match      : ['Approve for payment', 'Request PO number from vendor', 'Hold for review', 'Reject invoice'],
  amount_mismatch  : ['Approve invoice amount', 'Use PO amount', 'Hold for clarification', 'Reject invoice'],
  duplicate_invoice: ['Keep first occurrence only', 'Keep all (each is a separate transaction)', 'Hold all for manual review'],
};

const SEVERITY_COLOR = { High: '#dc2626', Medium: '#d97706', Low: '#2563eb' };

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ReviewApprovePage() {
  const router = useRouter();
  const { jobId } = router.query;   // Pages Router: params from router.query

  const [job, setJob]               = useState(null);
  const [loading, setLoading]       = useState(true);
  const [error, setError]           = useState(null);
  const [ambiguities, setAmbiguities] = useState([]);
  const [executing, setExecuting]   = useState(false);
  const [filter, setFilter]         = useState('all');

  // ── Load job ──────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!jobId) return;
    setLoading(true);
    fetch(`/api/procurement/jobs/${jobId}`, { credentials: 'include' })
      .then(r => {
        if (!r.ok) throw new Error(`Failed to load job (${r.status})`);
        return r.json();
      })
      .then(data => {
        setJob(data);
        const raw = data?.reconciliation?.ambiguities || [];
        setAmbiguities(raw.map(a => ({
          ...a,
          answered    : false,
          response    : null,
          respondedVia: null,
        })));
      })
      .catch(err => setError(err.message))
      .finally(() => setLoading(false));
  }, [jobId]);

  // ── Stats ─────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total    = ambiguities.length;
    const answered = ambiguities.filter(a => a.answered).length;
    const pending  = total - answered;
    const pct      = total > 0 ? Math.round((answered / total) * 100) : 0;
    return { total, answered, pending, pct };
  }, [ambiguities]);

  const allAnswered = stats.pending === 0 && stats.total > 0;

  // ── Single item approval ──────────────────────────────────────────────────
  const approveItem = useCallback(async (index, response, via = 'dashboard') => {
    // Optimistic update
    setAmbiguities(prev => prev.map((a, i) =>
      i === index ? { ...a, answered: true, response, respondedVia: via } : a
    ));
    try {
      const res = await fetch(`/api/procurement/jobs/${jobId}/approve/${index}`, {
        method     : 'POST',
        headers    : { 'Content-Type': 'application/json' },
        credentials: 'include',
        body       : JSON.stringify({ response, respondedVia: via }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.error('[ReviewPage] approveItem failed:', err.message);
      // Roll back
      setAmbiguities(prev => prev.map((a, i) =>
        i === index ? { ...a, answered: false, response: null } : a
      ));
    }
  }, [jobId]);

  // ── Copilot bulk apply ────────────────────────────────────────────────────
  const handleCopilotApply = useCallback(async (actions) => {
    if (!actions || actions.length === 0) return;

    // Optimistic bulk update
    setAmbiguities(prev => {
      const next = [...prev];
      for (const { index, response, respondedVia } of actions) {
        if (next[index] && !next[index].answered) {
          next[index] = { ...next[index], answered: true, response, respondedVia };
        }
      }
      return next;
    });

    // Fire API calls in parallel
    await Promise.allSettled(
      actions.map(({ index, response, respondedVia }) =>
        fetch(`/api/procurement/jobs/${jobId}/approve/${index}`, {
          method     : 'POST',
          headers    : { 'Content-Type': 'application/json' },
          credentials: 'include',
          body       : JSON.stringify({ response, respondedVia }),
        }).catch(err => {
          console.error(`[ReviewPage] bulk #${index + 1} failed:`, err.message);
          setAmbiguities(prev => prev.map((a, i) =>
            i === index ? { ...a, answered: false, response: null } : a
          ));
        })
      )
    );
  }, [jobId]);

  // ── Execute ───────────────────────────────────────────────────────────────
  const handleExecute = async () => {
    setExecuting(true);
    try {
      const res = await fetch(`/api/procurement/jobs/${jobId}/execute`, {
        method     : 'POST',
        credentials: 'include',
      });
      if (!res.ok) throw new Error(`Execute failed (${res.status})`);
      router.push(`/reconciliation/${jobId}/done`);
    } catch (err) {
      setError(err.message);
      setExecuting(false);
    }
  };

  // ── Filtered view ─────────────────────────────────────────────────────────
  const visible = useMemo(() => {
    const indexed = ambiguities.map((a, i) => ({ ...a, _origIdx: i }));
    if (filter === 'pending')  return indexed.filter(a => !a.answered);
    if (filter === 'answered') return indexed.filter(a =>  a.answered);
    return indexed;
  }, [ambiguities, filter]);

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <Shell><Spinner /></Shell>;
  if (error)   return <Shell><Err msg={error} /></Shell>;
  if (!job)    return <Shell><Err msg="Job not found" /></Shell>;

  const summary = job?.reconciliation?.summary || {};

  return (
    <Shell>
      <style>{STYLES}</style>

      {/* Step tabs */}
      <StepTabs current="review" />

      {/* Summary cards */}
      <div className="rp-summary-row">
        <Card label="Total Invoices" value={summary.total      || stats.total} color="#111"     />
        <Card label="Matched"        value={summary.matched    || 0}           color="#16a34a"  />
        <Card label="Flagged"        value={summary.flagged    || 0}           color="#d97706"  />
        <Card label="Duplicates"     value={summary.duplicates || 0}           color="#dc2626"  />
        <Card label="Need Approval"  value={stats.total}                       color="#d97706"  />
      </div>

      {/* Progress bar */}
      <div className="rp-progress-wrap">
        <div className="rp-progress-header">
          <span className="rp-progress-title">{stats.answered} of {stats.total} reviewed</span>
          <span className="rp-progress-pct">{stats.pct}%</span>
        </div>
        <div className="rp-progress-bar">
          <div className="rp-progress-fill" style={{ width: `${stats.pct}%` }} />
        </div>
        {allAnswered && <p className="rp-progress-done">All items reviewed — ready to execute.</p>}
      </div>

      {/* Section header + filter tabs */}
      <div className="rp-section-header">
        <h2 className="rp-section-title">
          {stats.pending > 0
            ? `${stats.pending} item${stats.pending !== 1 ? 's' : ''} require your approval`
            : 'All items reviewed'}
        </h2>
        <div className="rp-filter-tabs">
          {['all', 'pending', 'answered'].map(f => (
            <button
              key={f}
              className={`rp-filter-tab ${filter === f ? 'rp-filter-active' : ''}`}
              onClick={() => setFilter(f)}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {f === 'pending'  && <span className="rp-filter-badge">{stats.pending}</span>}
              {f === 'answered' && <span className="rp-filter-badge rp-badge-green">{stats.answered}</span>}
            </button>
          ))}
        </div>
      </div>

      {/* Approval cards */}
      <div className="rp-cards">
        {visible.length === 0 && (
          <div className="rp-empty-filter">No items in this view.</div>
        )}
        {visible.map((amb, di) => (
          <AmbiguityCard
            key={amb._origIdx}
            index={amb._origIdx}
            displayIndex={di + 1}
            ambiguity={amb}
            onApprove={response => approveItem(amb._origIdx, response, 'dashboard')}
          />
        ))}
      </div>

      {/* Execute */}
      <div className="rp-execute-wrap">
        <button
          className={`rp-execute-btn ${!allAnswered ? 'rp-execute-disabled' : ''}`}
          disabled={!allAnswered || executing}
          onClick={handleExecute}
        >
          {executing
            ? 'Generating output…'
            : `Execute & Download (${stats.answered} approved items)`}
        </button>
        {!allAnswered && (
          <p className="rp-execute-hint">
            {stats.pending} item{stats.pending !== 1 ? 's' : ''} still pending.
            Use the Copilot to review them quickly.
          </p>
        )}
      </div>

      {/* Floating Copilot */}
      <ProcurementCopilot
        ambiguities={ambiguities}
        jobId={jobId}
        onApply={handleCopilotApply}
      />
    </Shell>
  );
}

// ── AmbiguityCard ─────────────────────────────────────────────────────────────
function AmbiguityCard({ index, displayIndex, ambiguity, onApprove }) {
  const [custom, setCustom] = useState('');
  const options       = QUICK_OPTIONS[ambiguity.type] || QUICK_OPTIONS.no_po_match;
  const severityColor = SEVERITY_COLOR[ambiguity.severity] || '#6b7280';

  if (ambiguity.answered) {
    return (
      <div className="rp-card rp-card-answered">
        <div className="rp-card-num">{displayIndex}</div>
        <div className="rp-card-body">
          <p className="rp-card-question">{ambiguity.question}</p>
          <div className="rp-card-answered-row">
            <span className="rp-answered-badge">
              {ambiguity.respondedVia === 'voice'  && '🎙 '}
              {(ambiguity.respondedVia === 'copilot' || ambiguity.respondedVia === 'ai') && '⚡ '}
              answered
            </span>
            <span className="rp-answered-response">{ambiguity.response}</span>
            <span className="rp-answered-via">via {ambiguity.respondedVia || 'dashboard'}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="rp-card">
      <div className="rp-card-num">{displayIndex}</div>
      <div className="rp-card-body">
        <div className="rp-card-meta">
          <span className="rp-severity-dot" style={{ background: severityColor }} />
          <span className="rp-card-type">{ambiguity.type?.replace(/_/g, ' ')}</span>
        </div>
        <div className="rp-card-ai-bubble">
          <span className="rp-ai-label">AI</span>
          <p className="rp-card-question">{ambiguity.question}</p>
        </div>
        <div className="rp-quick-options">
          {options.map((opt, i) => (
            <button key={i} className="rp-opt-btn" onClick={() => onApprove(opt)}>{opt}</button>
          ))}
        </div>
        <div className="rp-custom-row">
          <input
            className="rp-custom-input"
            placeholder="Or type your decision…"
            value={custom}
            onChange={e => setCustom(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && custom.trim()) {
                onApprove(custom.trim());
                setCustom('');
              }
            }}
          />
          <button
            className="rp-approve-btn"
            disabled={!custom.trim()}
            onClick={() => { onApprove(custom.trim()); setCustom(''); }}
          >
            Approve
          </button>
          <button className="rp-reject-btn" onClick={() => onApprove('Reject invoice')}>
            Reject
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Step tabs ─────────────────────────────────────────────────────────────────
function StepTabs({ current }) {
  const steps    = ['Upload', 'Parse & Validate', 'Analyze', 'Review & Approve', 'Execute', 'Done'];
  const currIdx  = steps.findIndex(s => s.toLowerCase().includes(current));
  return (
    <div className="rp-step-tabs">
      {steps.map((s, i) => (
        <div key={s} className={`rp-step-tab ${i === currIdx ? 'rp-step-active' : ''} ${i < currIdx ? 'rp-step-done' : ''}`}>
          {s}
        </div>
      ))}
    </div>
  );
}

// ── Mini components ───────────────────────────────────────────────────────────
function Card({ label, value, color }) {
  return (
    <div className="rp-summary-card">
      <div className="rp-summary-value" style={{ color }}>{value}</div>
      <div className="rp-summary-label">{label}</div>
    </div>
  );
}
function Shell({ children }) { return <main className="rp-shell">{children}</main>; }
function Spinner() {
  return (
    <div className="rp-loading">
      <div className="rp-spinner" />
      <p>Loading reconciliation data…</p>
    </div>
  );
}
function Err({ msg }) { return <div className="rp-error">Error: {msg}</div>; }

// ── Styles ─────────────────────────────────────────────────────────────────────
const STYLES = `
  .rp-shell { max-width:900px; margin:0 auto; padding:24px 20px 120px; font-family:inherit; }

  .rp-step-tabs { display:flex; border-bottom:2px solid #e5e7eb; margin-bottom:28px; overflow-x:auto; }
  .rp-step-tab  { padding:10px 20px; font-size:13px; font-weight:500; color:#9ca3af; white-space:nowrap; border-bottom:2px solid transparent; margin-bottom:-2px; transition:color .15s; }
  .rp-step-done   { color:#16a34a; }
  .rp-step-active { color:#1a7a4a; border-bottom-color:#1a7a4a; font-weight:700; }

  .rp-summary-row  { display:flex; gap:16px; margin-bottom:24px; flex-wrap:wrap; }
  .rp-summary-card { flex:1; min-width:100px; background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:16px; text-align:center; box-shadow:0 1px 4px rgba(0,0,0,.04); }
  .rp-summary-value { font-size:28px; font-weight:800; line-height:1; margin-bottom:4px; }
  .rp-summary-label { font-size:11px; color:#9ca3af; font-weight:500; text-transform:uppercase; letter-spacing:.05em; }

  .rp-progress-wrap   { background:#fff; border:1px solid #e5e7eb; border-radius:12px; padding:18px 20px; margin-bottom:24px; }
  .rp-progress-header { display:flex; justify-content:space-between; align-items:baseline; margin-bottom:10px; }
  .rp-progress-title  { font-size:14px; font-weight:600; color:#374151; }
  .rp-progress-pct    { font-size:20px; font-weight:800; color:#1a7a4a; }
  .rp-progress-bar    { height:8px; background:#f3f4f6; border-radius:4px; overflow:hidden; }
  .rp-progress-fill   { height:100%; background:linear-gradient(90deg,#1a7a4a,#4ade80); border-radius:4px; transition:width .4s ease; }
  .rp-progress-done   { font-size:13px; color:#16a34a; font-weight:600; margin:10px 0 0; }

  .rp-section-header { display:flex; align-items:center; justify-content:space-between; margin-bottom:16px; flex-wrap:wrap; gap:10px; }
  .rp-section-title  { font-size:16px; font-weight:700; color:#111; margin:0; }
  .rp-filter-tabs    { display:flex; gap:4px; }
  .rp-filter-tab     { padding:5px 12px; font-size:12px; font-weight:600; border:1px solid #e5e7eb; border-radius:20px; cursor:pointer; background:#fff; color:#6b7280; font-family:inherit; display:flex; align-items:center; gap:5px; transition:all .15s; }
  .rp-filter-active  { background:#0d2b1a; color:#e8f5ee; border-color:#0d2b1a; }
  .rp-filter-badge   { background:#fef3c7; color:#92400e; font-size:10px; font-weight:800; padding:1px 6px; border-radius:10px; }
  .rp-badge-green    { background:#dcfce7; color:#166534; }

  .rp-cards        { display:flex; flex-direction:column; gap:14px; margin-bottom:32px; }
  .rp-empty-filter { text-align:center; color:#9ca3af; padding:40px; font-size:14px; }

  .rp-card { display:flex; gap:16px; align-items:flex-start; background:#fff; border:1px solid #e5e7eb; border-radius:14px; padding:18px 20px; box-shadow:0 1px 4px rgba(0,0,0,.04); transition:box-shadow .15s; }
  .rp-card:hover    { box-shadow:0 4px 16px rgba(0,0,0,.08); }
  .rp-card-answered { background:#f9fafb; opacity:.75; }

  .rp-card-num { width:28px; height:28px; border-radius:50%; background:#f3f4f6; color:#6b7280; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .rp-card-body { flex:1; }
  .rp-card-meta { display:flex; align-items:center; gap:6px; margin-bottom:8px; }
  .rp-severity-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .rp-card-type { font-size:11px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.06em; }

  .rp-card-ai-bubble { display:flex; gap:10px; align-items:flex-start; background:#f8fafb; border-radius:10px; padding:12px 14px; margin-bottom:12px; }
  .rp-ai-label { font-size:10px; font-weight:800; letter-spacing:.08em; background:#0d2b1a; color:#4ade80; padding:2px 6px; border-radius:5px; flex-shrink:0; margin-top:1px; }
  .rp-card-question { font-size:14px; color:#1a1a1a; line-height:1.5; margin:0; }

  .rp-quick-options { display:flex; flex-wrap:wrap; gap:7px; margin-bottom:12px; }
  .rp-opt-btn { padding:6px 14px; font-size:12.5px; font-weight:500; background:#f0f7f3; border:1px solid #c6e0d0; color:#1a5c38; border-radius:20px; cursor:pointer; font-family:inherit; transition:background .15s,transform .1s; }
  .rp-opt-btn:hover { background:#dcf0e6; transform:scale(1.02); }

  .rp-custom-row   { display:flex; gap:8px; align-items:center; }
  .rp-custom-input { flex:1; height:36px; padding:0 12px; border:1px solid #d1d5db; border-radius:8px; font-size:13px; font-family:inherit; color:#1a1a1a; outline:none; transition:border-color .15s; }
  .rp-custom-input:focus { border-color:#1a7a4a; box-shadow:0 0 0 2px rgba(26,122,74,.1); }
  .rp-approve-btn { padding:0 16px; height:36px; background:#1a7a4a; color:#fff; border:none; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; transition:background .15s; white-space:nowrap; }
  .rp-approve-btn:disabled { background:#d1d5db; cursor:not-allowed; }
  .rp-approve-btn:not(:disabled):hover { background:#156038; }
  .rp-reject-btn  { padding:0 14px; height:36px; background:#fef2f2; color:#dc2626; border:1px solid #fecaca; border-radius:8px; font-size:13px; font-weight:600; cursor:pointer; font-family:inherit; white-space:nowrap; }
  .rp-reject-btn:hover { background:#fee2e2; }

  .rp-card-answered-row { display:flex; align-items:center; gap:8px; flex-wrap:wrap; margin-top:6px; }
  .rp-answered-badge    { font-size:11px; font-weight:700; padding:2px 8px; background:#dcfce7; color:#166534; border-radius:10px; }
  .rp-answered-response { font-size:13px; color:#374151; font-weight:500; }
  .rp-answered-via      { font-size:11px; color:#9ca3af; }

  .rp-execute-wrap { text-align:center; padding:8px 0 40px; }
  .rp-execute-btn  { padding:14px 36px; font-size:15px; font-weight:700; background:#0d2b1a; color:#e8f5ee; border:none; border-radius:12px; cursor:pointer; font-family:inherit; letter-spacing:.02em; box-shadow:0 4px 16px rgba(13,43,26,.3); transition:background .2s,transform .15s; }
  .rp-execute-btn:not(.rp-execute-disabled):hover { background:#1a4a2e; transform:translateY(-1px); }
  .rp-execute-disabled { background:#d1d5db; color:#9ca3af; cursor:not-allowed; box-shadow:none; }
  .rp-execute-hint { font-size:13px; color:#9ca3af; margin:10px 0 0; }

  .rp-loading { display:flex; flex-direction:column; align-items:center; padding:80px; color:#6b7280; gap:16px; }
  .rp-spinner { width:36px; height:36px; border:3px solid #e5e7eb; border-top-color:#1a7a4a; border-radius:50%; animation:rp-spin .7s linear infinite; }
  @keyframes rp-spin { to { transform:rotate(360deg); } }
  .rp-error { padding:40px; text-align:center; color:#dc2626; font-size:14px; }
`;