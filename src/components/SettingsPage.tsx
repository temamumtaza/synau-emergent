import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CreditSummary } from '../types';

const formatter = new Intl.NumberFormat('id-ID');

export function CreditsPage() {
  const [summary, setSummary] = useState<CreditSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [redeemToken, setRedeemToken] = useState('');
  const [redeeming, setRedeeming] = useState(false);

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

  async function redeem() {
    setRedeeming(true);
    setError('');
    setMessage('');
    try {
      const result = await api.redeemCreditToken(redeemToken);
      await loadCredits();
      setRedeemToken('');
      setMessage(result.redemption.alreadyRedeemed ? 'This token was already claimed on this account.' : `${formatter.format(result.redemption.creditsAdded)} credits added.`);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not redeem this token.');
    } finally {
      setRedeeming(false);
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

            <form className="credit-redeem" onSubmit={(event) => { event.preventDefault(); void redeem(); }}>
              <div>
                <span className="eyebrow">Reviewer access</span>
                <h3>Redeem a credit token</h3>
                <p>Enter the personal token shared with you. Each token can be claimed once per account.</p>
              </div>
              <div className="credit-redeem__controls">
                <input aria-label="Redeem token" autoCapitalize="characters" placeholder="Enter redeem token" value={redeemToken} onChange={(event) => setRedeemToken(event.target.value)} />
                <button className="button button--primary" disabled={redeeming || redeemToken.trim().length < 8} type="submit">{redeeming ? 'Redeeming' : 'Redeem token'}</button>
              </div>
            </form>

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
                  <button className="button button--secondary" disabled type="button">
                    Top up locked
                  </button>
                </article>
              ))}
            </div>

            <div className="credit-payment-status credit-payment-status--locked">
              <div><span className="eyebrow">Top-up payments</span><strong>Temporarily locked</strong><p>Payment checkout is being prepared. Reviewers can use a personal redeem token instead.</p></div>
            </div>
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
