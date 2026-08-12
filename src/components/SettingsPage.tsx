import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CreditSummary, TopUpResponse } from '../types';
import { Icon } from './Icon';

declare global {
  interface Window {
    snap?: {
      pay: (token: string, callbacks: {
        onSuccess?: () => void;
        onPending?: () => void;
        onError?: () => void;
        onClose?: () => void;
      }) => void;
    };
  }
}

const formatter = new Intl.NumberFormat('id-ID');

function loadSnapScript(topUp: TopUpResponse) {
  return new Promise<void>((resolve, reject) => {
    if (window.snap) {
      resolve();
      return;
    }
    const existing = document.getElementById('midtrans-snap-script') as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('Midtrans checkout could not be loaded.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.id = 'midtrans-snap-script';
    script.src = topUp.environment === 'production'
      ? 'https://app.midtrans.com/snap/snap.js'
      : 'https://app.sandbox.midtrans.com/snap/snap.js';
    script.dataset.clientKey = topUp.clientKey;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Midtrans checkout could not be loaded.'));
    document.body.appendChild(script);
  });
}

export function CreditsPage() {
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [topUp, setTopUp] = useState<TopUpResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');

  async function loadCredits() {
    const result = await api.credits();
    setSummary(result.credits);
  }

  useEffect(() => {
    let active = true;
    api.credits()
      .then((result) => {
        if (active) setSummary(result.credits);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load credits.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  async function refreshStatus(topUpId: string) {
    setRefreshing(true);
    try {
      const result = await api.creditTopUpStatus(topUpId);
      setSummary(result.credits);
      setMessage(result.status === 'paid' ? 'Payment confirmed. Credits have been added.' : 'Payment is still waiting for confirmation.');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not refresh payment status.');
    } finally {
      setRefreshing(false);
    }
  }

  async function startTopUp(productId: string) {
    setBusy(true);
    setError('');
    setMessage('');
    let createdTopUp: TopUpResponse | null = null;
    try {
      const result = await api.createCreditTopUp(productId);
      createdTopUp = result.topUp;
      setTopUp(createdTopUp);
      await loadSnapScript(createdTopUp);
      if (!window.snap) throw new Error('Midtrans checkout is unavailable in this browser.');
      window.snap.pay(createdTopUp.snapToken, {
        onSuccess: () => void refreshStatus(createdTopUp!.topUpId),
        onPending: () => setMessage('Payment is pending. You can refresh the status after completing it.'),
        onError: () => setError('Midtrans could not complete this payment.'),
        onClose: () => setMessage('Checkout closed. If you completed payment, refresh its status below.'),
      });
    } catch (requestError) {
      const fallbackUrl = createdTopUp?.redirectUrl;
      if (fallbackUrl) window.location.assign(fallbackUrl);
      else setError(requestError instanceof Error ? requestError.message : 'Could not start the credit top-up.');
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <section className="page page--narrow settings-loading" aria-live="polite">
        <span className="spinner" />
        <p>Loading credits</p>
      </section>
    );
  }

  const products = summary?.products ?? [];

  return (
    <div className="page settings-page">
      <header className="page-header page-header--split">
        <div>
          <p className="eyebrow">Account balance</p>
          <h1>Credits</h1>
          <p>Manage your Synau balance and keep learning without losing your place.</p>
        </div>
        <span className="connection-status is-configured"><i />Backend billing active</span>
      </header>

      {error && <div className="inline-notice inline-notice--error" role="alert"><div><strong>Something needs attention</strong><p>{error}</p></div></div>}
      {message && <div className="inline-notice" role="status"><div><strong>{message}</strong><p>Payment notifications are processed server-side.</p></div></div>}

      <div className="settings-layout">
        <section className="settings-form credit-panel" aria-labelledby="credit-panel-title">
          <div className="settings-form__header">
            <div>
              <h2 id="credit-panel-title">Your credits</h2>
              <p>Credits are platform currency, separate from Indonesian rupiah.</p>
            </div>
            <span>WALLET</span>
          </div>
          <div className="settings-form__fields">
            <div className="credit-balance-card">
              <span>Available balance</span>
              <strong>{formatter.format(summary?.balance ?? 0)}</strong>
              <small>credits</small>
            </div>

            <div className="credit-products" aria-label="Credit top-up packages">
              <div className="credit-products__intro">
                <div>
                  <span className="eyebrow">Choose a package</span>
                  <p>All packages use the same base rate. Larger packages include more bonus credits.</p>
                </div>
                <strong>New account: +100 free</strong>
              </div>
              {products.map((product, index) => (
                <article className={`credit-product ${index === products.length - 1 ? 'credit-product--featured' : ''}`} key={product.id}>
                  <div className="credit-product__details">
                    {index === products.length - 1 && <span className="credit-product__badge">Best value</span>}
                    <strong>{product.label}</strong>
                    <p>{formatter.format(product.baseCredits)} base credits{product.bonusCredits > 0 ? ` + ${formatter.format(product.bonusCredits)} bonus` : ''}</p>
                  </div>
                  <div className="credit-product__price">
                    <strong>Rp{formatter.format(product.amountIdr)}</strong>
                    <small>{formatter.format(product.credits)} credits total</small>
                  </div>
                  <button className="button button--primary" disabled={busy} onClick={() => void startTopUp(product.id)} type="button">
                    {busy ? <><span className="spinner spinner--light" />Opening checkout</> : <>Top up with Midtrans <Icon name="arrow-right" /></>}
                  </button>
                </article>
              ))}
            </div>

            {topUp && (
              <div className="credit-payment-status">
                <div>
                  <span className="eyebrow">Latest top-up</span>
                  <strong>{topUp.orderId}</strong>
                  <p>Status is confirmed by the Midtrans notification endpoint.</p>
                </div>
                <button className="button button--secondary" disabled={refreshing} onClick={() => void refreshStatus(topUp.topUpId)} type="button">
                  {refreshing ? 'Refreshing' : 'Refresh status'}
                </button>
              </div>
            )}
          </div>
        </section>

        <aside className="settings-aside">
          <section>
            <span className="aside-index">01</span>
            <div>
              <h3>Fixed provider</h3>
              <p>{summary?.provider.displayName} runs the Synau generators through the backend. The browser never receives the provider API key.</p>
              <code>{summary?.provider.model}</code>
            </div>
          </section>
          <section>
            <span className="aside-index">02</span>
            <div>
              <h3>Simple pricing</h3>
              <p>Each successful roadmap, lesson, or quiz generator costs exactly 1 credit. Failed, timed-out, or invalid generations are returned automatically.</p>
            </div>
          </section>
          <div className="settings-aside__note">
            <strong>Welcome credit</strong>
            <code>New accounts: +100 credits</code>
            <p>Token usage is recorded for diagnostics, but it never changes the 1-credit generator charge.</p>
          </div>
        </aside>
      </div>

      <section className="credit-history" aria-labelledby="credit-history-title">
        <div className="section-heading-row">
          <div><p className="eyebrow">Ledger</p><h2 id="credit-history-title">Recent activity</h2></div>
        </div>
        <div className="credit-history__list">
          {(summary?.recentTransactions ?? []).map((transaction) => (
            <div className="credit-history__row" key={transaction.id}>
              <div><strong>{transaction.description}</strong><small>{new Date(transaction.createdAt).toLocaleString()}</small></div>
              <span className={transaction.delta >= 0 ? 'is-positive' : 'is-negative'}>{transaction.delta >= 0 ? '+' : ''}{formatter.format(transaction.delta)}</span>
            </div>
          ))}
          {(summary?.recentTransactions.length ?? 0) === 0 && <p className="field-help">No credit activity yet.</p>}
        </div>
      </section>
    </div>
  );
}
