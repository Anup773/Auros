/**
 * frontend/src/pages/BillingPage.jsx
 *
 * Pricing and subscription management page.
 * Shows plans, current subscription status, upgrade/cancel options.
 *
 * Route: /billing  (add to App.jsx routes)
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { billingAPI } from '../services/api';
import './BillingPage.css';

const FEATURE_ICONS = {
  'Up to 50 invoices/month'  : '📄',
  'Up to 500 invoices/month' : '📄',
  'Up to 5,000 invoices/month': '📄',
  'Up to 10,000 invoices/month': '📄',
  'Unlimited invoices'        : '♾️',
  'CSV, XLSX, XML uploads'    : '📁',
  'AI reconciliation'         : '🤖',
  'Voice commands'            : '🎙️',
  'PDF & image OCR'           : '🔍',
  'WhatsApp approvals'        : '📱',
  'Audit trails'              : '📋',
  'Priority support'          : '⚡',
  'Email support'             : '📧',
  'All Starter features'      : '✓',
  'All Growth features'       : '✓',
  'Custom integrations'       : '🔧',
  'Dedicated support'         : '👤',
  'SLA guarantee'             : '🛡️',
  'On-premise option'         : '🏢',
  'SSO'                       : '🔐',
  'Advanced RBAC'             : '🔑',
};

export default function BillingPage() {
  const { token, user } = useAuth();
  const navigate         = useNavigate();

  const [plans, setPlans]               = useState([]);
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading]           = useState(true);
  const [checkoutLoading, setCheckoutLoading] = useState(null); // planId being processed
  const [error, setError]               = useState('');
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [billingInterval, setBillingInterval] = useState('month'); // 'month' | 'year'

  useEffect(() => {
    loadData();
  }, [token]);

  async function loadData() {
    setLoading(true);
    try {
      const [plansRes, subRes] = await Promise.all([
        billingAPI.getPlans(token),
        billingAPI.getSubscription(token),
      ]);
      setPlans(plansRes.plans || []);
      setSubscription(subRes.subscription);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckout(planId) {
    if (planId === 'enterprise') {
      window.open('mailto:hello@auros.app?subject=Enterprise Plan Enquiry', '_blank');
      return;
    }
    setCheckoutLoading(planId);
    setError('');
    try {
      const { checkoutUrl } = await billingAPI.createCheckout(planId, token);
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err.message);
      setCheckoutLoading(null);
    }
  }

  async function handleCancel() {
    try {
      await billingAPI.cancelSubscription(token);
      setCancelConfirm(false);
      await loadData();
    } catch (err) {
      setError(err.message);
    }
  }

  async function handlePortal() {
    try {
      const { portalUrl } = await billingAPI.getPortalUrl(token);
      window.open(portalUrl, '_blank');
    } catch (err) {
      setError(err.message);
    }
  }

  const currentPlanId = subscription?.plan || null;
  const isActive      = subscription?.active;

  if (loading) return (
    <BillingShell>
      <div className="billing-loading">
        <div className="billing-spinner" />
        <p>Loading billing information…</p>
      </div>
    </BillingShell>
  );

  return (
    <BillingShell>
      <div className="billing-page">

        {/* ── Header ── */}
        <div className="billing-header">
          <button className="billing-back" onClick={() => navigate('/dashboard')}>
            ← Back to Dashboard
          </button>
          <h1 className="billing-title">Plans & Billing</h1>
          <p className="billing-sub">
            Simple, transparent pricing. No per-user fees. Cancel anytime.
          </p>

          {/* Billing interval toggle */}
          <div className="billing-interval-toggle">
            <button
              className={`billing-interval-btn ${billingInterval === 'month' ? 'active' : ''}`}
              onClick={() => setBillingInterval('month')}
            >
              Monthly
            </button>
            <button
              className={`billing-interval-btn ${billingInterval === 'year' ? 'active' : ''}`}
              onClick={() => setBillingInterval('year')}
            >
              Yearly
              <span className="billing-save-badge">Save 20%</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="billing-error">
            ⚠ {error}
            <button onClick={() => setError('')}>✕</button>
          </div>
        )}

        {/* ── Current subscription banner ── */}
        {isActive && subscription && (
          <div className="billing-current-sub">
            <div className="billing-current-sub__left">
              <span className="billing-current-sub__badge">
                {subscription.status === 'trialing' ? '🎁 Trial' : '✓ Active'}
              </span>
              <div>
                <div className="billing-current-sub__plan">
                  {subscription.plan?.charAt(0).toUpperCase() + subscription.plan?.slice(1)} Plan
                </div>
                <div className="billing-current-sub__detail">
                  {subscription.status === 'canceling'
                    ? `Cancels on ${_formatDate(subscription.currentPeriodEnd)}`
                    : `Renews ${_formatDate(subscription.renewsAt)}`}
                </div>
              </div>
            </div>
            <div className="billing-current-sub__actions">
              <button className="billing-portal-btn" onClick={handlePortal}>
                Manage Billing ↗
              </button>
              {subscription.status !== 'canceling' && (
                <button
                  className="billing-cancel-link"
                  onClick={() => setCancelConfirm(true)}
                >
                  Cancel plan
                </button>
              )}
            </div>
          </div>
        )}

        {/* ── Cancel confirmation ── */}
        {cancelConfirm && (
          <div className="billing-cancel-confirm">
            <p>Are you sure? Your subscription will remain active until the end of the billing period.</p>
            <div className="billing-cancel-confirm__btns">
              <button className="billing-btn-danger"  onClick={handleCancel}>Yes, cancel</button>
              <button className="billing-btn-ghost"   onClick={() => setCancelConfirm(false)}>Keep plan</button>
            </div>
          </div>
        )}

        {/* ── Pricing cards ── */}
        <div className="billing-plans-grid">
          {/* Free tier */}
          <PricingCard
            plan={{
              id         : 'free',
              name       : 'Free',
              price      : 0,
              currency   : 'USD',
              description: 'Try Auros with no commitment',
              features   : [
                'Up to 50 invoices/month',
                'CSV, XLSX, XML uploads',
                'AI reconciliation',
                'Email support',
              ],
            }}
            isCurrent={!isActive}
            interval={billingInterval}
            onSelect={() => navigate('/dashboard')}
            ctaLabel="Get started free"
            isPopular={false}
          />

          {plans.filter(p => !p.isEnterprise).map(plan => (
            <PricingCard
              key={plan.id}
              plan={plan}
              isCurrent={currentPlanId === plan.id && isActive}
              interval={billingInterval}
              isPopular={plan.id === 'growth'}
              loading={checkoutLoading === plan.id}
              onSelect={() => handleCheckout(plan.id)}
              ctaLabel={
                currentPlanId === plan.id && isActive ? 'Current plan' :
                isActive ? 'Switch plan' : 'Start free trial'
              }
            />
          ))}

          {/* Enterprise */}
          {plans.filter(p => p.isEnterprise).map(plan => (
            <PricingCard
              key={plan.id}
              plan={plan}
              isCurrent={currentPlanId === plan.id && isActive}
              interval={billingInterval}
              isPopular={false}
              onSelect={() => handleCheckout(plan.id)}
              ctaLabel="Contact sales"
              isEnterprise
            />
          ))}
        </div>

        {/* ── FAQ ── */}
        <div className="billing-faq">
          <h2 className="billing-faq__title">Frequently asked questions</h2>
          <div className="billing-faq__grid">
            {FAQ_ITEMS.map((item, i) => (
              <div key={i} className="billing-faq__item">
                <div className="billing-faq__q">{item.q}</div>
                <div className="billing-faq__a">{item.a}</div>
              </div>
            ))}
          </div>
        </div>

      </div>
    </BillingShell>
  );
}

