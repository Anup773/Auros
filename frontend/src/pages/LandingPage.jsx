import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import './LandingPage.css';

const FEATURES = [
  {
    icon: '🔍',
    title: 'AI detects every issue',
    desc: 'Missing values, duplicates, format mismatches, unmatched invoices — found instantly and explained in plain English.',
  },
  {
    icon: '💬',
    title: 'AI asks before acting',
    desc: 'Instead of silently changing your data, AI asks you one clear question per issue. You decide, it executes.',
  },
  {
    icon: '✅',
    title: 'Nothing changes without you',
    desc: 'Every action shows a before/after preview with confidence score and risk level. You approve or reject each step.',
  },
  {
    icon: '📋',
    title: 'Invoice reconciliation',
    desc: 'Match invoices to POs, detect duplicate bills, flag amount mismatches — all resolved through your approvals.',
  },
  {
    icon: '📱',
    title: 'Approve via WhatsApp',
    desc: 'Away from your desk? AI sends approval questions to your WhatsApp. Reply to decide, no login needed.',
  },
  {
    icon: '📦',
    title: 'Clean output, full audit trail',
    desc: 'Download your reconciled CSV plus a complete decision log showing who approved what and when.',
  },
];

const STEPS = [
  {
    num: '01',
    title: 'Upload your data',
    desc: 'Drop in a CSV or Excel file — invoices, vendor lists, sales data, anything. Auros reads it instantly.',
  },
  {
    num: '02',
    title: 'AI interviews you',
    desc: 'For every issue found, AI asks one clear question. You answer by text, quick-pick, or WhatsApp reply.',
  },
  {
    num: '03',
    title: 'Preview before anything changes',
    desc: 'See exactly what will be modified before it happens. Approve or reject each action individually.',
  },
  {
    num: '04',
    title: 'Download clean data',
    desc: 'Execute the pipeline and get your clean file plus a full audit trail. Your original is never touched.',
  },
];

const USE_CASES = [
  {
    icon: '🧾',
    title: 'Finance & Procurement',
    items: ['Invoice vs PO reconciliation', 'Duplicate invoice detection', 'Vendor name normalization', 'Amount mismatch flagging'],
  },
  {
    icon: '📊',
    title: 'Operations & Analytics',
    items: ['CRM data cleanup', 'Sales report normalization', 'Missing value handling', 'Format standardization'],
  },
  {
    icon: '🏢',
    title: 'Enterprise Teams',
    items: ['Multi-person approval workflows', 'WhatsApp-based decisions', 'Full audit trails', 'Pipeline export for reuse'],
  },
];

