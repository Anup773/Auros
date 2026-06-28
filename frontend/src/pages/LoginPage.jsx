
import React, { useState, useEffect } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { authAPI } from '../services/api';
import './AuthPage.css';

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTANT: Set your Google OAuth Client ID here.
// Get one at: https://console.cloud.google.com → APIs & Services → Credentials
// Authorised JS origins: http://localhost:3000
// Authorised redirect URIs: http://localhost:3000
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_CLIENT_ID = process.env.REACT_APP_GOOGLE_CLIENT_ID || '';

export default function LoginPage() {
  const navigate  = useNavigate();
  const location  = useLocation();
  const { login } = useAuth();

  const [form,          setForm]          = useState({ email: '', password: '' });
  const [error,         setError]         = useState('');
  const [loading,       setLoading]       = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [showForgot,    setShowForgot]    = useState(false);
  const [forgotEmail,   setForgotEmail]   = useState('');
  const [forgotSent,    setForgotSent]    = useState(false);
  const [forgotLoading, setForgotLoading] = useState(false);

  const from = location.state?.from?.pathname || '/dashboard';

  // Load Google Identity Services script
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    const existing = document.getElementById('gsi-script');
    if (existing) return;
    const script    = document.createElement('script');
    script.id       = 'gsi-script';
    script.src      = 'https://accounts.google.com/gsi/client';
    script.async    = true;
    script.defer    = true;
    document.body.appendChild(script);
  }, []);

  const handleChange = e => setForm({ ...form, [e.target.name]: e.target.value });

  // ── Email / password login ──────────────────────────────────────────────────
  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (!form.email || !form.password) { setError('Please fill in all fields.'); return; }
    setLoading(true);
    try {
      const data = await authAPI.login(form.email, form.password);
      login(data.user, data.token);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Google login ────────────────────────────────────────────────────────────
  const handleGoogleLogin = () => {
    if (!GOOGLE_CLIENT_ID) {
      setError('Google login is not configured. Please set REACT_APP_GOOGLE_CLIENT_ID.');
      return;
    }
    if (!window.google) {
      setError('Google Sign-In script not loaded yet. Please wait a moment and try again.');
      return;
    }

    setGoogleLoading(true);
    setError('');

    try {
      const client = window.google.accounts.oauth2.initTokenClient({
        client_id : GOOGLE_CLIENT_ID,
        scope     : 'email profile',
        callback  : async (tokenResponse) => {
          if (tokenResponse.error) {
            setError('Google sign-in was cancelled or failed.');
            setGoogleLoading(false);
            return;
          }
          try {
            const data = await authAPI.googleLogin(tokenResponse.access_token);
            login(data.user, data.token);
            navigate(from, { replace: true });
          } catch (err) {
            setError(err.message || 'Google login failed. Please try again.');
          } finally {
            setGoogleLoading(false);
          }
        },
      });
      client.requestAccessToken();
    } catch (err) {
      setError('Google sign-in initialisation failed.');
      setGoogleLoading(false);
    }
  };

  // ── Forgot password ─────────────────────────────────────────────────────────
  const handleForgot = async e => {
    e.preventDefault();
    if (!forgotEmail.trim()) return;
    setForgotLoading(true);
    await new Promise(r => setTimeout(r, 1000));
    setForgotLoading(false);
    setForgotSent(true);
  };

  return (
    <div className="auth-page">
      <div className="auth-page__bg" />

      <div className="auth-card fade-up">
        <Link to="/" className="auth-card__brand">
          auros<span className="auth-card__dot">.</span>
        </Link>

        <h1 className="auth-card__title">Welcome back</h1>
        <p className="auth-card__sub">Log in to your account to continue.</p>

        {error && <div className="auth-card__error">{error}</div>}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="auth-form__group">
            <label className="auth-form__label">Email</label>
            <input
              className="auth-input"
              type="email"
              name="email"
              placeholder="you@example.com"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
              disabled={loading}
            />
          </div>

          <div className="auth-form__group">
            <div className="auth-form__label-row">
              <label className="auth-form__label">Password</label>
              <button
                type="button"
                className="auth-form__forgot"
                onClick={() => { setShowForgot(true); setForgotSent(false); setForgotEmail(''); }}
              >
                Forgot password?
              </button>
            </div>
            <input
              className="auth-input"
              type="password"
              name="password"
              placeholder="••••••••"
              value={form.password}
              onChange={handleChange}
              autoComplete="current-password"
              disabled={loading}
            />
          </div>

          <button className="auth-btn-primary" type="submit" disabled={loading || googleLoading}>
            {loading ? 'Logging in…' : 'Log in →'}
          </button>
        </form>

        <div className="auth-card__divider"><span>or</span></div>

        <button
          className="auth-card__google"
          type="button"
          onClick={handleGoogleLogin}
          disabled={loading || googleLoading}
        >
          {googleLoading ? (
            <span style={{ fontSize: 13 }}>Connecting to Google…</span>
          ) : (
            <>
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 01-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615z" fill="#4285F4"/>
                <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 009 18z" fill="#34A853"/>
                <path d="M3.964 10.71A5.41 5.41 0 013.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 000 9c0 1.452.348 2.827.957 4.042l3.007-2.332z" fill="#FBBC05"/>
                <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 00.957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z" fill="#EA4335"/>
              </svg>
              Continue with Google
            </>
          )}
        </button>

        <p className="auth-card__switch">
          Don't have an account?{' '}
          <Link to="/signup" className="auth-card__switch-link">Sign up free</Link>
        </p>
      </div>

      {/* ── Forgot password modal ── */}
      {showForgot && (
        <div className="auth-modal-overlay" onClick={() => setShowForgot(false)}>
          <div className="auth-modal" onClick={e => e.stopPropagation()}>
            <button className="auth-modal__close" onClick={() => setShowForgot(false)}>✕</button>

            {!forgotSent ? (
              <>
                <div className="auth-modal__icon">🔑</div>
                <h2 className="auth-modal__title">Reset your password</h2>
                <p className="auth-modal__sub">
                  Enter your email address and we'll send you a link to reset your password.
                </p>
                <form onSubmit={handleForgot} className="auth-form">
                  <div className="auth-form__group">
                    <label className="auth-form__label">Email address</label>
                    <input
                      className="auth-input"
                      type="email"
                      placeholder="you@example.com"
                      value={forgotEmail}
                      onChange={e => setForgotEmail(e.target.value)}
                      autoFocus
                    />
                  </div>
                  <button className="auth-btn-primary" type="submit" disabled={forgotLoading || !forgotEmail.trim()}>
                    {forgotLoading ? 'Sending…' : 'Send reset link →'}
                  </button>
                </form>
              </>
            ) : (
              <div className="auth-modal__success">
                <div className="auth-modal__success-icon">✓</div>
                <h2 className="auth-modal__title">Check your email</h2>
                <p className="auth-modal__sub">
                  We've sent a password reset link to <strong>{forgotEmail}</strong>.
                  Check your inbox and follow the instructions.
                </p>
                <p className="auth-modal__hint">
                  Didn't receive it? Check your spam folder or{' '}
                  <button className="auth-link" onClick={() => setForgotSent(false)}>
                    try again
                  </button>.
                </p>
                <button className="auth-btn-primary" onClick={() => setShowForgot(false)}>
                  Back to login
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
