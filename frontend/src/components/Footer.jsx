import React from 'react';
import { Link } from 'react-router-dom';
import './Footer.css';

export default function Footer() {
  return (
    <footer className="footer">
      <div className="footer__inner container">
        <div className="footer__brand">
          <span className="footer__logo">Auros<span className="footer__dot">.</span></span>
          <p className="footer__tagline">Clean data. Clear mind.</p>
        </div>
        <div className="footer__cols">
          <div className="footer__col">
            <div className="footer__col-title">Product</div>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="footer__col">
            <div className="footer__col-title">Account</div>
            <Link to="/signup">Sign up</Link>
            <Link to="/login">Log in</Link>
          </div>
          <div className="footer__col">
            <div className="footer__col-title">Legal</div>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </div>
        </div>
      </div>
      <div className="footer__bottom container">
        <span>© {new Date().getFullYear()} Auros. All rights reserved.</span>
      </div>
    </footer>
  );
}