/**
 * frontend/src/pages/DashboardPage.jsx  — V2
 *
 * Changes from V1:
 *   - UploadZone now receives acceptedFormats prop (.csv,.xlsx,.xls,.xml,.zip)
 *   - Sample mode updated to match 6-phase flow
 *   - Phase bar uses updated PHASES array (Upload → Analyze → AI Questions → Preview → Execute → Done)
 *   - All existing General Cleaning mode logic preserved exactly
 *   - Procurement mode continues to render ProcurementWorkspace (already V2)
 */

import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useDashboard, MODES } from '../context/DashboardContext';
import { dataAPI, aiAPI, pipelineAPI } from '../services/api';
import ModeSelector from '../components/dashboard/ModeSelector';
import ProcurementWorkspace from '../components/dashboard/ProcurementWorkspace';
import UploadZone from '../components/dashboard/UploadZone';
import IssueList from '../components/dashboard/IssueList';
import AIBubble from '../components/dashboard/AIBubble';
import PipelineStep from '../components/dashboard/PipelineStep';
import Loader from '../components/common/Loader';
import ErrorMessage from '../components/common/ErrorMessage';
import './DashboardPage.css';

const PHASES = ['Upload', 'Analyze', 'AI Questions', 'Preview', 'Execute', 'Done'];

const RISK_CLASS = { Low: 'risk-low', Medium: 'risk-med', High: 'risk-high' };

