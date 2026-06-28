/**
 * frontend/src/components/dashboard/ProcurementWorkspace.jsx — V2.3
 *
 * CHANGES FROM V2.2:
 *   - NAVIGATION: Back/Forward arrows added to phase bar
 *     Before: once past Upload you were stuck — no way back
 *     After:  ← / → arrows on phase bar let you move freely between phases
 *
 *   - JUMP TO EXECUTE: Floating sticky bar appears in Review & Approve
 *     phase showing "N resolved / N total" with a direct "Jump to Execute →"
 *     button — no more scrolling through 800 items to reach Execute
 *
 *   - SCROLL TO TOP: Phase changes auto-scroll to top of workspace
 *
 *   - All V2.2 logic preserved exactly — no other changes
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import { dataAPI, uploadAPI, procurementAPI, whatsappAPI, ocrAPI } from '../../services/api';
import UploadZone from './UploadZone';
import Loader from '../common/Loader';
import ErrorMessage from '../common/ErrorMessage';
import InvoiceMatchTable from '../procurement/InvoiceMatchTable';
import DuplicateInvoiceAlert from '../procurement/DuplicateInvoiceAlert';
import ReconciliationSummary from '../procurement/ReconciliationSummary';
import ApprovalPanel from '../procurement/ApprovalPanel';
import SchemaPreview from '../procurement/SchemaPreview';
import IngestionSummary from '../procurement/IngestionSummary';
import ZipContentsPanel from '../procurement/ZipContentsPanel';
import ProcurementCopilot from '../copilot/ProcurementCopilot';
import './ProcurementWorkspace.css';

const PHASES = [
  'Upload',
  'Parse & Validate',
  'Analyze',
  'Review & Approve',
  'Execute',
  'Done',
];

const PHASE = {
  UPLOAD  : 0,
  PARSE   : 1,
  ANALYZE : 2,
  APPROVE : 3,
  EXECUTE : 4,
  DONE    : 5,
};

// Which phases are safe to navigate BACK to
const BACK_ALLOWED = {
  [PHASE.PARSE]   : PHASE.UPLOAD,
  [PHASE.ANALYZE] : PHASE.PARSE,
  [PHASE.APPROVE] : PHASE.ANALYZE,
  [PHASE.EXECUTE] : PHASE.APPROVE,
  [PHASE.DONE]    : PHASE.EXECUTE,
};

// Which phases are safe to navigate FORWARD to (only if data exists)
const FORWARD_ALLOWED = {
  [PHASE.UPLOAD]  : PHASE.PARSE,
  [PHASE.PARSE]   : PHASE.ANALYZE,
  [PHASE.ANALYZE] : PHASE.APPROVE,
  [PHASE.APPROVE] : PHASE.EXECUTE,
  [PHASE.EXECUTE] : PHASE.DONE,
};

const MAX_POLLS        = 300;  // 10 min at 2s intervals
const POLL_INTERVAL_MS = 2000;
const BASE_URL         = process.env.REACT_APP_API_URL || 'http://localhost:4000';

export default function ProcurementWorkspace() {
  const { token } = useAuth();
  const workspaceRef = useRef(null);

  const isMounted = useRef(true);
  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const [phase,          setPhase]          = useState(PHASE.UPLOAD);
  const [fileType,       setFileType]        = useState(null);
  const [datasetId,      setDatasetId]       = useState(null);
  const [zipContents,    setZipContents]     = useState(null);
  const [selectedZipFile,setSelectedZipFile] = useState(null);
  const [parseResult,      setParseResult]      = useState(null);
  const [ingestionWarnings,setIngestionWarnings]= useState([]);
  const [schemaValidation, setSchemaValidation] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [job,   setJob]   = useState(null);
  const [loading,      setLoading]      = useState(false);
  const [loadingMsg,   setLoadingMsg]   = useState('');
  const [progress,     setProgress]     = useState(null);
  const [error,        setError]        = useState('');
  const [whatsappPhone,setWhatsappPhone]= useState('');
  const [whatsappSent, setWhatsappSent] = useState(false);

  function safe(fn) {
    return (...args) => { if (isMounted.current) fn(...args); };
  }

  // ── Scroll to top whenever phase changes ────────────────────────────────────
  useEffect(() => {
    if (workspaceRef.current) {
      workspaceRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [phase]);

  // ── Navigation helpers ──────────────────────────────────────────────────────
  function goToPhase(p) {
    if (p < PHASE.UPLOAD || p > PHASE.DONE) return;
    setError('');
    setPhase(p);
  }

  function canGoBack() {
    if (loading) return false;
    return phase in BACK_ALLOWED;
  }

  function canGoForward() {
    if (loading) return false;
    if (!(phase in FORWARD_ALLOWED)) return false;
    const target = FORWARD_ALLOWED[phase];
    // Only allow forward if the target phase has its required data
    if (target === PHASE.PARSE   && !datasetId && !zipContents) return false;
    if (target === PHASE.ANALYZE && !job) return false;
    if (target === PHASE.APPROVE && !job) return false;
    if (target === PHASE.EXECUTE && !job) return false;
    if (target === PHASE.DONE    && job?.status !== 'completed') return false;
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 0 → 1 : Upload
  // ═══════════════════════════════════════════════════════════════════════════

  const handleUpload = useCallback(async (file) => {
    if (file === '__sample__') { _loadSampleData(); return; }
    const ext  = file.name.split('.').pop().toLowerCase();
    const type = ext === 'zip'  ? 'zip'
               : ext === 'xml'  ? 'xml'
               : ext === 'pdf'  ? 'pdf'
               : ['png','jpg','jpeg','tiff','tif','bmp','webp'].includes(ext) ? 'image'
               : ['xlsx', 'xls'].includes(ext) ? 'xlsx'
               : 'csv';
    setFileType(type);
    setError('');
    setLoading(true);
    setProgress(10);
    try {
      if (type === 'zip') {
        await _handleZipUpload(file);
      } else if (type === 'pdf' || type === 'image') {
        await _handleOcrUpload(file, type);
      } else {
        await _handleDirectUpload(file, type);
      }
    } catch (err) {
      safe(setError)(err.message);
      safe(setLoading)(false);
      safe(setProgress)(null);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  async function _handleZipUpload(file) {
    safe(setLoadingMsg)('Extracting ZIP archive…');
    safe(setProgress)(20);
    const result = await uploadAPI.zip(file, token);
    if (!isMounted.current) return;
    setZipContents(result);
    setIngestionWarnings(result.warnings || []);
    setProgress(80);
    setLoading(false);
    setProgress(null);
    setPhase(PHASE.PARSE);
  }

  async function _handleOcrUpload(file, type) {
    safe(setLoadingMsg)(
      type === 'pdf'
        ? 'Running OCR on PDF invoice… this may take 10–30 seconds'
        : 'Running OCR on image invoice…'
    );
    safe(setProgress)(20);
    const ocrRes = await ocrAPI.invoice(file, token);
    if (!isMounted.current) return;
    setDatasetId(ocrRes.datasetId);
    setProgress(85);
    setParseResult({
      rowCount     : ocrRes.rowCount    || 0,
      columnNames  : ocrRes.columnNames || [],
      schema       : ocrRes.schema      || {},
      sampleRows   : ocrRes.sampleRows  || [],
      warnings     : ocrRes.warnings    || [],
      ocrMethod    : ocrRes.ocrMethod,
      confidence   : ocrRes.confidence,
      confidenceLabel: ocrRes.confidenceLabel,
      extractedFields: ocrRes.extractedFields,
      needsAIFallback: ocrRes.needsAIFallback,
    });
    setIngestionWarnings(ocrRes.warnings || []);
    setSchemaValidation(
      ocrRes.columnNames && ocrRes.columnNames.length > 0
        ? { valid: true, missingGroups: [], warnings: [] }
        : null
    );
    if (ocrRes.confidence < 0.6) {
      setIngestionWarnings(prev => [
        ...prev,
        `OCR confidence is ${Math.round(ocrRes.confidence * 100)}% — please review extracted data carefully.`,
      ]);
    }
    setProgress(100);
    setLoading(false);
    setProgress(null);
    setPhase(PHASE.PARSE);
  }

  async function _handleDirectUpload(file, type) {
    safe(setLoadingMsg)(`Uploading and parsing ${type.toUpperCase()} file…`);
    safe(setProgress)(30);
    const uploadRes = await dataAPI.upload(file, token);
    if (!isMounted.current) return;
    setDatasetId(uploadRes.datasetId);
    setProgress(90);
    setParseResult({
      rowCount   : uploadRes.rowCount    || 0,
      columnNames: uploadRes.columns     || [],
      schema     : uploadRes.schema      || {},
      sampleRows : uploadRes.preview     || [],
      warnings   : uploadRes.warnings    || [],
    });
    setIngestionWarnings(uploadRes.warnings || []);
    setSchemaValidation(
      uploadRes.columns && uploadRes.columns.length > 0
        ? { valid: true, missingGroups: [], warnings: [] }
        : null
    );
    setProgress(100);
    setLoading(false);
    setProgress(null);
    setPhase(PHASE.PARSE);
  }

  async function handleSelectZipFile(zipFileEntry) {
    if (!isMounted.current) return;
    setSelectedZipFile(zipFileEntry);
    setError('');
    setLoading(true);
    setLoadingMsg('Parsing selected file from archive…');
    setProgress(20);
    try {
      const parseRes = await uploadAPI.parseServerPath(zipFileEntry.path, token);
      if (!isMounted.current) return;
      setProgress(60);
      const registerRes = await dataAPI.registerServerFile(
        zipFileEntry.path, zipFileEntry.name, token,
      );
      if (!isMounted.current) return;
      setDatasetId(registerRes.datasetId);
      setParseResult(parseRes);
      setIngestionWarnings(parseRes.warnings || []);
      setSchemaValidation(parseRes.schemaValidation || null);
      setProgress(100);
      setLoading(false);
      setProgress(null);
    } catch (err) {
      safe(setError)(err.message);
      safe(setLoading)(false);
      safe(setProgress)(null);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 1 → 2 : Start reconciliation + poll
  // ═══════════════════════════════════════════════════════════════════════════

  async function handleStartReconciliation() {
    if (!datasetId) return;
    setError('');
    setLoading(true);
    setLoadingMsg('AI is matching invoices to POs and detecting duplicates…');
    setProgress(10);
    try {
      const { jobId: newJobId } = await procurementAPI.startReconciliation(datasetId, null, token);
      if (!isMounted.current) return;
      setJobId(newJobId);
      setProgress(30);
      const completedJob = await _pollJob(newJobId);
      if (!isMounted.current) return;
      setJob(completedJob);
      setProgress(100);
      setLoading(false);
      setProgress(null);
      setPhase(PHASE.ANALYZE);
    } catch (err) {
      safe(setError)(err.message);
      safe(setLoading)(false);
      safe(setProgress)(null);
    }
  }

  async function _pollJob(jid) {
    for (let i = 0; i < MAX_POLLS; i++) {
      await _sleep(POLL_INTERVAL_MS);
      if (!isMounted.current) return null;
      let updatedJob;
      try {
        updatedJob = await procurementAPI.getJob(jid, token);
      } catch (fetchErr) {
        console.warn(`[pollJob] Attempt ${i + 1} fetch error: ${fetchErr.message}`);
        continue;
      }
      if (!isMounted.current) return null;
      setJob(updatedJob);
      setProgress(Math.min(95, 30 + i * 1));
      if (updatedJob.status === 'completed' || updatedJob.status === 'awaiting_approvals') {
        return updatedJob;
      }
      if (updatedJob.status === 'error' || updatedJob.status === 'failed') {
        throw new Error(updatedJob.error || `Reconciliation failed: ${updatedJob.status}`);
      }
    }
    throw new Error('Reconciliation timed out after 10 minutes. Please check that worker.js is running.');
  }

  function handleProceedToApproval() { setPhase(PHASE.APPROVE); }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 3 : Approve / Reject
  // ═══════════════════════════════════════════════════════════════════════════

  async function handleApprove(approvalId, response) {
    setError('');
    try {
      await procurementAPI.approveItem(jobId, approvalId, response, token);
      if (!isMounted.current) return;
      const updated = await procurementAPI.getJob(jobId, token);
      safe(setJob)(updated);
    } catch (err) {
      safe(setError)(err.message);
    }
  }

  async function handleReject(approvalId, reason) {
    setError('');
    try {
      await procurementAPI.rejectItem(jobId, approvalId, reason, token);
      if (!isMounted.current) return;
      const updated = await procurementAPI.getJob(jobId, token);
      safe(setJob)(updated);
    } catch (err) {
      safe(setError)(err.message);
    }
  }

  const handleCopilotApply = useCallback(async (actions) => {
    if (!actions || actions.length === 0 || !jobId) return;
    const approvals = job?.pendingApprovals || [];

    setJob(prev => {
      if (!prev) return prev;
      const updated = { ...prev };
      updated.pendingApprovals = (prev.pendingApprovals || []).map((a, i) => {
        const match = actions.find(act => act.index === i);
        if (match && a.status === 'pending') {
          return { ...a, status: 'approved', response: match.response, respondedVia: match.respondedVia };
        }
        return a;
      });
      return updated;
    });

    await Promise.allSettled(
      actions.map(({ index, response, respondedVia }) => {
        const approval = approvals[index];
        if (!approval || approval.status !== 'pending') return Promise.resolve();
        return procurementAPI.approveItem(jobId, approval.id || index, response, token)
          .catch(err => console.error(`[Copilot] approve #${index} failed:`, err.message));
      })
    );

    if (!isMounted.current) return;
    try {
      const refreshed = await procurementAPI.getJob(jobId, token);
      safe(setJob)(refreshed);
    } catch (err) {
      console.warn('[Copilot] job refresh failed:', err.message);
    }
  }, [jobId, job, token]);

  const copilotAmbiguities = (job?.pendingApprovals || []).map((a, i) => ({
    type    : a.type || a.question?.type || 'no_po_match',
    answered: a.status !== 'pending',
    invoice : {
      vendor_name   : a.invoice?.vendor_name || a.invoice?.vendor || '',
      amount        : a.invoice?.amount || a.invoice?.total || '',
      currency      : a.invoice?.currency || '',
      invoice_number: a.invoice?.invoice_number || '',
    },
  }));

  // ═══════════════════════════════════════════════════════════════════════════
  // WhatsApp
  // ═══════════════════════════════════════════════════════════════════════════

  async function sendToWhatsApp() {
    if (!whatsappPhone.trim()) return;
    setError('');
    const pending = (job?.pendingApprovals || []).filter(a => a.status === 'pending');
    if (!pending.length) return;
    try {
      for (const approval of pending) {
        await whatsappAPI.sendApproval(
          whatsappPhone, jobId, approval.id,
          approval.question?.question || approval.question,
          approval.question?.options  || [],
          token,
        );
        await _sleep(400);
        if (!isMounted.current) return;
      }
      safe(setWhatsappSent)(true);
    } catch (err) {
      safe(setError)(err.message || 'WhatsApp send failed.');
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PHASE 4 → 5 : Execute
  // ═══════════════════════════════════════════════════════════════════════════

  async function handleExecute() {
    setError('');
    setLoading(true);
    setLoadingMsg('Applying decisions and generating reconciled CSV…');
    setProgress(20);
    try {
      await procurementAPI.execute(jobId, token);
      if (!isMounted.current) return;
      setProgress(80);
      const finalJob = await procurementAPI.getJob(jobId, token);
      if (!isMounted.current) return;
      setJob(finalJob);
      setProgress(100);
      setLoading(false);
      setProgress(null);
      setPhase(PHASE.DONE);
    } catch (err) {
      safe(setError)(err.message);
      safe(setLoading)(false);
      safe(setProgress)(null);
    }
  }

  async function handleAuthenticatedDownload(url, filename) {
    try {
      const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const blob      = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a         = document.createElement('a');
      a.href          = objectUrl;
      a.download      = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err) {
      safe(setError)(`Download failed: ${err.message}`);
    }
  }

  function reset() {
    setPhase(PHASE.UPLOAD);
    setFileType(null);
    setDatasetId(null);
    setZipContents(null);
    setSelectedZipFile(null);
    setParseResult(null);
    setIngestionWarnings([]);
    setSchemaValidation(null);
    setJobId(null);
    setJob(null);
    setError('');
    setWhatsappPhone('');
    setWhatsappSent(false);
    setLoading(false);
    setLoadingMsg('');
    setProgress(null);
  }

  function _loadSampleData() {
    setFileType('csv');
    setDatasetId('sample');
    setParseResult({
      rowCount   : 48,
      columnNames: ['invoice_number', 'vendor_name', 'amount', 'currency', 'date', 'po_number'],
      schema: {
        invoice_number: { type: 'string', nullPct: 0, uniqueCount: 46, sample: ['INV-2841', 'INV-2842'] },
        vendor_name   : { type: 'string', nullPct: 2, uniqueCount: 12, sample: ['Apex Supplies Ltd'] },
        amount        : { type: 'float',  nullPct: 0, uniqueCount: 45, sample: ['12400', '5800'] },
        currency      : { type: 'string', nullPct: 0, uniqueCount:  3, sample: ['INR', 'USD'] },
        date          : { type: 'date',   nullPct: 4, uniqueCount: 38, sample: ['2024-03-01'] },
        po_number     : { type: 'string', nullPct: 8, uniqueCount: 40, sample: ['PO-0091'] },
      },
      sampleRows: [
        { invoice_number: 'INV-2841', vendor_name: 'Apex Supplies Ltd', amount: '12400', currency: 'INR', date: '2024-03-01', po_number: 'PO-0091' },
        { invoice_number: 'INV-2842', vendor_name: 'Meridian Tech',     amount: '5800',  currency: 'INR', date: '2024-03-02', po_number: 'PO-0092' },
      ],
      warnings: [],
    });
    setIngestionWarnings([]);
    setSchemaValidation({ valid: true, missingGroups: [], warnings: [] });
    setLoading(false);
    setProgress(null);
    setPhase(PHASE.PARSE);
  }

  const pendingCount   = (job?.pendingApprovals || []).filter(a => a.status === 'pending').length;
  const resolvedCount  = (job?.pendingApprovals || []).filter(a => a.status !== 'pending').length;
  const totalApprovals = (job?.pendingApprovals || []).length;
  const allResolved    = job && pendingCount === 0;

  // ═══════════════════════════════════════════════════════════════════════════
  // Render
  // ═══════════════════════════════════════════════════════════════════════════

  return (
    <div className="procurement-workspace" ref={workspaceRef}>

      {/* ── Phase bar with back/forward navigation ── */}
      <div className="phase-bar">
        {/* Back arrow */}
        <button
          className="phase-nav-btn phase-nav-btn--back"
          onClick={() => goToPhase(BACK_ALLOWED[phase])}
          disabled={!canGoBack()}
          title="Go back"
          aria-label="Previous phase"
        >
          ←
        </button>

        {/* Phase items */}
        {PHASES.map((p, i) => (
          <div
            key={p}
            className={`phase-bar__item ${i === phase ? 'active' : ''} ${i < phase ? 'done' : ''}`}
            onClick={() => {
              // Allow clicking on completed phases to go back
              if (i < phase && !loading) goToPhase(i);
            }}
            style={{ cursor: i < phase && !loading ? 'pointer' : 'default' }}
            title={i < phase ? `Go back to ${p}` : p}
          >
            {i < phase && <span className="phase-bar__check">✓ </span>}
            {p}
          </div>
        ))}

        {/* Forward arrow */}
        <button
          className="phase-nav-btn phase-nav-btn--forward"
          onClick={() => goToPhase(FORWARD_ALLOWED[phase])}
          disabled={!canGoForward()}
          title="Go forward"
          aria-label="Next phase"
        >
          →
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 16 }}>
          <ErrorMessage message={error} onRetry={() => setError('')} />
        </div>
      )}

      {loading && (
        <>
          <Loader message={loadingMsg} />
          {progress !== null && (
            <div className="proc-progress-wrap">
              <div className="proc-progress-bar">
                <div className="proc-progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <div className="proc-progress-label">{progress}%</div>
            </div>
          )}
        </>
      )}

      {/* ── PHASE 0: Upload ── */}
      {phase === PHASE.UPLOAD && !loading && (
        <div className="dash-section fade-up">
          <div className="proc-upload-header">
            <div className="proc-upload-title">Upload Invoice File</div>
            <div className="proc-upload-sub">
              Upload a <strong>CSV, XLSX, or XML</strong> invoice export, a{' '}
              <strong>ZIP</strong> archive, or a scanned{' '}
              <strong>PDF / image</strong> invoice — OCR will extract the data automatically.
            </div>
            <div className="proc-upload-formats">
              {['CSV', 'XLSX', 'XML', 'ZIP', 'PDF', 'PNG/JPG'].map(f => (
                <span key={f} className={`proc-format-badge ${f === 'PDF' || f === 'PNG/JPG' ? 'proc-format-badge--ocr' : ''}`}>
                  {f === 'PDF' || f === 'PNG/JPG' ? `🔍 ${f}` : f}
                </span>
              ))}
            </div>
          </div>
          <UploadZone
            onUpload={handleUpload}
            loading={loading}
            acceptedFormats=".csv,.xlsx,.xls,.xml,.zip,.pdf,.png,.jpg,.jpeg,.tiff,.tif"
          />
        </div>
      )}

      {/* ── PHASE 1: Parse & Validate ── */}
      {phase === PHASE.PARSE && !loading && (
        <div className="dash-section fade-up">
          {fileType === 'zip' && zipContents && (
            <ZipContentsPanel
              contents={zipContents}
              onSelect={handleSelectZipFile}
              selectedFile={selectedZipFile}
            />
          )}
          {(fileType === 'pdf' || fileType === 'image') && parseResult?.confidence !== undefined && (
            <div className={`proc-ocr-badge proc-ocr-badge--${parseResult.confidenceLabel?.level || 'medium'}`}>
              <span className="proc-ocr-badge__icon">🔍</span>
              <div className="proc-ocr-badge__content">
                <div className="proc-ocr-badge__title">
                  OCR Complete — {parseResult.confidenceLabel?.text || 'Review required'}
                  <span className="proc-ocr-badge__pct">
                    {Math.round((parseResult.confidence || 0) * 100)}% confidence
                  </span>
                </div>
                <div className="proc-ocr-badge__method">
                  Method: {parseResult.ocrMethod === 'pdf_table_extraction' ? 'Digital PDF (fast)'
                         : parseResult.ocrMethod === 'scanned_ocr' ? 'Scanned OCR'
                         : parseResult.ocrMethod === 'gemini_vision' ? 'AI Vision'
                         : parseResult.ocrMethod || 'Unknown'}
                </div>
                {parseResult.extractedFields && Object.keys(parseResult.extractedFields).length > 0 && (
                  <div className="proc-ocr-fields">
                    {parseResult.extractedFields.invoice_number &&
                      <span className="proc-ocr-field">Invoice: {parseResult.extractedFields.invoice_number}</span>}
                    {parseResult.extractedFields.vendor_name &&
                      <span className="proc-ocr-field">Vendor: {parseResult.extractedFields.vendor_name}</span>}
                    {parseResult.extractedFields.amount &&
                      <span className="proc-ocr-field">Amount: {parseResult.extractedFields.currency || ''} {parseResult.extractedFields.amount}</span>}
                  </div>
                )}
              </div>
            </div>
          )}
          {ingestionWarnings.length > 0 && (
            <IngestionSummary warnings={ingestionWarnings} />
          )}
          {parseResult && parseResult.columnNames?.length > 0 && (
            <SchemaPreview
              schema={parseResult.schema}
              columnNames={parseResult.columnNames}
              sampleRows={parseResult.sampleRows}
              rowCount={parseResult.rowCount}
              validation={schemaValidation}
            />
          )}
          {schemaValidation?.missingGroups?.length > 0 && (
            <div className="proc-schema-warning">
              <span className="proc-schema-warning__icon">⚠</span>
              <div>
                <div className="proc-schema-warning__title">Missing required columns</div>
                <div className="proc-schema-warning__detail">
                  Could not find: {schemaValidation.missingGroups.join(', ')}.
                  Reconciliation may be incomplete.
                </div>
              </div>
            </div>
          )}
          {datasetId && (
            <button className="btn-primary" style={{ marginTop: 20 }} onClick={handleStartReconciliation}>
              Start AI Reconciliation →
            </button>
          )}
          {!datasetId && fileType === 'zip' && (
            <div className="proc-zip-hint">
              Select a supported file from the archive above to continue.
            </div>
          )}
        </div>
      )}

      {/* ── PHASE 2: Analyze ── */}
      {phase === PHASE.ANALYZE && !loading && job && (
        <div className="dash-section fade-up">
          <ReconciliationSummary summary={job.reconciliation?.summary} />
          {job.reconciliation?.duplicates?.groups?.length > 0 && (
            <DuplicateInvoiceAlert groups={job.reconciliation.duplicates.groups} />
          )}
          {job.warnings?.length > 0 && (
            <IngestionSummary warnings={job.warnings} title="Processing Notes" />
          )}
          <div className="proc-analyze-actions">
            <button className="btn-primary" onClick={handleProceedToApproval}>
              Review &amp; Approve Items ({job.pendingApprovals?.length || 0}) →
            </button>
          </div>
        </div>
      )}

      {/* ── PHASE 3: Review & Approve ── */}
      {phase === PHASE.APPROVE && !loading && job && (
        <div className="dash-section fade-up">
          <ReconciliationSummary summary={job.reconciliation?.summary} />

          {job.reconciliation?.duplicates?.groups?.length > 0 && (
            <DuplicateInvoiceAlert groups={job.reconciliation.duplicates.groups} />
          )}

          <div className="proc-approvals-header">
            <div className="proc-approvals-title">
              {pendingCount > 0
                ? `${pendingCount} item${pendingCount > 1 ? 's' : ''} require your approval`
                : 'All items reviewed ✓'}
            </div>

            {pendingCount > 0 && (
              <div className="proc-whatsapp-row">
                <input
                  className="input proc-phone-input"
                  placeholder="+91 98765 43210 (WhatsApp)"
                  value={whatsappPhone}
                  onChange={e => setWhatsappPhone(e.target.value)}
                />
                <button
                  className="btn-ghost proc-wa-btn"
                  onClick={sendToWhatsApp}
                  disabled={!whatsappPhone.trim() || whatsappSent}
                >
                  {whatsappSent
                    ? `✓ Sent all ${pendingCount} items`
                    : `📱 Send ${pendingCount} item${pendingCount > 1 ? 's' : ''} to WhatsApp`}
                </button>
              </div>
            )}

            {whatsappSent && (
              <div className="proc-wa-notice">
                All {pendingCount} approval question{pendingCount > 1 ? 's' : ''} sent to{' '}
                {whatsappPhone}. You can also approve inline below.
              </div>
            )}
          </div>

          <ApprovalPanel
            approvals={job.pendingApprovals}
            onApprove={handleApprove}
            onReject={handleReject}
          />

          {allResolved && (
            <div className="proc-ready">
              <span className="proc-ready__icon">✓</span>
              All approvals complete. Ready to execute reconciliation.
              <button className="btn-primary proc-execute-btn" onClick={() => setPhase(PHASE.EXECUTE)}>
                Review Pipeline →
              </button>
            </div>
          )}

          <ProcurementCopilot
            ambiguities={copilotAmbiguities}
            jobId={jobId}
            onApply={handleCopilotApply}
            token={token}
          />

          {/* ── STICKY JUMP BAR: visible in Review & Approve ── */}
          {totalApprovals > 0 && (
            <div className="proc-jump-bar">
              <div className="proc-jump-bar__progress">
                <div
                  className="proc-jump-bar__fill"
                  style={{ width: `${Math.round((resolvedCount / totalApprovals) * 100)}%` }}
                />
              </div>
              <span className="proc-jump-bar__label">
                {resolvedCount} / {totalApprovals} resolved
              </span>
              <button
                className="proc-jump-bar__btn"
                onClick={() => setPhase(PHASE.EXECUTE)}
                title="Skip to Execute — you can still come back"
              >
                Jump to Execute →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── PHASE 4: Execute ── */}
      {phase === PHASE.EXECUTE && job && !loading && (
        <div className="dash-section fade-up">
          <div className="section-head">
            <div className="section-head__title">Ready to execute</div>
            <div className="section-head__meta">
              {job.pendingApprovals?.length} decisions recorded — output will be a clean reconciled CSV
            </div>
          </div>
          <InvoiceMatchTable approvals={job.pendingApprovals} />
          <button className="btn-primary" style={{ marginTop: 24 }} onClick={handleExecute}>
            ▶ Execute Reconciliation
          </button>
        </div>
      )}

      {/* ── PHASE 5: Done ── */}
      {phase === PHASE.DONE && (
        <div className="dash-section fade-up done-screen">
          <div className="done-screen__icon">✓</div>
          <h2 className="done-screen__title">Reconciliation complete</h2>
          <p className="done-screen__sub">All decisions applied. Your reconciled dataset is ready.</p>
          <div className="done-screen__stats">
            <div className="done-stat"><span>{job?.reconciliation?.summary?.matched    || 0}</span>Matched</div>
            <div className="done-stat"><span>{job?.reconciliation?.summary?.flagged    || 0}</span>Flagged</div>
            <div className="done-stat"><span>{job?.reconciliation?.summary?.duplicates || 0}</span>Duplicates</div>
          </div>
          <div className="done-screen__actions">
            {jobId && (
              <>
                <button className="btn-primary" onClick={() => handleAuthenticatedDownload(
                  `${BASE_URL}/api/procurement/${jobId}/download`, `reconciled_${jobId}.csv`
                )}>
                  Download Reconciled CSV ↓
                </button>
                <button className="btn-ghost" onClick={() => handleAuthenticatedDownload(
                  `${BASE_URL}/api/procurement/${jobId}/audit?format=json`, `audit_${jobId}.json`
                )}>
                  Download Audit Trail (JSON) ↓
                </button>
                <button className="btn-ghost" onClick={() => handleAuthenticatedDownload(
                  `${BASE_URL}/api/procurement/${jobId}/audit?format=csv`, `audit_${jobId}.csv`
                )}>
                  Download Audit Trail (CSV) ↓
                </button>
              </>
            )}
            <button className="btn-ghost" onClick={reset}>New Reconciliation</button>
          </div>
        </div>
      )}
    </div>
  );
}

function _sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
