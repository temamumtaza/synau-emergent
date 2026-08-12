import { useEffect, useState } from 'react';
import { api } from '../api';
import type { ProductProgress } from '../types';
import { Icon } from './Icon';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

const statusLabel = {
  pass: 'Pass',
  'in-progress': 'In progress',
  gap: 'Gap',
} as const;

export function ProductProgressPage() {
  const [progress, setProgress] = useState<ProductProgress | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    api.productProgress()
      .then((result) => {
        if (active) setProgress(result);
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not load product quality progress.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

  if (loading) {
    return (
      <section className="page page--narrow quality-loading" aria-live="polite">
        <span className="spinner" />
        <p>Loading current product evidence</p>
      </section>
    );
  }

  if (error || !progress) {
    return (
      <section className="page page--narrow empty-page">
        <p className="eyebrow">Product quality</p>
        <h1>Progress data is unavailable.</h1>
        <p>{error || 'No progress report was returned.'}</p>
        <button className="button button--primary" onClick={() => window.location.reload()} type="button">Try again</button>
      </section>
    );
  }

  return (
    <div className="page quality-page">
      <header className="page-header page-header--split quality-header">
        <div>
          <p className="eyebrow">Product quality</p>
          <h1>Measured against the learner experience.</h1>
          <p>This page reports the latest product evidence, including gaps that still need a real browser pass.</p>
        </div>
        <div className="quality-updated"><span>Last updated</span><strong>{formatDate(progress.updatedAt)}</strong></div>
      </header>

      <section className="quality-overview" aria-labelledby="quality-score-title">
        <div className="quality-score">
          <div className="quality-score__number">
            <strong>{progress.overall}</strong><span>/100</span>
          </div>
          <div>
            <p className="eyebrow">Overall readiness</p>
            <h2 id="quality-score-title">Current product progress</h2>
            <p>Evidence-backed completion, not a release confidence score.</p>
          </div>
        </div>
        <div className="quality-meter" aria-label={`${progress.overall}% overall product progress`}>
          <span style={{ width: `${progress.overall}%` }} />
        </div>
        <div className="quality-comparison-bar">
          <span>Comparison bar</span>
          <p>{progress.comparisonBar}</p>
        </div>
      </section>

      <div className="quality-grid">
        <section className="comparison-card" aria-labelledby="comparison-title">
          <div className="quality-card-heading">
            <div><p className="eyebrow">Current comparison</p><h2 id="comparison-title">{progress.currentComparison.target}</h2></div>
            <span className="quality-card-index">01</span>
          </div>
          <dl>
            <div><dt>Result</dt><dd>{progress.currentComparison.result}</dd></div>
            <div><dt>Evidence</dt><dd>{progress.currentComparison.evidence}</dd></div>
          </dl>
        </section>

        <section className="gap-card" aria-labelledby="gap-title">
          <div className="quality-card-heading">
            <div><p className="eyebrow">Priority gap</p><h2 id="gap-title">Biggest remaining gap</h2></div>
            <span className="quality-card-index">02</span>
          </div>
          <p>{progress.biggestGap}</p>
          <div><span>Next focus</span><strong>Validate the lived browser experience</strong></div>
        </section>
      </div>

      <section className="quality-results" aria-labelledby="results-title">
        <div className="section-heading-row">
          <div><p className="eyebrow">Latest evidence</p><h2 id="results-title">Product results</h2></div>
          <p>{progress.latestResults.length} tracked areas</p>
        </div>
        <div className="results-table" role="table" aria-label="Latest product quality results">
          <div className="results-table__head" role="row">
            <span role="columnheader">Area</span><span role="columnheader">Status</span><span role="columnheader">Result</span><span role="columnheader">Checked</span>
          </div>
          {progress.latestResults.map((result) => (
            <div className="results-table__row" key={`${result.area}-${result.timestamp}`} role="row">
              <strong role="cell">{result.area}</strong>
              <span role="cell"><i className={`result-status result-status--${result.status}`}><b />{statusLabel[result.status]}</i></span>
              <p role="cell">{result.result}</p>
              <time dateTime={result.timestamp} role="cell">{formatDate(result.timestamp)}</time>
            </div>
          ))}
        </div>
      </section>

      <footer className="quality-footer-note">
        <Icon name="quality" size={19} />
        <p><strong>How to read this page</strong> Progress only moves with concrete evidence. A passing contract or build does not claim visual quality, usability, or production readiness.</p>
      </footer>
    </div>
  );
}
