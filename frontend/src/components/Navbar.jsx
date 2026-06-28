import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import './Navbar.css';

export default function Navbar() {
  const [scrolled,     setScrolled]     = useState(false);
  const [menuOpen,     setMenuOpen]     = useState(false);
  const { isLoggedIn, logout }          = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);

  // Close mobile menu on route change or outside click
  useEffect(() => {
    if (menuOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [menuOpen]);

  function handleLogout() {
    logout();
    navigate('/');
    setMenuOpen(false);
  }

  return (
    <>
      <nav className={`navbar ${scrolled ? 'navbar--scrolled' : ''}`}>
        <div className="navbar__inner container">
          <Link to="/" className="navbar__logo" onClick={() => setMenuOpen(false)}>
            auros<span className="navbar__dot">.</span>
          </Link>

          {/* Desktop links */}
          <div className="navbar__links">
            <a href="#features" className="navbar__link">Features</a>
            <a href="#how"      className="navbar__link">How it works</a>
            <a href="#pricing"  className="navbar__link">Pricing</a>
          </div>

          {/* Desktop actions */}
          <div className="navbar__actions">
            {isLoggedIn ? (
              <>
                <button className="btn-ghost navbar__login" onClick={() => navigate('/dashboard')}>
                  Dashboard
                </button>
                <button className="btn-ghost navbar__login" onClick={handleLogout}>
                  Log out
                </button>
              </>
            ) : (
              <>
                <button className="btn-ghost navbar__login" onClick={() => navigate('/login')}>
                  Log in
                </button>
                <button className="btn-primary" onClick={() => navigate('/signup')}>
                  Start free
                </button>
              </>
            )}
          </div>

          {/* Mobile hamburger */}
          <button
            className={`navbar__hamburger ${menuOpen ? 'navbar__hamburger--open' : ''}`}
            onClick={() => setMenuOpen(o => !o)}
            aria-label="Toggle menu"
          >
            <span /><span /><span />
          </button>
        </div>
      </nav>

      {/* Mobile menu overlay */}
      <div className={`navbar__mobile ${menuOpen ? 'navbar__mobile--open' : ''}`}>
        <a href="#features" className="navbar__mobile-link" onClick={() => setMenuOpen(false)}>Features</a>
        <a href="#how"      className="navbar__mobile-link" onClick={() => setMenuOpen(false)}>How it works</a>
        <a href="#pricing"  className="navbar__mobile-link" onClick={() => setMenuOpen(false)}>Pricing</a>
        <div className="navbar__mobile-divider" />
        {isLoggedIn ? (
          <>
            <button className="navbar__mobile-link" onClick={() => { navigate('/dashboard'); setMenuOpen(false); }}>
              Dashboard
            </button>
            <button className="navbar__mobile-link" onClick={handleLogout}>Log out</button>
          </>
        ) : (
          <>
            <button className="navbar__mobile-link" onClick={() => { navigate('/login'); setMenuOpen(false); }}>
              Log in
            </button>
            <button className="btn-primary navbar__mobile-cta" onClick={() => { navigate('/signup'); setMenuOpen(false); }}>
              Start free
            </button>
          </>
        )}
      </div>
    </>
  );
}
