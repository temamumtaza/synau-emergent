import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import type { Course, Quiz, QuizScope, QuizSubmission } from '../types';
import { Icon } from './Icon';

export type QuizLaunch = {
  initialRequest: Promise<{ quiz: Quiz }>;
  scope: QuizScope;
  scopeId: string;
  scopeTitle: string;
};

type QuizPanelProps = {
  course: Course;
  launch: QuizLaunch;
  onClose: () => void;
};

const scopeLabels: Record<QuizScope, string> = {
  lesson: 'Lesson check-in',
  chapter: 'Chapter review',
  course: 'Course review',
};

export function QuizPanel({ course, launch, onClose }: QuizPanelProps) {
  const [quiz, setQuiz] = useState<Quiz | null>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [submission, setSubmission] = useState<QuizSubmission | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const titleRef = useRef<HTMLHeadingElement>(null);

  const answeredCount = Object.keys(answers).length;
  const resultMap = useMemo(() => new Map(
    submission?.results.map((result) => [result.questionId, result]) ?? [],
  ), [submission]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    launch.initialRequest
      .then(({ quiz: generatedQuiz }) => {
        if (active) {
          setQuiz(generatedQuiz);
          setError('');
        }
      })
      .catch((requestError) => {
        if (active) setError(requestError instanceof Error ? requestError.message : 'Could not create this quiz.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [launch.initialRequest]);

  useEffect(() => {
    titleRef.current?.focus();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, submitting]);

  async function generateAnother() {
    setLoading(true);
    setError('');
    setQuiz(null);
    setSubmission(null);
    setAnswers({});
    try {
      const result = await api.generateQuiz({
        course,
        scope: launch.scope,
        scopeId: launch.scopeId,
        scopeTitle: launch.scopeTitle,
      });
      setQuiz(result.quiz);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not create another quiz.');
    } finally {
      setLoading(false);
    }
  }

  async function submitQuiz() {
    if (!quiz || answeredCount !== quiz.questions.length) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.submitQuiz(quiz.id, answers);
      setSubmission(result);
      document.querySelector('.quiz-panel__body')?.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not submit your answers.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="dialog-backdrop dialog-backdrop--right" role="presentation">
      <section
        aria-labelledby="quiz-panel-title"
        aria-modal="true"
        className="quiz-panel"
        role="dialog"
      >
        <header className="quiz-panel__header">
          <div>
            <p className="eyebrow">{scopeLabels[launch.scope]}</p>
            <h2 id="quiz-panel-title" ref={titleRef} tabIndex={-1}>{launch.scopeTitle}</h2>
          </div>
          <button aria-label="Close quiz" className="icon-button" disabled={submitting} onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </header>

        <div className="quiz-panel__body">
          <div className="low-stakes-note">
            <Icon name="quiz" size={18} />
            <p><strong>Practice without pressure.</strong> Repeat this quiz whenever you want. Your score never locks course progress.</p>
          </div>

          {loading && (
            <div className="quiz-loading" aria-live="polite">
              <span className="spinner" aria-hidden="true" />
              <h3>Preparing a fresh check-in</h3>
              <p>Questions are being shaped around this {launch.scope}.</p>
              <div className="quiz-loading__skeleton" aria-hidden="true">
                <span /><span /><span />
              </div>
            </div>
          )}

          {error && !loading && !quiz && (
            <div className="inline-notice inline-notice--error" role="alert">
              <div><strong>Quiz unavailable</strong><p>{error}</p></div>
              <button className="button button--secondary" onClick={() => void generateAnother()} type="button">Try again</button>
            </div>
          )}

          {quiz && !loading && (
            <>
              {submission && (
                <section className="quiz-score" aria-live="polite">
                  <div className="quiz-score__value"><strong>{submission.score}</strong><span>/100</span></div>
                  <div>
                    <p className="eyebrow">Attempt complete</p>
                    <h3>{submission.score >= 80 ? 'Strong understanding' : submission.score >= 60 ? 'A useful foundation' : 'Keep working the ideas'}</h3>
                    <p>Review the explanations below, then repeat when you are ready.</p>
                  </div>
                </section>
              )}

              {!submission && (
                <div className="quiz-intro">
                  <h3>{quiz.title}</h3>
                  <p>{quiz.instructions}</p>
                  <span>{quiz.questions.length} questions</span>
                </div>
              )}

              <div className="quiz-questions">
                {quiz.questions.map((question, questionIndex) => {
                  const result = resultMap.get(question.id);
                  const selectedAnswer = answers[question.id];
                  return (
                    <fieldset
                      className={`quiz-question ${result ? result.correct ? 'is-correct' : 'is-incorrect' : ''}`}
                      key={question.id}
                    >
                      <legend>
                        <span>Question {questionIndex + 1} of {quiz.questions.length}</span>
                        <strong>{question.prompt}</strong>
                      </legend>
                      <div className="quiz-options">
                        {question.options.map((option, optionIndex) => {
                          const isSelected = selectedAnswer === optionIndex;
                          const isCorrectAnswer = Boolean(submission && result?.answerIndex === optionIndex);
                          const isWrongSelection = Boolean(submission && isSelected && !result?.correct);
                          return (
                            <label
                              className={`quiz-option ${isSelected ? 'is-selected' : ''} ${isCorrectAnswer ? 'is-answer' : ''} ${isWrongSelection ? 'is-wrong' : ''}`}
                              key={option}
                            >
                              <input
                                checked={isSelected}
                                disabled={Boolean(submission)}
                                name={question.id}
                                onChange={() => setAnswers((current) => ({ ...current, [question.id]: optionIndex }))}
                                type="radio"
                                value={optionIndex}
                              />
                              <span className="quiz-option__letter">{String.fromCharCode(65 + optionIndex)}</span>
                              <span className="quiz-option__text">{option}</span>
                              {isCorrectAnswer && <span className="quiz-option__status"><Icon name="check" size={15} />Correct</span>}
                            </label>
                          );
                        })}
                      </div>
                      {result && (
                        <div className="answer-feedback">
                          <strong>{result.correct ? 'Correct' : 'Not quite'}</strong>
                          <p>{result.explanation}</p>
                        </div>
                      )}
                    </fieldset>
                  );
                })}
              </div>
            </>
          )}
        </div>

        {quiz && !loading && (
          <footer className="quiz-panel__footer">
            {error && <p className="form-error" role="alert">{error}</p>}
            {submission ? (
              <>
                <button className="button button--ghost" onClick={onClose} type="button">Close review</button>
                <button className="button button--primary" onClick={() => void generateAnother()} type="button">
                  Generate another quiz <Icon name="arrow-right" />
                </button>
              </>
            ) : (
              <>
                <p>{answeredCount} of {quiz.questions.length} answered</p>
                <button
                  className="button button--primary"
                  disabled={answeredCount !== quiz.questions.length || submitting}
                  onClick={() => void submitQuiz()}
                  type="button"
                >
                  {submitting ? <><span className="spinner spinner--light" />Checking answers</> : <>Submit answers <Icon name="arrow-right" /></>}
                </button>
              </>
            )}
          </footer>
        )}
      </section>
    </div>
  );
}
