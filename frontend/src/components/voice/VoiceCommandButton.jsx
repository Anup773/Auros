/**
 * frontend/src/components/voice/VoiceCommandButton.jsx
 *
 * Floating mic button for voice-driven bulk approvals on the Review & Approve step.
 *
 * Features:
 *  - First-visit onboarding tooltip explaining voice commands
 *  - Pulse animation while recording
 *  - Live transcript preview
 *  - Parses natural language into structured approval actions
 *  - Calls onActions(actions) so the parent page can apply them
 *
 * Usage:
 *   <VoiceCommandButton
 *     totalItems={777}
 *     onActions={(actions) => applyApprovals(actions)}
 *   />
 *
 * actions shape:
 *   [{ indices: [0,1,2], action: 'approve' | 'reject' | 'hold' | 'request_po' }]
 */

import { useState, useRef, useEffect, useCallback } from 'react';

// ── Constants ────────────────────────────────────────────────────────────────
const ONBOARDING_KEY = 'auros_voice_onboarding_seen';

const COMMAND_EXAMPLES = [
  'Approve items 1 to 50',
  'Reject 51 and 52',
  'Hold items 53 through 60',
  'Request PO for 61, 62, 63',
  'Approve all',
  'Reject items 70 to 80, approve the rest',
];

// ── Main component ────────────────────────────────────────────────────────────
export default function VoiceCommandButton({ totalItems = 0, onActions }) {
  const [phase, setPhase]               = useState('idle');      // idle | onboarding | recording | processing | result | error
  const [transcript, setTranscript]     = useState('');
  const [parsedActions, setParsedActions] = useState([]);
  const [errorMsg, setErrorMsg]         = useState('');
  const [showOnboarding, setShowOnboarding] = useState(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const streamRef        = useRef(null);

  // Show onboarding bubble on first visit
  useEffect(() => {
    const seen = localStorage.getItem(ONBOARDING_KEY);
    if (!seen) setShowOnboarding(true);
  }, []);

  const dismissOnboarding = () => {
    localStorage.setItem(ONBOARDING_KEY, '1');
    setShowOnboarding(false);
  };

  // ── Recording ──────────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    dismissOnboarding();
    setErrorMsg('');
    setTranscript('');
    setParsedActions([]);

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach(t => t.stop());
        const blob = new Blob(chunksRef.current, { type: 'audio/webm' });
        await sendAudio(blob);
      };

      recorder.start();
      setPhase('recording');
    } catch (err) {
      setErrorMsg('Microphone access denied. Please allow microphone permissions.');
      setPhase('error');
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && phase === 'recording') {
      mediaRecorderRef.current.stop();
      setPhase('processing');
    }
  }, [phase]);

  // ── Send to backend ────────────────────────────────────────────────────────
  const sendAudio = async (blob) => {
    try {
      const formData = new FormData();
      formData.append('audio', blob, 'voice.webm');

      const res = await fetch('/api/voice/transcribe', {
        method: 'POST',
        body: formData,
        credentials: 'include',
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Server error ${res.status}`);
      }

      const data = await res.json();
      const text = data.transcript || data.text || '';

      if (!text.trim()) throw new Error('No speech detected. Please try again.');

      setTranscript(text);
      const actions = parseVoiceCommand(text, totalItems);
      setParsedActions(actions);
      setPhase('result');
    } catch (err) {
      setErrorMsg(err.message);
      setPhase('error');
    }
  };

  // ── Apply actions ──────────────────────────────────────────────────────────
  const applyActions = () => {
    if (onActions && parsedActions.length > 0) {
      onActions(parsedActions);
    }
    setPhase('idle');
    setTranscript('');
    setParsedActions([]);
  };

  const cancel = () => {
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    setPhase('idle');
    setTranscript('');
    setParsedActions([]);
    setErrorMsg('');
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Global styles (injected once) ── */}
      <style>{STYLES}</style>

      {/* ── Onboarding bubble ── */}
      {showOnboarding && phase === 'idle' && (
        <div className="vc-onboarding" role="tooltip">
          <button className="vc-onboarding-close" onClick={dismissOnboarding} aria-label="Dismiss">✕</button>
          <div className="vc-onboarding-title">
            <span className="vc-onboarding-icon">🎙️</span> Voice Commands
          </div>
          <p className="vc-onboarding-body">
            You have <strong>{totalItems}</strong> items to review. Use your voice to approve, reject,
            or hold multiple items at once — no clicking required.
          </p>
          <div className="vc-onboarding-examples">
            {COMMAND_EXAMPLES.map((ex, i) => (
              <span key={i} className="vc-onboarding-chip">"{ex}"</span>
            ))}
          </div>
          <p className="vc-onboarding-hint">Click the mic button below to begin.</p>
        </div>
      )}

      {/* ── Expanded panel (recording / processing / result / error) ── */}
      {phase !== 'idle' && (
        <div className="vc-panel" role="dialog" aria-label="Voice command panel">

          {/* Processing */}
          {phase === 'processing' && (
            <div className="vc-panel-inner">
              <div className="vc-spinner" aria-label="Processing audio" />
              <p className="vc-panel-label">Transcribing your command…</p>
            </div>
          )}

          {/* Result */}
          {phase === 'result' && (
            <div className="vc-panel-inner">
              <p className="vc-panel-label vc-label-sm">You said:</p>
              <p className="vc-transcript">"{transcript}"</p>

              {parsedActions.length > 0 ? (
                <>
                  <p className="vc-panel-label vc-label-sm" style={{ marginTop: 12 }}>
                    Actions detected ({parsedActions.reduce((s, a) => s + a.indices.length, 0)} items):
                  </p>
                  <ul className="vc-action-list">
                    {parsedActions.map((a, i) => (
                      <li key={i} className={`vc-action-item vc-action-${a.action}`}>
                        <span className="vc-action-badge">{ACTION_LABELS[a.action]}</span>
                        <span className="vc-action-range">
                          {formatIndices(a.indices)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  <div className="vc-result-btns">
                    <button className="vc-btn vc-btn-apply" onClick={applyActions}>
                      ✓ Apply {parsedActions.reduce((s, a) => s + a.indices.length, 0)} actions
                    </button>
                    <button className="vc-btn vc-btn-cancel" onClick={cancel}>Cancel</button>
                  </div>
                </>
              ) : (
                <>
                  <p className="vc-no-actions">Couldn't parse any actions. Please try again.</p>
                  <div className="vc-result-btns">
                    <button className="vc-btn vc-btn-apply" onClick={() => setPhase('idle') || startRecording()}>
                      🎙 Try again
                    </button>
                    <button className="vc-btn vc-btn-cancel" onClick={cancel}>Cancel</button>
                  </div>
                </>
              )}
            </div>
          )}

          {/* Error */}
          {phase === 'error' && (
            <div className="vc-panel-inner">
              <p className="vc-error-msg">⚠ {errorMsg}</p>
              <div className="vc-result-btns">
                <button className="vc-btn vc-btn-apply" onClick={startRecording}>Try again</button>
                <button className="vc-btn vc-btn-cancel" onClick={cancel}>Cancel</button>
              </div>
            </div>
          )}

          {/* Recording */}
          {phase === 'recording' && (
            <div className="vc-panel-inner vc-recording-inner">
              <div className="vc-wave">
                {[...Array(5)].map((_, i) => <div key={i} className="vc-wave-bar" style={{ animationDelay: `${i * 0.12}s` }} />)}
              </div>
              <p className="vc-panel-label">Listening… speak your command</p>
              <p className="vc-panel-hint">e.g. "Approve 1 to 100, reject 101, hold 102 to 110"</p>
              <button className="vc-btn vc-btn-stop" onClick={stopRecording}>
                ⏹ Done speaking
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Floating mic button ── */}
      <button
        className={`vc-fab ${phase === 'recording' ? 'vc-fab-recording' : ''}`}
        onClick={phase === 'idle' ? startRecording : phase === 'recording' ? stopRecording : undefined}
        aria-label={phase === 'recording' ? 'Stop recording' : 'Start voice command'}
        title={phase === 'recording' ? 'Click to stop recording' : 'Voice commands — approve items hands-free'}
      >
        {phase === 'recording' ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : phase === 'processing' ? (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
            <circle cx="12" cy="12" r="9" strokeDasharray="28 56" className="vc-spin" />
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" stroke="none" />
            <path d="M5 10a7 7 0 0 0 14 0" />
            <line x1="12" y1="17" x2="12" y2="21" />
            <line x1="9" y1="21" x2="15" y2="21" />
          </svg>
        )}
        {phase === 'idle' && <span className="vc-fab-label">Voice</span>}
      </button>
    </>
  );
}

// ── Voice command parser ──────────────────────────────────────────────────────
/**
 * Parses a natural-language transcript into structured approval actions.
 * Handles: "approve 1 to 50", "reject items 51 and 52", "hold 53 through 60",
 *          "approve all", "reject the rest", "request PO for 61 62 63"
 */
function parseVoiceCommand(text, totalItems) {
  const t       = text.toLowerCase().trim();
  const actions = [];

  // Collect all mentioned ranges/numbers
  const ACTION_PATTERNS = [
    { regex: /\b(approve|accept|payment)\b[^.]*?(\d[\d,\s]*(?:to|through|and|-)\s*\d+|\d+(?:[,\s]+\d+)*|all|rest)/gi, action: 'approve' },
    { regex: /\b(reject|decline|discard|deny)\b[^.]*?(\d[\d,\s]*(?:to|through|and|-)\s*\d+|\d+(?:[,\s]+\d+)*|all|rest)/gi, action: 'reject' },
    { regex: /\b(hold|pause|review|flag|defer)\b[^.]*?(\d[\d,\s]*(?:to|through|and|-)\s*\d+|\d+(?:[,\s]+\d+)*|all|rest)/gi, action: 'hold' },
    { regex: /\b(request po|request purchase order|ask for po|get po)\b[^.]*?(\d[\d,\s]*(?:to|through|and|-)\s*\d+|\d+(?:[,\s]+\d+)*|all|rest)/gi, action: 'request_po' },
  ];

  let coveredIndices = new Set();

  for (const { regex, action } of ACTION_PATTERNS) {
    let match;
    while ((match = regex.exec(t)) !== null) {
      const rangeStr = match[2] || '';
      const indices  = parseRange(rangeStr, totalItems, coveredIndices);
      if (indices.length > 0) {
        actions.push({ action, indices });
        indices.forEach(i => coveredIndices.add(i));
      }
    }
  }

  // "approve all" shorthand without explicit range
  if (actions.length === 0 && /\b(approve all|accept all)\b/.test(t)) {
    const indices = Array.from({ length: totalItems }, (_, i) => i);
    actions.push({ action: 'approve', indices });
  }

  return actions;
}

function parseRange(rangeStr, totalItems, exclude = new Set()) {
  const s = rangeStr.trim().toLowerCase();
  const indices = [];

  if (s === 'all') {
    for (let i = 0; i < totalItems; i++) {
      if (!exclude.has(i)) indices.push(i);
    }
    return indices;
  }

  if (s === 'rest') {
    for (let i = 0; i < totalItems; i++) {
      if (!exclude.has(i)) indices.push(i);
    }
    return indices;
  }

  // "X to Y" / "X through Y" / "X - Y"
  const rangeMatch = s.match(/(\d+)\s*(?:to|through|-)\s*(\d+)/);
  if (rangeMatch) {
    const from = parseInt(rangeMatch[1], 10) - 1; // convert to 0-based
    const to   = parseInt(rangeMatch[2], 10) - 1;
    for (let i = Math.max(0, from); i <= Math.min(totalItems - 1, to); i++) {
      if (!exclude.has(i)) indices.push(i);
    }
    return indices;
  }

  // Individual numbers: "1, 2, 3" or "1 2 3"
  const nums = s.match(/\d+/g);
  if (nums) {
    for (const n of nums) {
      const idx = parseInt(n, 10) - 1;
      if (idx >= 0 && idx < totalItems && !exclude.has(idx)) {
        indices.push(idx);
      }
    }
  }

  return indices;
}

function formatIndices(indices) {
  if (indices.length === 0) return '';
  if (indices.length > 10) return `Items ${indices[0] + 1}–${indices[indices.length - 1] + 1} (${indices.length} total)`;
  // Show as ranges where consecutive
  const ranges = [];
  let start = indices[0], prev = indices[0];
  for (let i = 1; i <= indices.length; i++) {
    if (i < indices.length && indices[i] === prev + 1) { prev = indices[i]; continue; }
    ranges.push(start === prev ? `#${start + 1}` : `#${start + 1}–${prev + 1}`);
    if (i < indices.length) { start = indices[i]; prev = indices[i]; }
  }
  return ranges.join(', ');
}

const ACTION_LABELS = {
  approve    : '✓ Approve',
  reject     : '✗ Reject',
  hold       : '⏸ Hold',
  request_po : '📋 Request PO',
};

// ── Styles ────────────────────────────────────────────────────────────────────
const STYLES = `
  /* ── FAB ── */
  .vc-fab {
    position: fixed;
    bottom: 28px;
    right: 28px;
    z-index: 1000;
    display: flex;
    align-items: center;
    gap: 7px;
    padding: 0 18px 0 14px;
    height: 48px;
    background: #1a7a4a;
    color: #fff;
    border: none;
    border-radius: 24px;
    cursor: pointer;
    font-size: 14px;
    font-weight: 600;
    font-family: inherit;
    box-shadow: 0 4px 16px rgba(26,122,74,0.35);
    transition: background 0.2s, box-shadow 0.2s, transform 0.15s;
  }
  .vc-fab:hover { background: #156038; transform: translateY(-1px); box-shadow: 0 6px 20px rgba(26,122,74,0.45); }
  .vc-fab:active { transform: translateY(0); }
  .vc-fab-recording {
    background: #c0392b;
    box-shadow: 0 4px 20px rgba(192,57,43,0.45);
    animation: vc-pulse 1.4s infinite;
  }
  .vc-fab-label { letter-spacing: 0.02em; }
  @keyframes vc-pulse {
    0%,100% { box-shadow: 0 4px 20px rgba(192,57,43,0.45); }
    50%      { box-shadow: 0 4px 32px rgba(192,57,43,0.75); }
  }

  /* ── Panel ── */
  .vc-panel {
    position: fixed;
    bottom: 88px;
    right: 28px;
    z-index: 999;
    width: 340px;
    background: #fff;
    border: 1px solid #e0e0e0;
    border-radius: 16px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.14);
    overflow: hidden;
    animation: vc-slide-up 0.2s ease;
  }
  @keyframes vc-slide-up {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .vc-panel-inner { padding: 18px 20px; }
  .vc-panel-label { font-size: 12px; font-weight: 600; color: #888; text-transform: uppercase; letter-spacing: 0.06em; margin: 0 0 6px; }
  .vc-label-sm { font-size: 11px; }

  /* ── Spinner ── */
  .vc-spinner {
    width: 32px; height: 32px;
    border: 3px solid #eee;
    border-top-color: #1a7a4a;
    border-radius: 50%;
    animation: vc-spin 0.7s linear infinite;
    margin: 0 auto 12px;
  }
  @keyframes vc-spin { to { transform: rotate(360deg); } }

  /* ── Recording wave ── */
  .vc-recording-inner { text-align: center; }
  .vc-wave { display: flex; align-items: flex-end; justify-content: center; gap: 4px; height: 36px; margin-bottom: 12px; }
  .vc-wave-bar {
    width: 5px; background: #1a7a4a; border-radius: 3px;
    animation: vc-wave-anim 0.8s ease-in-out infinite alternate;
  }
  @keyframes vc-wave-anim {
    from { height: 6px; opacity: 0.5; }
    to   { height: 34px; opacity: 1; }
  }
  .vc-panel-hint { font-size: 12px; color: #999; margin: 4px 0 14px; }

  /* ── Transcript & actions ── */
  .vc-transcript {
    font-size: 14px; color: #222; font-style: italic;
    background: #f7f9f7; border-radius: 8px; padding: 10px 12px;
    margin: 0; line-height: 1.5;
  }
  .vc-action-list { list-style: none; padding: 0; margin: 6px 0 14px; display: flex; flex-direction: column; gap: 6px; }
  .vc-action-item { display: flex; align-items: center; gap: 8px; font-size: 13px; }
  .vc-action-badge {
    font-size: 11px; font-weight: 700; padding: 2px 8px; border-radius: 12px;
    white-space: nowrap;
  }
  .vc-action-approve .vc-action-badge  { background: #e6f4ed; color: #1a7a4a; }
  .vc-action-reject .vc-action-badge   { background: #fdecea; color: #c0392b; }
  .vc-action-hold .vc-action-badge     { background: #fff4e5; color: #d4820a; }
  .vc-action-request_po .vc-action-badge { background: #eaf2ff; color: #1a56db; }
  .vc-action-range { color: #555; }

  /* ── Buttons ── */
  .vc-result-btns { display: flex; gap: 8px; }
  .vc-btn { padding: 8px 14px; border-radius: 8px; border: none; cursor: pointer; font-size: 13px; font-weight: 600; font-family: inherit; transition: background 0.15s; }
  .vc-btn-apply  { background: #1a7a4a; color: #fff; flex: 1; }
  .vc-btn-apply:hover  { background: #156038; }
  .vc-btn-cancel { background: #f0f0f0; color: #555; }
  .vc-btn-cancel:hover { background: #e0e0e0; }
  .vc-btn-stop   { background: #c0392b; color: #fff; margin-top: 4px; }
  .vc-btn-stop:hover { background: #a93226; }
  .vc-no-actions { font-size: 13px; color: #888; margin: 6px 0 12px; }
  .vc-error-msg  { font-size: 13px; color: #c0392b; margin: 0 0 14px; }

  /* ── Onboarding bubble ── */
  .vc-onboarding {
    position: fixed;
    bottom: 88px;
    right: 28px;
    z-index: 999;
    width: 320px;
    background: #0f3d24;
    color: #fff;
    border-radius: 16px;
    padding: 18px 20px;
    box-shadow: 0 12px 40px rgba(0,0,0,0.22);
    animation: vc-slide-up 0.3s ease;
  }
  .vc-onboarding::after {
    content: '';
    position: absolute;
    bottom: -8px; right: 36px;
    width: 16px; height: 16px;
    background: #0f3d24;
    transform: rotate(45deg);
    border-radius: 2px;
  }
  .vc-onboarding-close {
    position: absolute; top: 12px; right: 14px;
    background: rgba(255,255,255,0.15); border: none; color: #fff;
    width: 24px; height: 24px; border-radius: 50%; cursor: pointer;
    font-size: 11px; display: flex; align-items: center; justify-content: center;
  }
  .vc-onboarding-title { font-size: 15px; font-weight: 700; margin-bottom: 8px; }
  .vc-onboarding-icon  { margin-right: 4px; }
  .vc-onboarding-body  { font-size: 13px; line-height: 1.55; margin: 0 0 10px; opacity: 0.9; }
  .vc-onboarding-examples { display: flex; flex-wrap: wrap; gap: 5px; margin-bottom: 10px; }
  .vc-onboarding-chip {
    font-size: 11px; background: rgba(255,255,255,0.12); border-radius: 6px;
    padding: 3px 8px; opacity: 0.85; font-style: italic;
  }
  .vc-onboarding-hint { font-size: 12px; opacity: 0.6; margin: 0; }
`;