export default function LandingPage() {
  const navigate = useNavigate();
  const [scrolled, setScrolled] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const handler = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', handler, { passive: true });
    return () => window.removeEventListener('scroll', handler);
  }, []);

  return (
    <div className="lp">

      {/* ── Navbar ── */}
      <nav className={`lp-nav ${scrolled ? 'lp-nav--scrolled' : ''}`}>
        <div className="lp-container lp-nav__inner">
          <div className="lp-nav__logo">
            auros<span className="lp-nav__dot">.</span>
          </div>
          <div className="lp-nav__links">
            <a href="#features" className="lp-nav__link">Features</a>
            <a href="#how"      className="lp-nav__link">How it works</a>
            <a href="#usecases" className="lp-nav__link">Use cases</a>
            <a href="#pricing"  className="lp-nav__link">Pricing</a>
          </div>
          <div className="lp-nav__actions">
            <button className="lp-btn-ghost" onClick={() => navigate('/login')}>Log in</button>
            <button className="lp-btn-primary" onClick={() => navigate('/signup')}>Start free</button>
          </div>
          <button className="lp-nav__hamburger" onClick={() => setMenuOpen(o => !o)}>
            <span /><span /><span />
          </button>
        </div>
        {menuOpen && (
          <div className="lp-nav__mobile">
            <a href="#features" onClick={() => setMenuOpen(false)}>Features</a>
            <a href="#how"      onClick={() => setMenuOpen(false)}>How it works</a>
            <a href="#pricing"  onClick={() => setMenuOpen(false)}>Pricing</a>
            <button className="lp-btn-primary" onClick={() => navigate('/signup')}>Start free</button>
          </div>
        )}
      </nav>

      {/* ── Hero ── */}
      <section className="lp-hero">
        <div className="lp-container">
          <div className="lp-hero__badge">AI-Powered Operational Decisions</div>
          <h1 className="lp-hero__title">
            Your data doesn't get cleaned.<br />
            <span className="lp-hero__accent">It gets decided.</span>
          </h1>
          <p className="lp-hero__sub">
            Auros is an AI workspace for finance and operations teams. Upload invoices or messy data,
            let AI detect every issue, answer its questions — and get clean, reconciled output
            with a full audit trail. Nothing changes without your explicit approval.
          </p>
          <div className="lp-hero__actions">
            <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/signup')}>
              Start free — no credit card
            </button>
            <a href="#how" className="lp-btn-ghost lp-btn-lg">See how it works</a>
          </div>
          <div className="lp-hero__proof">
            <div className="lp-hero__avatars">
              {['A','B','C','D','E'].map(l => <span key={l} className="lp-avatar">{l}</span>)}
            </div>
            <span className="lp-hero__proof-text">Trusted by 400+ analysts and finance teams</span>
          </div>

          {/* UI mockup strip */}
          <div className="lp-mockup">
            <div className="lp-mockup__bar">
              <span className="lp-dot lp-dot--red" />
              <span className="lp-dot lp-dot--yellow" />
              <span className="lp-dot lp-dot--green" />
              <span className="lp-mockup__title">invoices_q3.csv — Auros</span>
            </div>
            <div className="lp-mockup__phases">
              {['Upload','Analyze','AI Review','Approve','Execute'].map((p, i) => (
                <React.Fragment key={p}>
                  <span className={`lp-phase ${i === 2 ? 'lp-phase--active' : ''}`}>{p}</span>
                  {i < 4 && <span className="lp-phase__arrow">›</span>}
                </React.Fragment>
              ))}
            </div>
            <div className="lp-mockup__ai">
              <span className="lp-mockup__ai-badge">AI</span>
              <span className="lp-mockup__ai-text">
                Invoice <strong>INV-2847</strong> from <strong>Apex Supplies Ltd</strong> is{' '}
                <strong className="lp-text-warn">₹12,400 higher</strong> than the matched PO amount.
                Should I approve the invoice amount, use the PO amount, or hold for review?
              </span>
            </div>
            <div className="lp-mockup__opts">
              <span className="lp-mockup__opt lp-mockup__opt--active">Approve invoice amount</span>
              <span className="lp-mockup__opt">Use PO amount</span>
              <span className="lp-mockup__opt">Hold for review</span>
            </div>
          </div>
        </div>
      </section>

      {/* ── Problem statement ── */}
      <section className="lp-problem">
        <div className="lp-container">
          <div className="lp-problem__grid">
            <div className="lp-problem__col lp-problem__col--bad">
              <div className="lp-problem__label">❌ Without Auros</div>
              <ul>
                <li>Finance team manually cross-checks invoices in Excel</li>
                <li>Duplicate payments go unnoticed for weeks</li>
                <li>Data cleaning runs silently — you don't know what changed</li>
                <li>Approvals happen over WhatsApp messages, no record</li>
                <li>Auditors ask "who approved this?" — no answer</li>
              </ul>
            </div>
            <div className="lp-problem__col lp-problem__col--good">
              <div className="lp-problem__label">✓ With Auros</div>
              <ul>
                <li>AI matches invoices to POs in seconds</li>
                <li>Every duplicate flagged before payment</li>
                <li>Every data change requires your explicit approval</li>
                <li>WhatsApp approvals captured and logged automatically</li>
                <li>Full audit trail — who decided what and when</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* ── Features ── */}
      <section className="lp-section" id="features">
        <div className="lp-container">
          <div className="lp-section__label">What Auros does</div>
          <h2 className="lp-section__title">Built for operational decisions,<br />not just data formatting.</h2>
          <div className="lp-features__grid">
            {FEATURES.map((f, i) => (
              <div className="lp-feature-card" key={i}>
                <div className="lp-feature-card__icon">{f.icon}</div>
                <div className="lp-feature-card__title">{f.title}</div>
                <div className="lp-feature-card__desc">{f.desc}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="lp-section lp-section--gray" id="how">
        <div className="lp-container">
          <div className="lp-section__label">How it works</div>
          <h2 className="lp-section__title">Four steps.<br />Zero surprises.</h2>
          <div className="lp-steps">
            {STEPS.map((s, i) => (
              <div className="lp-step" key={i}>
                <div className="lp-step__num">{s.num}</div>
                <div className="lp-step__content">
                  <div className="lp-step__title">{s.title}</div>
                  <div className="lp-step__desc">{s.desc}</div>
                </div>
                {i < STEPS.length - 1 && <div className="lp-step__line" />}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Use cases ── */}
      <section className="lp-section" id="usecases">
        <div className="lp-container">
          <div className="lp-section__label">Use cases</div>
          <h2 className="lp-section__title">One platform.<br />Multiple workflows.</h2>
          <div className="lp-usecases__grid">
            {USE_CASES.map((uc, i) => (
              <div className="lp-usecase-card" key={i}>
                <div className="lp-usecase-card__icon">{uc.icon}</div>
                <div className="lp-usecase-card__title">{uc.title}</div>
                <ul className="lp-usecase-card__list">
                  {uc.items.map((item, j) => <li key={j}>{item}</li>)}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Pricing ── */}
      <section className="lp-section lp-section--gray" id="pricing">
        <div className="lp-container">
          <div className="lp-section__label">Pricing</div>
          <h2 className="lp-section__title">Simple and honest.</h2>
          <div className="lp-pricing__grid">

            <div className="lp-pricing-card">
              <div className="lp-pricing-card__name">Free</div>
              <div className="lp-pricing-card__price">$0<span>/mo</span></div>
              <ul className="lp-pricing-card__list">
                <li>3 cleanups or reconciliations per month</li>
                <li>Up to 5,000 rows per file</li>
                <li>Dashboard approvals</li>
                <li>CSV download</li>
              </ul>
              <button className="lp-btn-outline lp-pricing-card__btn" onClick={() => navigate('/signup')}>
                Get started free
              </button>
            </div>

            <div className="lp-pricing-card lp-pricing-card--featured">
              <div className="lp-pricing-card__badge">Most popular</div>
              <div className="lp-pricing-card__name">Pro</div>
              <div className="lp-pricing-card__price">$19<span>/mo</span></div>
              <ul className="lp-pricing-card__list">
                <li>Unlimited cleanups & reconciliations</li>
                <li>Up to 500,000 rows</li>
                <li>WhatsApp approval notifications</li>
                <li>Pipeline export (JSON)</li>
                <li>Full audit trail</li>
                <li>Priority support</li>
              </ul>
              <button className="lp-btn-primary lp-pricing-card__btn" onClick={() => navigate('/signup')}>
                Start Pro free for 14 days
              </button>
            </div>

            <div className="lp-pricing-card">
              <div className="lp-pricing-card__name">Team</div>
              <div className="lp-pricing-card__price">$49<span>/mo</span></div>
              <ul className="lp-pricing-card__list">
                <li>Everything in Pro</li>
                <li>Up to 10 team members</li>
                <li>Shared pipeline library</li>
                <li>Audit log export</li>
                <li>SSO</li>
              </ul>
              <button className="lp-btn-outline lp-pricing-card__btn" onClick={() => navigate('/signup')}>
                Contact us
              </button>
            </div>

          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section className="lp-cta">
        <div className="lp-container">
          <h2 className="lp-cta__title">Your data decisions deserve a paper trail.</h2>
          <p className="lp-cta__sub">
            Start free. No credit card. First cleanup or reconciliation in under 5 minutes.
          </p>
          <button className="lp-btn-primary lp-btn-lg" onClick={() => navigate('/signup')}>
            Get started free →
          </button>
        </div>
      </section>

      {/* ── Footer ── */}
      <footer className="lp-footer">
        <div className="lp-container lp-footer__inner">
          <div className="lp-footer__brand">
            <span className="lp-footer__logo">auros<span className="lp-nav__dot">.</span></span>
            <p className="lp-footer__tagline">AI decisions. Human approval.</p>
          </div>
          <div className="lp-footer__cols">
            <div className="lp-footer__col">
              <div className="lp-footer__col-title">Product</div>
              <a href="#features">Features</a>
              <a href="#how">How it works</a>
              <a href="#pricing">Pricing</a>
            </div>
            <div className="lp-footer__col">
              <div className="lp-footer__col-title">Account</div>
              <span onClick={() => navigate('/signup')} style={{cursor:'pointer'}}>Sign up</span>
              <span onClick={() => navigate('/login')}  style={{cursor:'pointer'}}>Log in</span>
            </div>
            <div className="lp-footer__col">
              <div className="lp-footer__col-title">Legal</div>
              <a href="#">Privacy</a>
              <a href="#">Terms</a>
            </div>
          </div>
        </div>
        <div className="lp-footer__bottom lp-container">
          © {new Date().getFullYear()} Auros. All rights reserved.
        </div>
      </footer>

    </div>
  );
}
