import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
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

export default function SignupPage() {
  const navigate  = useNavigate();
  const { login } = useAuth();

  const [form,          setForm]          = useState({ name: '', email: '', password: '' });
  const [error,         setError]         = useState('');
  const [loading,       setLoading]       = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

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

  // ── Email / password signup ─────────────────────────────────────────────────
  const handleSubmit = async e => {
    e.preventDefault();
    setError('');
    if (!form.name || !form.email || !form.password) { setError('Please fill in all fields.'); return; }
    if (form.password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    setLoading(true);
    try {
      const data = await authAPI.signup(form.name, form.email, form.password);
      login(data.user, data.token);
      navigate('/dashboard', { replace: true });
    } catch (err) {
      setError(err.message || 'Signup failed. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  // ── Google signup / login ───────────────────────────────────────────────────
  const handleGoogleSignup = () => {
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
            navigate('/dashboard', { replace: true });
          } catch (err) {
            setError(err.message || 'Google sign-up failed. Please try again.');
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

  return (
    <div className="auth-page">
      <div className="auth-page__bg" />

      <div className="auth-card fade-up">
        <Link to="/" className="auth-card__brand">
          auros<span className="auth-card__dot">.</span>
        </Link>

        <h1 className="auth-card__title">Create your account</h1>
        <p className="auth-card__sub">Free forever. No credit card required.</p>

        {error && <div className="auth-card__error">{error}</div>}

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="auth-form__group">
            <label className="auth-form__label">Full name</label>
            <input
              className="auth-input"
              type="text"
              name="name"
              placeholder="Your name"
              value={form.name}
              onChange={handleChange}
              autoComplete="name"
              disabled={loading}
            />
          </div>

          <div className="auth-form__group">
            <label className="auth-form__label">Work email</label>
            <input
              className="auth-input"
              type="email"
              name="email"
              placeholder="you@company.com"
              value={form.email}
              onChange={handleChange}
              autoComplete="email"
              disabled={loading}
            />
          </div>

          <div className="auth-form__group">
            <label className="auth-form__label">Password</label>
            <input
              className="auth-input"
              type="password"
              name="password"
              placeholder="At least 8 characters"
              value={form.password}
              onChange={handleChange}
              autoComplete="new-password"
              disabled={loading}
            />
          </div>

          <button className="auth-btn-primary" type="submit" disabled={loading || googleLoading}>
            {loading ? 'Creating account…' : 'Create account →'}
          </button>
        </form>

        <div className="auth-card__divider"><span>or</span></div>

        <button
          className="auth-card__google"
          type="button"
          onClick={handleGoogleSignup}
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

        <p className="auth-card__terms">
          By signing up you agree to our <a href="#">Terms</a> and <a href="#">Privacy Policy</a>.
        </p>

        <p className="auth-card__switch">
          Already have an account?{' '}
          <Link to="/login" className="auth-card__switch-link">Log in</Link>
        </p>
      </div>
    </div>
  );
}