// ── PricingCard component ──────────────────────────────────────────────────────
function PricingCard({ plan, isCurrent, interval, isPopular, isEnterprise, loading, onSelect, ctaLabel }) {
  const yearlyPrice = plan.price ? Math.round(plan.price * 12 * 0.8) : null;
  const displayPrice = interval === 'year' && yearlyPrice
    ? Math.round(yearlyPrice / 12)
    : plan.price;

  return (
    <div className={`billing-card ${isPopular ? 'billing-card--popular' : ''} ${isCurrent ? 'billing-card--current' : ''}`}>
      {isPopular && <div className="billing-card__popular-badge">Most popular</div>}

      <div className="billing-card__header">
        <div className="billing-card__name">{plan.name}</div>
        <div className="billing-card__desc">{plan.description}</div>
      </div>

      <div className="billing-card__price">
        {isEnterprise ? (
          <div className="billing-card__price-custom">Custom pricing</div>
        ) : displayPrice === 0 ? (
          <div className="billing-card__price-free">Free</div>
        ) : (
          <>
            <span className="billing-card__price-currency">$</span>
            <span className="billing-card__price-amount">{displayPrice}</span>
            <span className="billing-card__price-period">/month</span>
          </>
        )}
        {interval === 'year' && yearlyPrice && (
          <div className="billing-card__price-yearly">
            ${yearlyPrice}/year — save ${plan.price * 12 - yearlyPrice}
          </div>
        )}
      </div>

      <ul className="billing-card__features">
        {plan.features.map((feature, i) => (
          <li key={i} className="billing-card__feature">
            <span className="billing-card__feature-icon">
              {FEATURE_ICONS[feature] || '✓'}
            </span>
            {feature}
          </li>
        ))}
      </ul>

      <button
        className={`billing-card__cta ${isCurrent ? 'billing-card__cta--current' : ''} ${isPopular ? 'billing-card__cta--popular' : ''}`}
        onClick={onSelect}
        disabled={isCurrent || loading}
      >
        {loading ? <span className="billing-btn-spinner" /> : ctaLabel}
      </button>
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────────────────
function BillingShell({ children }) {
  return <div className="billing-shell">{children}</div>;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function _formatDate(dateStr) {
  if (!dateStr) return 'N/A';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric',
    });
  } catch {
    return dateStr;
  }
}

const FAQ_ITEMS = [
  {
    q: 'What counts as an invoice?',
    a: 'Each uploaded document (CSV row, PDF, or image) processed through reconciliation counts as one invoice.',
  },
  {
    q: 'Can I upgrade or downgrade anytime?',
    a: 'Yes. Changes take effect immediately. If you upgrade mid-cycle, you pay the prorated difference.',
  },
  {
    q: 'Is there a free trial?',
    a: 'Yes — paid plans include a 14-day free trial. No credit card required to start.',
  },
  {
    q: 'What payment methods do you accept?',
    a: 'All major credit/debit cards, PayPal, and local payment methods via Paddle.',
  },
  {
    q: 'Is my financial data secure?',
    a: 'Yes. All data is encrypted in transit and at rest. We never share your invoice data with third parties.',
  },
  {
    q: 'Do you offer refunds?',
    a: 'Yes — 30-day money-back guarantee on all paid plans if you\'re not satisfied.',
  },
];