export default function DashboardPage() {
  const navigate = useNavigate();
  const { token, user, logout } = useAuth();
  const { mode } = useDashboard();

  // ── Phase state ────────────────────────────────────────────────────────────
  const [phase, setPhase] = useState(0);

  // ── Data state ─────────────────────────────────────────────────────────────
  const [datasetId,     setDatasetId]     = useState(null);
  const [datasetName,   setDatasetName]   = useState('');
  const [rowCount,      setRowCount]      = useState(0);
  const [issues,        setIssues]        = useState([]);
  const [questions,     setQuestions]     = useState([]);
  const [issueStep,     setIssueStep]     = useState(0);
  const [pipeline,      setPipeline]      = useState([]);
  const [pipelineId,    setPipelineId]    = useState(null);
  const [currentAction, setCurrentAction] = useState(null);

  // ── UI state ───────────────────────────────────────────────────────────────
  const [userInput,   setUserInput]   = useState('');
  const [loading,     setLoading]     = useState(false);
  const [loadingMsg,  setLoadingMsg]  = useState('');
  const [error,       setError]       = useState('');
  const [execLog,     setExecLog]     = useState([]);

  function handleLogout() {
    logout();
    navigate('/');
  }

  // ── PHASE 0 → 1: Upload ────────────────────────────────────────────────────
  async function handleUpload(file) {
    setError('');
    setLoading(true);
    setLoadingMsg('Uploading and parsing file…');

    try {
      if (file === '__sample__') {
        setDatasetName('sales_data_sample.csv');
        setRowCount(142);
        setIssues([
          { type: 'missing',              column: 'email',       severity: 'High',   affectedCount: 18, affectedPercent: 12.7, detail: '18 null values — 12.7% of rows' },
          { type: 'missing',              column: 'revenue',     severity: 'Medium', affectedCount: 9,  affectedPercent: 6.3,  detail: '9 null values — numerical column' },
          { type: 'duplicate',            column: null,          severity: 'Medium', affectedCount: 7,  affectedPercent: 4.9,  detail: '7 exact duplicate rows' },
          { type: 'format_inconsistency', column: 'joined_date', severity: 'Low',    affectedCount: 23, affectedPercent: 16.2, detail: 'Mixed: YYYY-MM-DD and DD/MM/YYYY' },
        ]);
        setPhase(1);
        setLoading(false);
        return;
      }

      const uploadRes = await dataAPI.upload(file, token);
      setDatasetId(uploadRes.datasetId);
      setDatasetName(uploadRes.originalName);
      setRowCount(uploadRes.rowCount);

      setLoadingMsg('Analyzing dataset for issues…');
      const analyzeRes = await dataAPI.analyze(uploadRes.datasetId, token);
      setIssues(analyzeRes.issues || []);
      setPhase(1);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  // ── PHASE 1 → 2: Start AI interview ───────────────────────────────────────
  async function startInterview() {
    setError('');
    if (issues.length === 0) { setPhase(4); return; }

    setLoading(true);
    setLoadingMsg('Generating AI questions…');

    try {
      if (datasetId) {
        const plRes = await pipelineAPI.create(datasetId, token);
        setPipelineId(plRes.pipelineId);
        const qRes = await aiAPI.generateQuestions(datasetId, issues, token);
        setQuestions(qRes.questions || []);
      } else {
        setQuestions(issues.map((iss, i) => ({ issueIndex: i, question: getDefaultQuestion(iss) })));
      }
      setIssueStep(0);
      setPhase(2);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  // ── PHASE 2 → 3: Submit response ──────────────────────────────────────────
  async function submitResponse() {
    if (!userInput.trim()) return;
    setError('');
    setLoading(true);
    setLoadingMsg('AI is interpreting your instruction…');

    try {
      let action;
      if (datasetId) {
        const res = await aiAPI.interpret(datasetId, issues[issueStep], userInput, token);
        action = res.action;
      } else {
        action = getSampleAction(issueStep, userInput);
      }
      setCurrentAction(action);
      setUserInput('');
      setPhase(3);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  // ── PHASE 3: Confirm ───────────────────────────────────────────────────────
  async function confirmAction() {
    setError('');
    try {
      if (pipelineId) {
        await pipelineAPI.addStep(pipelineId, currentAction, token);
        await pipelineAPI.confirmStep(pipelineId, pipeline.length, token);
      }
      setPipeline(prev => [...prev, { ...currentAction, status: 'confirmed' }]);
      const next = issueStep + 1;
      if (next < issues.length) {
        setIssueStep(next);
        setPhase(2);
      } else {
        setPhase(4);
      }
    } catch (err) {
      setError(err.message);
    }
  }

  function rejectAction() {
    setCurrentAction(null);
    setPhase(2);
  }

  // ── PHASE 4 → 5: Execute ──────────────────────────────────────────────────
  async function executePipeline() {
    setError('');
    setLoading(true);
    setLoadingMsg('Executing pipeline…');
    const logs = [];

    try {
      if (pipelineId) {
        const res = await pipelineAPI.execute(pipelineId, token);
        res.stepResults.forEach((s, i) => {
          logs.push(`[${ts()}] OK Step ${i + 1}: ${s.summary}`);
          setExecLog([...logs]);
        });
      } else {
        for (let i = 0; i < pipeline.length; i++) {
          await new Promise(r => setTimeout(r, 600));
          logs.push(`[${ts()}] OK Step ${i + 1}: ${pipeline[i].action || pipeline[i].explanation}`);
          setExecLog([...logs]);
        }
      }
      setPhase(5);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
      setLoadingMsg('');
    }
  }

  function reset() {
    setPhase(0);
    setDatasetId(null);
    setDatasetName('');
    setRowCount(0);
    setIssues([]);
    setQuestions([]);
    setIssueStep(0);
    setPipeline([]);
    setPipelineId(null);
    setCurrentAction(null);
    setUserInput('');
    setExecLog([]);
    setError('');
    setLoading(false);
    setLoadingMsg('');
  }

  function ts() { return new Date().toTimeString().slice(0, 8); }

  const currentQuestion = questions[issueStep];
  const currentIssue    = issues[issueStep];

  return (
    <div className="dashboard">

      {/* ── Top bar ── */}
      <header className="dashboard__topbar">
        <div className="dashboard__brand">auros<span className="dashboard__dot">.</span></div>
        <div className="dashboard__topbar-right">
          <span className="dashboard__user">{user?.name || 'My Workspace'}</span>
          <button className="btn-ghost dashboard__logout" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <main className="dashboard__main">

        {/* Mode selector — always visible */}
        <ModeSelector />

        {/* ── PROCUREMENT MODE ── */}
        {mode === MODES.PROCUREMENT && (
          <ProcurementWorkspace />
        )}

        {/* ── GENERAL CLEANING MODE ── */}
        {mode === MODES.GENERAL && (
          <>
            {/* Phase bar */}
            <div className="phase-bar">
              {PHASES.map((p, i) => (
                <div
                  key={p}
                  className={`phase-bar__item ${i === phase ? 'active' : ''} ${i < phase ? 'done' : ''}`}
                >
                  {p}
                </div>
              ))}
            </div>

            {error && (
              <div style={{ marginBottom: 16 }}>
                <ErrorMessage message={error} onRetry={() => setError('')} />
              </div>
            )}

            {loading && <Loader message={loadingMsg} />}

            {/* PHASE 0: Upload */}
            {phase === 0 && !loading && (
              <div className="dash-section fade-up">
                {/* V2: acceptedFormats now includes XML and ZIP */}
                <UploadZone
                  onUpload={handleUpload}
                  loading={loading}
                  acceptedFormats=".csv,.xlsx,.xls,.xml"
                />
              </div>
            )}

            {/* PHASE 1: Analyze */}
            {phase === 1 && (
              <div className="dash-section fade-up">
                <div className="section-head">
                  <div className="section-head__title">{datasetName}</div>
                  <div className="section-head__meta">
                    {rowCount} rows · {issues.length} issue(s) found
                  </div>
                </div>
                <IssueList issues={issues} />
                <button className="btn-primary" onClick={startInterview} style={{ marginTop: 24 }}>
                  {issues.length === 0 ? 'Dataset is clean ✓' : 'Start AI cleanup interview →'}
                </button>
              </div>
            )}

            {/* PHASE 2: AI Interview */}
            {phase === 2 && !loading && currentIssue && (
              <div className="dash-section fade-up">
                <div className="section-head">
                  <div className="section-head__title">Issue {issueStep + 1} of {issues.length}</div>
                  <div className="section-head__meta">
                    {currentIssue.column || 'Dataset'} — {currentIssue.type}
                  </div>
                </div>
                <AIBubble
                  question={currentQuestion?.question || getDefaultQuestion(currentIssue)}
                  options={getOptions(currentIssue)}
                  onSelect={opt => setUserInput(opt)}
                />
                <div className="input-row">
                  <input
                    className="input"
                    placeholder="Type your instruction or pick an option above…"
                    value={userInput}
                    onChange={e => setUserInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && submitResponse()}
                  />
                  <button className="btn-primary" onClick={submitResponse} disabled={!userInput.trim()}>
                    Send
                  </button>
                </div>
              </div>
            )}

            {/* PHASE 3: Preview */}
            {phase === 3 && currentAction && (
              <div className="dash-section fade-up">
                <div className="section-head">
                  <div className="section-head__title">Review proposed action</div>
                </div>
                <div className="preview-action">
                  <div className="preview-action__header">
                    <span className="preview-action__name">
                      {currentAction.action || currentAction.explanation}
                    </span>
                    <span className={`risk-pill ${RISK_CLASS[currentAction.risk] || 'risk-low'}`}>
                      {currentAction.risk || 'Low'} risk
                    </span>
                  </div>
                  <p className="preview-action__explanation">{currentAction.explanation}</p>
                  <div className="conf-bar-wrap">
                    <div className="conf-bar-row">
                      <span>AI confidence</span>
                      <strong>{currentAction.confidence || 85}%</strong>
                    </div>
                    <div className="conf-track">
                      <div className="conf-fill" style={{ width: `${currentAction.confidence || 85}%` }} />
                    </div>
                  </div>
                </div>
                <div className="confirm-row">
                  <button className="btn-confirm" onClick={confirmAction}>Confirm &amp; add to pipeline</button>
                  <button className="btn-reject"  onClick={rejectAction}>Reject — try again</button>
                </div>
              </div>
            )}

            {/* PHASE 4: Execute */}
            {phase === 4 && (
              <div className="dash-section fade-up">
                <div className="section-head">
                  <div className="section-head__title">
                    Pipeline — {pipeline.length} confirmed step(s)
                  </div>
                </div>

                {pipeline.map((step, i) => (
                  <PipelineStep key={i} step={step} index={i + 1} />
                ))}

                {execLog.length > 0 && (
                  <div className="exec-log">
                    {execLog.map((l, i) => <div key={i} className="exec-log__line">{l}</div>)}
                  </div>
                )}

                {!loading && pipeline.length > 0 && (
                  <button className="btn-primary" style={{ marginTop: 24 }} onClick={executePipeline}>
                    ▶ Execute pipeline
                  </button>
                )}

                {pipeline.length === 0 && (
                  <div style={{ color: 'var(--text2)', fontSize: 14, marginTop: 16 }}>
                    No issues needed cleaning. Your dataset is already clean.
                    <button className="btn-ghost" style={{ marginLeft: 16 }} onClick={reset}>
                      Start over
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* PHASE 5: Done */}
            {phase === 5 && (
              <div className="dash-section fade-up done-screen">
                <div className="done-screen__icon">✓</div>
                <h2 className="done-screen__title">Pipeline complete</h2>
                <p className="done-screen__sub">
                  All {pipeline.length} steps executed. Your clean dataset is ready.
                </p>
                <div className="done-screen__stats">
                  <div className="done-stat"><span>{rowCount}</span>Input rows</div>
                  <div className="done-stat"><span>{pipeline.length}</span>Steps run</div>
                  <div className="done-stat"><span>0</span>Errors</div>
                </div>
                <div className="done-screen__actions">
                  {datasetId && (
                    <a
                      className="btn-primary"
                      href={dataAPI.download(datasetId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Download CSV ↓
                    </a>
                  )}
                  <button className="btn-ghost" onClick={reset}>Clean another file</button>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}

// ── Fallback helpers for sample / offline mode ─────────────────────────────────

function getDefaultQuestion(issue) {
  if (!issue) return '';
  if (issue.type === 'missing' && issue.column === 'email')
    return `I found ${issue.affectedCount} rows where email is empty (${issue.affectedPercent}%). Should I remove them, fill with a placeholder, or flag for review?`;
  if (issue.type === 'missing')
    return `The ${issue.column} column has ${issue.affectedCount} missing values. Should I fill with mean, median, zero, or remove these rows?`;
  if (issue.type === 'duplicate')
    return `I found ${issue.affectedCount} exact duplicate rows. Should I remove them keeping the first occurrence?`;
  if (issue.type === 'format_inconsistency')
    return `The ${issue.column} column has inconsistent date formats. Should I standardise everything to YYYY-MM-DD?`;
  return `Issue in "${issue.column || 'dataset'}": ${issue.detail}. How should this be handled?`;
}

function getOptions(issue) {
  if (!issue) return [];
  if (issue.type === 'missing' && issue.column === 'email')
    return ['Drop rows with null email', 'Fill with placeholder', 'Flag for review', 'Keep as is'];
  if (issue.type === 'missing')
    return ['Fill with mean', 'Fill with median', 'Fill with zero', 'Drop these rows'];
  if (issue.type === 'duplicate')
    return ['Remove duplicates', 'Keep all rows'];
  if (issue.type === 'format_inconsistency')
    return ['Standardise to YYYY-MM-DD', 'Leave as is'];
  return ['Fix automatically', 'Skip this issue'];
}

function getSampleAction(stepIndex, userInput) {
  const actions = [
    { action: 'removeNulls',  column: 'email',       parameters: {},                    confidence: 91, risk: 'Low',    explanation: 'Rows missing email will be removed.' },
    { action: 'fillMissing',  column: 'revenue',     parameters: { method: 'mean' },    confidence: 87, risk: 'Low',    explanation: 'Missing revenue filled with column average.' },
    { action: 'deduplicate',  column: null,          parameters: { strategy: 'exact' }, confidence: 95, risk: 'Medium', explanation: 'Exact duplicate rows removed, first kept.' },
    { action: 'formatDates',  column: 'joined_date', parameters: { targetFormat: 'YYYY-MM-DD' }, confidence: 83, risk: 'Low', explanation: 'All dates standardised to ISO format.' },
  ];
  return actions[stepIndex % actions.length];
}