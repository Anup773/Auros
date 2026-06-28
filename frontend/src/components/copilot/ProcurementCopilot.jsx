/**
 * components/copilot/ProcurementCopilot.jsx
 *
 * CHANGES FROM PREVIOUS VERSION (this version):
 *
 *   FIX 1 — Double-submit race condition prevented (Critical Bug #1)
 *     Previous: handleSubmit / example buttons / confirm buttons could fire
 *     sendTextCommand() multiple times before the first request completed,
 *     causing duplicate approvals / PO creation / workflow execution.
 *     Fix: isThinking gate applied at the TOP of sendTextCommand() and
 *     sendVoiceCommand(). Example buttons and confirm buttons are disabled
 *     when isThinking is true. A submitting ref also blocks form re-submit.
 *
 *   FIX 2 — Confirmation overwrite protection (Critical Bug #2)
 *     Previous: any non-confirmation result silently cleared pendingConfirm.
 *     A user typing a new command before confirming would lose the pending
 *     action without any warning.
 *     Fix: When pendingConfirm is set and a new command arrives that is NOT
 *     a confirm/cancel keyword, the UI blocks it and prompts the user to
 *     confirm or cancel first. New commands only proceed after explicit cancel.
 *
 *   FIX 3 — MediaRecorder MIME type detection (Critical Bug #3)
 *     Previous: hardcoded 'audio/webm' crashed Safari with a false
 *     "Microphone access denied" error.
 *     Fix: _getSupportedMimeType() probes MediaRecorder.isTypeSupported()
 *     across audio/webm, audio/mp4, audio/ogg — uses first supported.
 *
 *   FIX 4 — AbortController on all fetch calls (Critical Bug #4)
 *     Previous: no cancellation — stale updates and memory growth when
 *     the panel closed mid-request.
 *     Fix: Each sendTextCommand / sendVoiceCommand creates an AbortController.
 *     Previous controller stored in abortControllerRef is aborted on new call.
 *     Panel close also aborts any in-flight request.
 *
 *   FIX 5 — Confirmation loop protection (Critical Bug #5)
 *     Previous: if backend returned needsConfirmation again on a confirm
 *     response, infinite loop was possible.
 *     Fix: confirmationDepth counter. After 3 consecutive confirmation
 *     responses without a definitive result, the loop is broken and an
 *     error message shown.
 *
 *   FIX 6 — Message history capped at MAX_MESSAGES (High Risk #6)
 *     Previous: messages array grew unboundedly — expensive React rerenders
 *     after 1000+ messages in long sessions.
 *     Fix: setMessages trims to last MAX_MESSAGES = 200 on every append.
 *
 *   FIX 7 — Mic stream cleaned up on unmount (High Risk #8)
 *     Previous: if component unmounted while recording, microphone light
 *     stayed on and stream leaked.
 *     Fix: useEffect cleanup stops all audio tracks on unmount.
 *
 *   FIX 8 — Example buttons disabled while thinking (High Risk #9)
 *     Previous: example command buttons remained clickable during processing.
 *     Fix: disabled={isThinking} applied to all example/confirm buttons.
 *
 *   FIX 9 — pendingCount memoized (Minor #21)
 *     Previous: ambiguities.filter() ran on every render even for 10k rows.
 *     Fix: useMemo with [ambiguities] dependency.
 *
 *   FIX 10 — Magic strings replaced with constants (Minor #23)
 *     MIC_PHASE, MSG_TYPE, COMMAND_SOURCE constants defined at module level.
 *
 *   FIX 11 — Fetch timeout via AbortController (Medium #12)
 *     30-second timeout on all fetch calls.
 *
 *   All previous fixes preserved:
 *     pendingConfirm bulk-confirmation flow, transcriptionError handling,
 *     token auth headers, local parser fallback, _sanitise(), SOURCE_LABELS.
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'react';

// ── Constants — no more magic strings ─────────────────────────────────────────
const MIC_PHASE = { IDLE: 'idle', RECORDING: 'recording', PROCESSING: 'processing' };
const MSG_TYPE  = { SUCCESS: 'success', ERROR: 'error', INFO: 'info', CONFIRM: 'confirm', DEFAULT: 'default' };
const CMD_SRC   = { LOCAL: 'local_parser', FALLBACK: 'local_parser_fallback', GEMINI: 'gemini_ai',
                    TYPED: 'typed', LOCAL_FB: 'local_fallback', CONFIRMED: 'confirmed', NONE: 'none' };

const ONBOARDING_KEY = 'auros_copilot_v3';
const MAX_MESSAGES   = 200;   // FIX 6: cap message history
const FETCH_TIMEOUT  = 30_000; // FIX 11: 30s timeout
const MAX_CONFIRM_DEPTH = 3;   // FIX 5: loop protection

const EXAMPLE_COMMANDS = [
  'Approve items 1 to 50',
  'Reject items 51 and 52',
  'Hold 53 through 70',
  'Approve all invoices under $500',
  'Request PO for all Alpha_Inc invoices',
  'Approve all EUR invoices',
  'Reject all duplicate invoices',
  'Approve all',
];

const SOURCE_LABELS = {
  [CMD_SRC.LOCAL]    : { text: 'Local · instant',        color: '#16a34a' },
  [CMD_SRC.FALLBACK] : { text: 'Local · low confidence',  color: '#d97706' },
  [CMD_SRC.GEMINI]   : { text: 'AI · complex command',    color: '#2563eb' },
  [CMD_SRC.TYPED]    : { text: 'Typed command',           color: '#6b7280' },
  [CMD_SRC.LOCAL_FB] : { text: 'Local fallback',          color: '#9ca3af' },
  [CMD_SRC.CONFIRMED]: { text: 'Confirmed',               color: '#16a34a' },
  [CMD_SRC.NONE]     : { text: 'Voice unavailable',       color: '#9ca3af' },
};

const ACTION_RESPONSES = {
  approve    : 'Approve for payment',
  reject     : 'Reject invoice',
  hold       : 'Hold for review',
  request_po : 'Request PO number from vendor',
};

// FIX 3: Detect supported MIME type for MediaRecorder
function _getSupportedMimeType() {
  const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
  for (const type of types) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';  // browser will use default
}

export default function ProcurementCopilot({ ambiguities = [], jobId, onApply, token }) {
  const [open, setOpen]               = useState(false);
  const [messages, setMessages]       = useState([]);
  const [inputText, setInputText]     = useState('');
  const [micPhase, setMicPhase]       = useState(MIC_PHASE.IDLE);
  const [isThinking, setIsThinking]   = useState(false);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [unreadCount, setUnreadCount] = useState(0);
  const [whisperAvail, setWhisperAvail] = useState(null);
  const [pendingConfirm, setPendingConfirm] = useState(null);

  // FIX 5: Track confirmation depth to prevent infinite loops
  const confirmDepthRef = useRef(0);
  // FIX 4: AbortController for in-flight requests
  const abortControllerRef = useRef(null);
  // FIX 1: Submitting ref — additional guard against double-submit
  const isSubmittingRef = useRef(false);

  const mediaRecorderRef = useRef(null);
  const chunksRef        = useRef([]);
  const streamRef        = useRef(null);
  const messagesEndRef   = useRef(null);
  const inputRef         = useRef(null);

  // FIX 9: Memoize pendingCount — ambiguities can be 10k items
  const pendingCount = useMemo(
    () => ambiguities.filter(a => !a.answered).length,
    [ambiguities]
  );

  const authHeaders = useCallback(() => {
    const h = { 'Content-Type': 'application/json' };
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }, [token]);

  // FIX 6: Append message with history cap
  const addMsg = useCallback((role, content, meta = {}) => {
    setMessages(prev => {
      const next = [...prev, { role, content, meta, ts: Date.now() }];
      return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
    });
  }, []);

  // ── Init ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (typeof window !== 'undefined' && !localStorage.getItem(ONBOARDING_KEY)) {
      setShowOnboarding(true);
    }
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    fetch('/api/voice/health', { credentials: 'include', headers })
      .then(r => r.ok ? r.json() : null)
      .then(d => setWhisperAvail(d?.available ?? false))
      .catch(() => setWhisperAvail(false));
  }, [token]);

  // FIX 7: Cleanup mic stream on unmount
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      // FIX 4: Abort any in-flight request on unmount
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  useEffect(() => {
    if (open) messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open]);

  useEffect(() => {
    if (!open && messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      setUnreadCount(c => c + 1);
    }
  }, [messages, open]);

  const dismissOnboarding = () => {
    if (typeof window !== 'undefined') localStorage.setItem(ONBOARDING_KEY, '1');
    setShowOnboarding(false);
  };

  const openPanel = () => {
    setOpen(true);
    setUnreadCount(0);
    dismissOnboarding();
    setTimeout(() => inputRef.current?.focus(), 150);
  };

  // FIX 4: Panel close also aborts in-flight request
  const closePanel = useCallback(() => {
    setOpen(false);
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  }, []);

  // ── Handle parsed result ───────────────────────────────────────────────────
  const _handleCommandResult = useCallback((data) => {
    // FIX 5: Track confirmation depth
    if (data.needsConfirmation) {
      confirmDepthRef.current += 1;
      if (confirmDepthRef.current > MAX_CONFIRM_DEPTH) {
        confirmDepthRef.current = 0;
        setPendingConfirm(null);
        addMsg('assistant',
          'Confirmation loop detected. Please try your command again.',
          { type: MSG_TYPE.ERROR }
        );
        return;
      }

      setPendingConfirm({
        actions       : data.pendingActions || [],
        interpretation: data.interpretation || '',
        totalAffected : data.totalAffected || 0,
      });
      addMsg('assistant', data.confirmationMsg || 'Please confirm this action.', {
        type       : MSG_TYPE.CONFIRM,
        sourceLabel: SOURCE_LABELS[data.commandSource] || SOURCE_LABELS[CMD_SRC.TYPED],
      });
      return;
    }

    // Reset confirmation depth on any definitive result
    confirmDepthRef.current = 0;

    if (data.cancelled) {
      setPendingConfirm(null);
      addMsg('assistant', data.interpretation || 'Action cancelled.', { type: MSG_TYPE.INFO });
      return;
    }

    if (data.transcriptionError || data.commandSource === CMD_SRC.NONE) {
      setPendingConfirm(null);
      addMsg('assistant', data.transcriptionError || data.interpretation, {
        type       : MSG_TYPE.ERROR,
        sourceLabel: SOURCE_LABELS[CMD_SRC.NONE],
      });
      return;
    }

    const actions = data.actions || [];
    setPendingConfirm(null);

    if (actions.length === 0) {
      addMsg('assistant',
        data.interpretation ||
        `I couldn't parse that command. Try something like "Approve items 1 to 50" or "Reject all EUR invoices".`,
        { type: MSG_TYPE.ERROR }
      );
      return;
    }

    const applied = [];
    for (const { indices, response } of actions) {
      for (const idx of indices) {
        if (ambiguities[idx] && !ambiguities[idx].answered) {
          applied.push({
            index       : idx,
            response,
            respondedVia: data.commandSource === CMD_SRC.GEMINI ? 'ai' : 'copilot',
          });
        }
      }
    }

    if (applied.length === 0) {
      addMsg('assistant', 'All matched items are already answered. Nothing new to apply.', { type: MSG_TYPE.INFO });
      return;
    }

    if (onApply) onApply(applied);

    addMsg('assistant', data.interpretation || `${applied.length} items actioned`, {
      type         : MSG_TYPE.SUCCESS,
      appliedCount : applied.length,
      commandSource: data.commandSource,
      sourceLabel  : SOURCE_LABELS[data.commandSource] || SOURCE_LABELS[CMD_SRC.TYPED],
      confidence   : data.confidence,
      warning      : data.warning,
    });
  }, [ambiguities, addMsg, onApply]);

  // ── Send typed command ─────────────────────────────────────────────────────
  const sendTextCommand = useCallback(async (text) => {
    if (!text.trim()) return;

    // FIX 1: Double-submit guard
    if (isThinking || isSubmittingRef.current) return;

    // FIX 2: Confirmation overwrite protection
    // Check if text is a confirm/cancel response first
    const tLower = text.trim().toLowerCase();
    const isConfirmKeyword = /\b(confirm|yes|proceed|execute|go ahead|sure|affirmative)\b/.test(tLower);
    const isCancelKeyword  = /\b(cancel|stop|abort|never mind|no|nope)\b/.test(tLower);

    if (pendingConfirm && !isConfirmKeyword && !isCancelKeyword) {
      // New command while confirmation pending — block it, prompt user
      addMsg('assistant',
        `You have a pending confirmation for ${pendingConfirm.totalAffected} item(s). ` +
        `Please say "confirm" to proceed or "cancel" to abort before entering a new command.`,
        { type: MSG_TYPE.INFO }
      );
      return;
    }

    addMsg('user', text, { via: 'text' });
    setInputText('');
    setIsThinking(true);
    isSubmittingRef.current = true;

    // FIX 4: Abort previous request, create new controller
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    // FIX 11: Timeout via AbortController
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const res = await fetch('/api/voice/text-command', {
        method     : 'POST',
        headers    : authHeaders(),
        credentials: 'include',
        signal     : controller.signal,
        body       : JSON.stringify({
          text,
          ambiguities   : _sanitise(ambiguities),
          pendingConfirm: pendingConfirm
            ? { actions: pendingConfirm.actions, interpretation: pendingConfirm.interpretation, totalAffected: pendingConfirm.totalAffected }
            : undefined,
        }),
      });

      clearTimeout(timeoutId);

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        console.warn('[Copilot] Backend returned non-JSON. Using local parser fallback.');
        const localResult = _localParse(text, ambiguities);
        setPendingConfirm(null);
        _handleCommandResult({ ...localResult, commandSource: CMD_SRC.LOCAL_FB });
        setIsThinking(false);
        isSubmittingRef.current = false;
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      _handleCommandResult(data);

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        addMsg('assistant', 'Request timed out. Please try again.', { type: MSG_TYPE.ERROR });
      } else {
        try {
          const localResult = _localParse(text, ambiguities);
          if (localResult.actions.length > 0) {
            setPendingConfirm(null);
            _handleCommandResult({ ...localResult, commandSource: CMD_SRC.LOCAL_FB });
            setIsThinking(false);
            isSubmittingRef.current = false;
            return;
          }
        } catch (_) {}
        addMsg('assistant', `Error: ${err.message}`, { type: MSG_TYPE.ERROR });
      }
    }

    setIsThinking(false);
    isSubmittingRef.current = false;
  }, [ambiguities, addMsg, authHeaders, _handleCommandResult, pendingConfirm, isThinking]);

  // ── Send voice command ─────────────────────────────────────────────────────
  const sendVoiceCommand = useCallback(async (blob) => {
    // FIX 1: Guard against processing while already processing
    if (isSubmittingRef.current) return;

    setMicPhase(MIC_PHASE.PROCESSING);
    isSubmittingRef.current = true;

    // FIX 4: AbortController
    if (abortControllerRef.current) abortControllerRef.current.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

    try {
      const formData = new FormData();
      formData.append('audio', blob, 'voice.webm');
      formData.append('ambiguities', JSON.stringify(_sanitise(ambiguities)));
      if (pendingConfirm) {
        formData.append('pendingConfirm', JSON.stringify({
          actions: pendingConfirm.actions, interpretation: pendingConfirm.interpretation,
          totalAffected: pendingConfirm.totalAffected,
        }));
      }

      const headers = {};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      const res = await fetch('/api/voice/command', {
        method: 'POST', headers, credentials: 'include',
        body: formData, signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const contentType = res.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) {
        addMsg('assistant',
          'Voice command failed unexpectedly (non-JSON response from server). Please type your command instead.',
          { type: MSG_TYPE.ERROR, sourceLabel: SOURCE_LABELS[CMD_SRC.NONE] }
        );
        setMicPhase(MIC_PHASE.IDLE);
        isSubmittingRef.current = false;
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server error ${res.status}`);
      if (data.transcript) addMsg('user', data.transcript, { via: 'voice' });
      _handleCommandResult(data);

    } catch (err) {
      clearTimeout(timeoutId);
      if (err.name === 'AbortError') {
        addMsg('assistant', 'Voice request timed out. Please try again.', { type: MSG_TYPE.ERROR });
      } else {
        addMsg('assistant', `Voice error: ${err.message}`, { type: MSG_TYPE.ERROR });
      }
    }

    setMicPhase(MIC_PHASE.IDLE);
    isSubmittingRef.current = false;
  }, [ambiguities, addMsg, token, _handleCommandResult, pendingConfirm]);

  // ── Mic recording ──────────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      chunksRef.current = [];

      // FIX 3: Detect supported MIME type — Safari doesn't support audio/webm
      const mimeType = _getSupportedMimeType();
      const options  = mimeType ? { mimeType } : {};

      let recorder;
      try {
        recorder = new MediaRecorder(stream, options);
      } catch (e) {
        // FIX 3: If specified type fails, let browser choose default
        recorder = new MediaRecorder(stream);
      }

      mediaRecorderRef.current = recorder;
      recorder.ondataavailable = e => { if (e.data.size > 0) chunksRef.current.push(e.data); };
      recorder.onstop = () => {
        // FIX 7: Stop tracks here (also stopped in cleanup on unmount)
        stream.getTracks().forEach(t => t.stop());
        streamRef.current = null;
        const blob = new Blob(chunksRef.current, { type: mimeType || 'audio/webm' });
        sendVoiceCommand(blob);
      };
      recorder.start();
      setMicPhase(MIC_PHASE.RECORDING);
    } catch (err) {
      // FIX 3: Distinguish mic permission errors from codec errors
      const isPermission = err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError';
      addMsg('assistant',
        isPermission
          ? 'Microphone access denied. Please check your browser permissions.'
          : `Recording failed: ${err.message}. Try typing your command instead.`,
        { type: MSG_TYPE.ERROR }
      );
    }
  }, [sendVoiceCommand, addMsg]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current && micPhase === MIC_PHASE.RECORDING) {
      mediaRecorderRef.current.stop();
    }
  }, [micPhase]);

  const handleMicClick = () => {
    // FIX 1: Prevent mic during processing
    if (isThinking || isSubmittingRef.current) return;
    if (micPhase === MIC_PHASE.IDLE) startRecording();
    else if (micPhase === MIC_PHASE.RECORDING) stopRecording();
  };

  const handleSubmit = e => {
    e?.preventDefault();
    // FIX 1: Redundant guard — sendTextCommand also checks
    if (isThinking || isSubmittingRef.current) return;
    sendTextCommand(inputText.trim());
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{STYLES}</style>

      {showOnboarding && !open && (
        <div className="cp-onboarding">
          <button className="cp-ob-close" onClick={dismissOnboarding}>✕</button>
          <div className="cp-ob-header">
            <span>⚡</span>
            <span className="cp-ob-title">Auros Copilot</span>
            <span className="cp-ob-badge">NEW</span>
          </div>
          <p className="cp-ob-body">
            <strong>{pendingCount}</strong> items need review. Use voice or type to action hundreds at once.
          </p>
          <div className="cp-ob-chips">
            {EXAMPLE_COMMANDS.slice(0, 4).map((ex, i) => (
              <span key={i} className="cp-ob-chip">"{ex}"</span>
            ))}
          </div>
          <button className="cp-ob-cta" onClick={openPanel}>Open Copilot →</button>
        </div>
      )}

      {open && (
        <div className="cp-panel" role="dialog" aria-label="Auros Procurement Copilot">
          <div className="cp-header">
            <div className="cp-header-left">
              <div className="cp-dot" />
              <span className="cp-header-title">Auros Copilot</span>
              <span className="cp-header-sub">{pendingCount} pending</span>
              {whisperAvail === true  && <span className="cp-badge-local">🔒 Local STT</span>}
              {whisperAvail === false && <span className="cp-badge-cloud">☁ Cloud STT</span>}
            </div>
            {/* FIX 4: Use closePanel to abort in-flight request */}
            <button className="cp-close-btn" onClick={closePanel}>
              <CloseIcon />
            </button>
          </div>

          <div className="cp-messages" role="log" aria-live="polite">
            {messages.length === 0 && (
              <div className="cp-empty">
                <div className="cp-empty-icon">⚡</div>
                <p className="cp-empty-title">Ready to assist</p>
                <p className="cp-empty-sub">Type or speak a command:</p>
                <div className="cp-examples">
                  {EXAMPLE_COMMANDS.map((ex, i) => (
                    // FIX 8: Disabled while thinking
                    <button
                      key={i}
                      className="cp-example-btn"
                      onClick={() => sendTextCommand(ex)}
                      disabled={isThinking}
                    >
                      {ex}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((msg, i) => (
              <div key={i} className={`cp-msg cp-msg-${msg.role}`}>
                {msg.role === 'assistant' && <div className="cp-avatar">⚡</div>}
                <div className={`cp-bubble cp-bubble-${msg.meta?.type || MSG_TYPE.DEFAULT}`}>
                  {msg.role === 'user' && msg.meta?.via === 'voice' && <span className="cp-voice-tag">🎙 </span>}
                  <span>{msg.content}</span>
                  {msg.meta?.type === MSG_TYPE.CONFIRM && (
                    <div className="cp-confirm-row">
                      {/* FIX 8: Disabled while thinking, FIX 1: guard in sendTextCommand */}
                      <button
                        className="cp-confirm-btn cp-confirm-yes"
                        onClick={() => sendTextCommand('confirm')}
                        disabled={isThinking}
                      >
                        ✓ Confirm
                      </button>
                      <button
                        className="cp-confirm-btn cp-confirm-no"
                        onClick={() => sendTextCommand('cancel')}
                        disabled={isThinking}
                      >
                        ✕ Cancel
                      </button>
                    </div>
                  )}
                  {msg.meta?.appliedCount > 0 && (
                    <div className="cp-applied-row">
                      <span className="cp-applied-count">✓ {msg.meta.appliedCount} items actioned</span>
                      {msg.meta.sourceLabel && (
                        <span className="cp-source-tag" style={{ color: msg.meta.sourceLabel.color }}>
                          {msg.meta.sourceLabel.text}
                        </span>
                      )}
                    </div>
                  )}
                  {msg.meta?.sourceLabel && msg.meta?.type !== MSG_TYPE.SUCCESS && msg.meta?.appliedCount === undefined && (
                    <div className="cp-applied-row">
                      <span />
                      <span className="cp-source-tag" style={{ color: msg.meta.sourceLabel.color }}>
                        {msg.meta.sourceLabel.text}
                      </span>
                    </div>
                  )}
                  {msg.meta?.warning && <div className="cp-warning">⚠ {msg.meta.warning}</div>}
                </div>
              </div>
            ))}

            {isThinking && (
              <div className="cp-msg cp-msg-assistant">
                <div className="cp-avatar">⚡</div>
                <div className="cp-bubble cp-bubble-default cp-thinking">
                  <span /><span /><span />
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {pendingConfirm && (
            <div className="cp-pending-banner">
              Awaiting confirmation for {pendingConfirm.totalAffected} item(s) — type "confirm" or "cancel".
            </div>
          )}

          <form className="cp-input-row" onSubmit={handleSubmit}>
            <button
              type="button"
              className={`cp-mic-btn ${micPhase === MIC_PHASE.RECORDING ? 'cp-mic-active' : ''} ${micPhase === MIC_PHASE.PROCESSING ? 'cp-mic-proc' : ''}`}
              onClick={handleMicClick}
              // FIX 1+8: Disabled while thinking or processing
              disabled={isThinking || micPhase === MIC_PHASE.PROCESSING}
              title={micPhase === MIC_PHASE.RECORDING ? 'Tap to stop' : 'Voice command'}
            >
              {micPhase === MIC_PHASE.RECORDING  ? <StopIcon />  :
               micPhase === MIC_PHASE.PROCESSING ? <SpinIcon />  : <MicIcon />}
            </button>
            <input
              ref={inputRef}
              className="cp-input"
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder={
                pendingConfirm       ? 'Type "confirm" or "cancel"…'
                : isThinking         ? 'Processing…'
                : micPhase === MIC_PHASE.RECORDING ? 'Listening…'
                : 'Type a command or use mic…'
              }
              disabled={micPhase === MIC_PHASE.RECORDING || micPhase === MIC_PHASE.PROCESSING}
            />
            <button
              type="submit"
              className="cp-send-btn"
              // FIX 1: Disabled while thinking
              disabled={!inputText.trim() || isThinking}
            >
              <SendIcon />
            </button>
          </form>
        </div>
      )}

      <button
        className={`cp-fab ${micPhase === MIC_PHASE.RECORDING ? 'cp-fab-rec' : ''} ${open ? 'cp-fab-open' : ''}`}
        onClick={open ? closePanel : openPanel}
        aria-label={open ? 'Close copilot' : 'Open Auros Copilot'}
      >
        {open ? <CloseIcon /> : (
          <>
            <MicIcon />
            <span className="cp-fab-label">Copilot</span>
            {unreadCount > 0 && <span className="cp-unread">{unreadCount}</span>}
          </>
        )}
      </button>
    </>
  );
}

// ── Icons ──────────────────────────────────────────────────────────────────────
const MicIcon   = () => <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor" stroke="none"/><path d="M5 10a7 7 0 0 0 14 0"/><line x1="12" y1="17" x2="12" y2="21"/><line x1="9" y1="21" x2="15" y2="21"/></svg>;
const StopIcon  = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><rect x="5" y="5" width="14" height="14" rx="2"/></svg>;
const SpinIcon  = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"><path d="M12 3a9 9 0 1 0 9 9" style={{animation:'cp-spin 0.8s linear infinite',transformOrigin:'center'}}/></svg>;
const SendIcon  = () => <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor"><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>;
const CloseIcon = () => <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><line x1="1" y1="1" x2="13" y2="13"/><line x1="13" y1="1" x2="1" y2="13"/></svg>;

// ── Local parser fallback ──────────────────────────────────────────────────────
function _localParse(text, ambiguities) {
  const t     = text.toLowerCase().trim();
  const total = ambiguities.length;
  const actions = [];
  const covered = new Set();

  const PATTERNS = [
    { keywords: ['approve', 'accept', 'pay'],             action: 'approve'    },
    { keywords: ['reject', 'decline', 'deny', 'discard'], action: 'reject'     },
    { keywords: ['hold', 'pause', 'defer', 'flag'],       action: 'hold'       },
    { keywords: ['request po', 'need po'],                action: 'request_po' },
  ];

  for (const { keywords, action } of PATTERNS) {
    if (!keywords.some(kw => t.includes(kw))) continue;
    let indices = [];

    const rangeMatch = t.match(/(\d+)\s*(?:to|through|-|–)\s*(\d+)/);
    if (rangeMatch) {
      const from = parseInt(rangeMatch[1]) - 1;
      const to   = parseInt(rangeMatch[2]) - 1;
      for (let i = Math.max(0, from); i <= Math.min(total - 1, to); i++) {
        if (!covered.has(i) && !ambiguities[i]?.answered) indices.push(i);
      }
    } else if (t.includes('all') || t.includes('every') || t.includes('rest')) {
      for (let i = 0; i < total; i++) {
        if (!covered.has(i) && !ambiguities[i]?.answered) indices.push(i);
      }
    } else {
      const nums = t.match(/\b(\d+)\b/g) || [];
      for (const n of nums) {
        const idx = parseInt(n) - 1;
        if (idx >= 0 && idx < total && !covered.has(idx) && !ambiguities[idx]?.answered) indices.push(idx);
      }
    }

    if (indices.length > 0) {
      actions.push({ action, indices, response: ACTION_RESPONSES[action] });
      indices.forEach(i => covered.add(i));
    }
  }

  return {
    actions,
    confidence   : actions.length > 0 ? 0.85 : 0,
    interpretation: actions.length > 0
      ? actions.map(a => {
          const label = { approve:'Approved', reject:'Rejected', hold:'Held', request_po:'PO requested for' }[a.action];
          return `${label} ${a.indices.length} item${a.indices.length !== 1 ? 's' : ''}`;
        }).join(' · ')
      : 'No matching items found',
  };
}

function _sanitise(ambiguities) {
  return ambiguities.map(a => ({
    type    : a.type,
    answered: a.answered || false,
    invoice : {
      vendor_name   : a.invoice?.vendor_name || a.invoice?.vendor || '',
      amount        : a.invoice?.amount || a.invoice?.total || '',
      currency      : a.invoice?.currency || '',
      invoice_number: a.invoice?.invoice_number || '',
    },
  }));
}

// ── Styles ─────────────────────────────────────────────────────────────────────
const STYLES = `
  @keyframes cp-spin  { to { transform: rotate(360deg); } }
  @keyframes cp-enter { from{opacity:0;transform:translateY(16px) scale(0.97)} to{opacity:1;transform:translateY(0) scale(1)} }
  @keyframes cp-pulse { 0%,100%{box-shadow:0 6px 24px rgba(127,29,29,0.4)} 50%{box-shadow:0 6px 40px rgba(239,68,68,0.75)} }
  @keyframes cp-blink { 0%,100%{opacity:1} 50%{opacity:0.35} }
  @keyframes cp-bounce{ 0%,60%,100%{transform:translateY(0)} 30%{transform:translateY(-7px)} }

  .cp-fab {
    position:fixed; bottom:28px; right:28px; z-index:1000;
    display:flex; align-items:center; gap:8px;
    height:50px; padding:0 20px 0 15px;
    background:#0d2b1a; color:#e8f5ee;
    border:1px solid rgba(255,255,255,0.07);
    border-radius:25px; cursor:pointer;
    font-size:13.5px; font-weight:700; letter-spacing:0.03em; font-family:inherit;
    box-shadow:0 6px 24px rgba(0,0,0,0.25);
    transition:background .2s, box-shadow .2s, transform .15s;
  }
  .cp-fab:hover  { background:#1a4a2e; transform:translateY(-2px); }
  .cp-fab-open   { background:#111; }
  .cp-fab-rec    { background:#7f1d1d; animation:cp-pulse 1.2s infinite; }
  .cp-fab-label  { font-size:13px; }
  .cp-unread {
    position:absolute; top:-4px; right:-4px;
    background:#ef4444; color:#fff; font-size:10px; font-weight:800;
    min-width:18px; height:18px; border-radius:9px;
    display:flex; align-items:center; justify-content:center; padding:0 4px;
    border:2px solid #fff;
  }
  .cp-panel {
    position:fixed; bottom:90px; right:28px; z-index:999;
    width:380px; height:540px;
    background:#fff; border:1px solid #e2e8e4; border-radius:20px;
    box-shadow:0 20px 60px rgba(0,0,0,0.15);
    display:flex; flex-direction:column; overflow:hidden;
    animation:cp-enter .22s cubic-bezier(.34,1.56,.64,1);
  }
  .cp-header {
    display:flex; align-items:center; justify-content:space-between;
    padding:13px 16px; background:#0d2b1a; border-radius:20px 20px 0 0; flex-shrink:0;
  }
  .cp-header-left { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .cp-dot { width:8px; height:8px; border-radius:50%; background:#4ade80; box-shadow:0 0 8px #4ade80; animation:cp-blink 2.5s infinite; }
  .cp-header-title { font-size:14px; font-weight:800; color:#e8f5ee; letter-spacing:.04em; }
  .cp-header-sub   { font-size:11px; color:rgba(255,255,255,.4); }
  .cp-badge-local  { font-size:9px; font-weight:700; background:rgba(74,222,128,.15); color:#4ade80; padding:2px 6px; border-radius:4px; }
  .cp-badge-cloud  { font-size:9px; font-weight:700; background:rgba(255,255,255,.1); color:rgba(255,255,255,.5); padding:2px 6px; border-radius:4px; }
  .cp-close-btn {
    background:rgba(255,255,255,.1); border:none; color:rgba(255,255,255,.7);
    width:28px; height:28px; border-radius:50%; cursor:pointer;
    display:flex; align-items:center; justify-content:center;
  }
  .cp-close-btn:hover { background:rgba(255,255,255,.2); color:#fff; }
  .cp-messages { flex:1; overflow-y:auto; padding:14px; display:flex; flex-direction:column; gap:10px; }
  .cp-messages::-webkit-scrollbar { width:3px; }
  .cp-messages::-webkit-scrollbar-thumb { background:#d1d5db; border-radius:2px; }
  .cp-empty { text-align:center; padding:10px 4px; }
  .cp-empty-icon  { font-size:26px; margin-bottom:6px; }
  .cp-empty-title { font-size:14px; font-weight:700; color:#1a1a1a; margin:0 0 3px; }
  .cp-empty-sub   { font-size:12px; color:#888; margin:0 0 12px; }
  .cp-examples    { display:flex; flex-wrap:wrap; gap:5px; justify-content:center; }
  .cp-example-btn {
    font-size:11.5px; padding:4px 10px; background:#f0f7f3;
    border:1px solid #c6e0d0; color:#1a5c38; border-radius:20px;
    cursor:pointer; font-family:inherit; font-style:italic;
    transition:background .15s;
  }
  .cp-example-btn:hover:not(:disabled) { background:#dcf0e6; }
  .cp-example-btn:disabled { opacity:0.4; cursor:not-allowed; }
  .cp-msg { display:flex; gap:8px; align-items:flex-end; }
  .cp-msg-user { flex-direction:row-reverse; }
  .cp-avatar { width:28px; height:28px; border-radius:50%; background:#0d2b1a; color:#4ade80; display:flex; align-items:center; justify-content:center; font-size:13px; flex-shrink:0; }
  .cp-bubble { max-width:285px; padding:9px 13px; border-radius:16px; font-size:13.5px; line-height:1.5; }
  .cp-msg-user .cp-bubble      { background:#0d2b1a; color:#e8f5ee; border-bottom-right-radius:4px; }
  .cp-msg-assistant .cp-bubble { background:#f4f7f5; color:#1a1a1a; border-bottom-left-radius:4px; }
  .cp-bubble-success { background:#e8f5ee !important; border:1px solid #bbdece; }
  .cp-bubble-error   { background:#fef2f2 !important; border:1px solid #fecaca; color:#991b1b !important; }
  .cp-bubble-info    { background:#eff6ff !important; border:1px solid #bfdbfe; color:#1e40af !important; }
  .cp-bubble-confirm { background:#fffbeb !important; border:1px solid #fde68a; color:#92400e !important; }
  .cp-voice-tag { font-size:11px; opacity:.7; }
  .cp-applied-row { display:flex; align-items:center; justify-content:space-between; margin-top:6px; padding-top:6px; border-top:1px solid rgba(22,101,52,.15); }
  .cp-applied-count { font-size:11px; font-weight:700; color:#166534; }
  .cp-source-tag    { font-size:10px; font-weight:600; }
  .cp-warning { font-size:11px; color:#92400e; margin-top:5px; background:#fef3c7; padding:4px 8px; border-radius:5px; }
  .cp-confirm-row { display:flex; gap:6px; margin-top:8px; }
  .cp-confirm-btn {
    flex:1; padding:6px 10px; border-radius:8px; border:none;
    font-size:12px; font-weight:700; cursor:pointer; font-family:inherit;
    transition:opacity .15s;
  }
  .cp-confirm-btn:disabled { opacity:0.4; cursor:not-allowed; }
  .cp-confirm-yes { background:#16a34a; color:#fff; }
  .cp-confirm-no  { background:#dc2626; color:#fff; }
  .cp-confirm-btn:hover:not(:disabled) { opacity:.85; }
  .cp-pending-banner {
    font-size:11.5px; color:#92400e; background:#fffbeb;
    border-top:1px solid #fde68a; padding:6px 14px; text-align:center; flex-shrink:0;
  }
  .cp-thinking { display:flex; gap:4px; align-items:center; padding:12px 16px !important; }
  .cp-thinking span { width:6px; height:6px; border-radius:50%; background:#9ca3af; animation:cp-bounce 1.2s ease-in-out infinite; }
  .cp-thinking span:nth-child(2) { animation-delay:.2s; }
  .cp-thinking span:nth-child(3) { animation-delay:.4s; }
  .cp-input-row {
    display:flex; align-items:center; gap:7px;
    padding:11px 13px; border-top:1px solid #e9ede9;
    background:#fafcfa; flex-shrink:0; border-radius:0 0 20px 20px;
  }
  .cp-input {
    flex:1; height:37px; padding:0 12px;
    border:1px solid #d1d5db; border-radius:19px;
    font-size:13px; font-family:inherit; outline:none;
    transition:border-color .15s;
  }
  .cp-input:focus { border-color:#1a7a4a; box-shadow:0 0 0 3px rgba(26,122,74,.1); }
  .cp-input::placeholder { color:#aaa; }
  .cp-input:disabled { background:#f3f4f6; color:#9ca3af; }
  .cp-mic-btn, .cp-send-btn {
    width:35px; height:35px; border-radius:50%; border:none;
    cursor:pointer; display:flex; align-items:center; justify-content:center;
    flex-shrink:0; transition:background .15s, transform .1s;
  }
  .cp-mic-btn  { background:#f0f4f1; color:#374151; }
  .cp-mic-btn:hover:not(:disabled) { background:#e0ebe3; transform:scale(1.05); }
  .cp-mic-btn:disabled { opacity:0.4; cursor:not-allowed; }
  .cp-mic-active { background:#fef2f2; color:#dc2626; animation:cp-pulse 1.2s infinite; }
  .cp-mic-proc   { background:#eff6ff; color:#2563eb; }
  .cp-send-btn   { background:#1a7a4a; color:#fff; }
  .cp-send-btn:hover:not(:disabled) { background:#156038; transform:scale(1.05); }
  .cp-send-btn:disabled { background:#d1d5db; cursor:not-allowed; }
  .cp-onboarding {
    position:fixed; bottom:92px; right:28px; z-index:999;
    width:295px; background:#0d2b1a; color:#e8f5ee;
    border-radius:16px; padding:17px 18px 15px;
    box-shadow:0 16px 48px rgba(0,0,0,0.25);
    animation:cp-enter .3s cubic-bezier(.34,1.56,.64,1);
  }
  .cp-onboarding::after {
    content:''; position:absolute; bottom:-7px; right:42px;
    width:14px; height:14px; background:#0d2b1a;
    transform:rotate(45deg); border-radius:2px;
  }
  .cp-ob-close {
    position:absolute; top:11px; right:13px;
    background:rgba(255,255,255,.12); border:none; color:rgba(255,255,255,.7);
    width:22px; height:22px; border-radius:50%; cursor:pointer;
    font-size:10px; display:flex; align-items:center; justify-content:center;
  }
  .cp-ob-close:hover { background:rgba(255,255,255,.2); }
  .cp-ob-header { display:flex; align-items:center; gap:6px; margin-bottom:9px; }
  .cp-ob-title  { font-size:14px; font-weight:800; letter-spacing:.04em; }
  .cp-ob-badge  { font-size:9px; font-weight:800; background:#4ade80; color:#0d2b1a; padding:2px 6px; border-radius:4px; }
  .cp-ob-body   { font-size:13px; line-height:1.5; opacity:.9; margin:0 0 9px; }
  .cp-ob-chips  { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:11px; }
  .cp-ob-chip   { font-size:10.5px; font-style:italic; background:rgba(255,255,255,.1); padding:3px 8px; border-radius:5px; opacity:.8; }
  .cp-ob-cta {
    width:100%; padding:9px; background:#1a7a4a; color:#fff;
    border:none; border-radius:10px; font-size:13px; font-weight:700;
    cursor:pointer; font-family:inherit; transition:background .15s;
  }
  .cp-ob-cta:hover { background:#156038; }
`;