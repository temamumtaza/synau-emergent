import { useEffect, useMemo, useRef, useState } from 'react';
import type { Roadmap } from '../types';
import { Icon } from './Icon';

type RoadmapPreviewProps = {
  creating: boolean;
  error: string;
  onApprove: () => void;
  onClose: () => void;
  roadmap: Roadmap;
};

export function RoadmapPreview({ creating, error, onApprove, onClose, roadmap }: RoadmapPreviewProps) {
  const [approved, setApproved] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const totals = useMemo(() => {
    const lessons = roadmap.sections.flatMap((section) => section.lessons);
    return {
      lessons: lessons.length,
      minutes: lessons.reduce((total, lesson) => total + lesson.estimatedMinutes, 0),
    };
  }, [roadmap]);

  useEffect(() => {
    titleRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !creating) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [creating, onClose]);

  return (
    <div className="dialog-backdrop" role="presentation">
      <section
        aria-labelledby="roadmap-title"
        aria-modal="true"
        className="roadmap-dialog"
        role="dialog"
      >
        <header className="roadmap-dialog__header">
          <div>
            <p className="eyebrow">Roadmap preview</p>
            <h2 id="roadmap-title" ref={titleRef} tabIndex={-1}>{roadmap.title}</h2>
            <p>{roadmap.description}</p>
          </div>
          <button
            aria-label="Close roadmap preview"
            className="icon-button"
            disabled={creating}
            onClick={onClose}
            type="button"
          >
            <Icon name="close" />
          </button>
        </header>

        <div className="roadmap-dialog__body">
          <div className="roadmap-summary-strip" aria-label="Roadmap summary">
            <div><strong>{roadmap.sections.length}</strong><span>Sections</span></div>
            <div><strong>{totals.lessons}</strong><span>Subchapters</span></div>
            <div><strong>{totals.minutes} min</strong><span>Estimated learning</span></div>
          </div>

          <section className="roadmap-outcomes" aria-labelledby="outcomes-title">
            <div className="section-heading-row">
              <div>
                <p className="eyebrow">What you will be able to do</p>
                <h3 id="outcomes-title">Learning outcomes</h3>
              </div>
            </div>
            <ol>
              {roadmap.outcomes.map((outcome, index) => (
                <li key={outcome}>
                  <span>{String(index + 1).padStart(2, '0')}</span>
                  <p>{outcome}</p>
                </li>
              ))}
            </ol>
          </section>

          <section className="roadmap-sections" aria-labelledby="path-title">
            <div className="section-heading-row">
              <div>
                <p className="eyebrow">Proposed sequence</p>
                <h3 id="path-title">Your learning path</h3>
              </div>
              <p>Lesson content is created only when you open a subchapter.</p>
            </div>

            <div className="roadmap-section-list">
              {roadmap.sections.map((section, sectionIndex) => (
                <article className="roadmap-section" key={section.id}>
                  <div className="roadmap-section__number">{String(sectionIndex + 1).padStart(2, '0')}</div>
                  <div className="roadmap-section__content">
                    <div className="roadmap-section__intro">
                      <div>
                        <h4>{section.title}</h4>
                        <p>{section.summary}</p>
                      </div>
                      <span>{section.lessons.length} subchapters</span>
                    </div>
                    <ol className="roadmap-lessons">
                      {section.lessons.map((lesson) => (
                        <li key={lesson.id}>
                          <span className="roadmap-lesson__marker" aria-hidden="true" />
                          <div>
                            <strong>{lesson.title}</strong>
                            <p>{lesson.summary}</p>
                          </div>
                          <span className="estimate"><Icon name="clock" size={15} />{lesson.estimatedMinutes} min</span>
                        </li>
                      ))}
                    </ol>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </div>

        <footer className="roadmap-dialog__footer">
          <label className="approval-check">
            <input
              checked={approved}
              disabled={creating}
              onChange={(event) => setApproved(event.target.checked)}
              type="checkbox"
            />
            <span className="approval-check__box"><Icon name="check" size={15} /></span>
            <span>
              <strong>I have reviewed this roadmap</strong>
              <small>Approve the sequence and create this course.</small>
            </span>
          </label>
          <div className="roadmap-actions">
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="button button--ghost" disabled={creating} onClick={onClose} type="button">Not yet</button>
            <button className="button button--primary" disabled={!approved || creating} onClick={onApprove} type="button">
              {creating ? <><span className="spinner spinner--light" />Creating course</> : <>Approve and create <Icon name="arrow-right" /></>}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
