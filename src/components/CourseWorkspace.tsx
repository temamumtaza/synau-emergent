import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { Course, CourseLesson, CourseSection, LessonMaterial, LessonNode, LessonWithSection, QuizScope } from '../types';
import { Icon } from './Icon';
import { QuizPanel, type QuizLaunch } from './QuizPanel';

type CourseWorkspaceProps = {
  courseId: string;
  onBack: () => void;
};

function flattenCourse(course: Course): LessonWithSection[] {
  return course.sections.flatMap((section) => section.lessons.map((lesson) => ({ lesson, section })));
}

function LessonLoading({ lesson }: { lesson: CourseLesson }) {
  return (
    <div className="lesson-loading" aria-live="polite">
      <div className="lesson-loading__status">
        <span className="spinner" aria-hidden="true" />
        <div>
          <p className="eyebrow">Generating this lesson</p>
          <h2>Shaping a focused subchapter</h2>
          <p>Synau is using the roadmap and earlier course context to avoid unnecessary repetition.</p>
        </div>
      </div>
      <div className="lesson-loading__steps" aria-hidden="true">
        <span className="is-active"><i />Reading the lesson brief</span>
        <span><i />Building the explanation</span>
        <span><i />Adding reflection and takeaway</span>
      </div>
      <div className="lesson-skeleton" aria-hidden="true">
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line skeleton--short" />
        <div />
        <span className="skeleton skeleton--title" />
        <span className="skeleton skeleton--line" />
        <span className="skeleton skeleton--line" />
      </div>
      <p className="lesson-loading__lesson">Preparing “{lesson.title}”</p>
    </div>
  );
}

function SectionRail({
  course,
  onQuiz,
  onSelectLesson,
  selectedLessonId,
}: {
  course: Course;
  onQuiz: (scope: QuizScope, scopeId: string, scopeTitle: string) => void;
  onSelectLesson: (lessonId: string) => void;
  selectedLessonId: string;
}) {
  return (
    <aside className="course-rail" aria-label="Course sections">
      <div className="course-rail__progress">
        <div>
          <span>Course progress</span>
          <strong>{course.progress.percent}%</strong>
        </div>
        <div className="progress-track" aria-label={`${course.progress.percent}% complete`}>
          <span style={{ width: `${course.progress.percent}%` }} />
        </div>
        <p>{course.progress.completedLessons} of {course.progress.totalLessons} subchapters complete</p>
      </div>

      <div className="section-rail-list">
        {course.sections.map((section, sectionIndex) => {
          const completed = section.lessons.filter((lesson) => lesson.completedAt).length;
          return (
            <details className="rail-section" key={section.id} open>
              <summary>
                <span className="rail-section__number">{String(sectionIndex + 1).padStart(2, '0')}</span>
                <span><strong>{section.title}</strong><small>{completed}/{section.lessons.length} complete</small></span>
                <Icon name="chevron-down" size={16} />
              </summary>
              <div className="rail-lessons">
                {section.lessons.map((lesson, lessonIndex) => (
                  <button
                    aria-current={selectedLessonId === lesson.id ? 'step' : undefined}
                    className={selectedLessonId === lesson.id ? 'is-active' : ''}
                    key={lesson.id}
                    onClick={() => onSelectLesson(lesson.id)}
                    type="button"
                  >
                    <span className={`lesson-state ${lesson.completedAt ? 'is-complete' : ''}`}>
                      {lesson.completedAt ? <Icon name="check" size={13} /> : lessonIndex + 1}
                    </span>
                    <span><strong>{lesson.title}</strong><small>{lesson.estimatedMinutes} min</small></span>
                  </button>
                ))}
                <button className="rail-quiz-button" onClick={() => onQuiz('chapter', section.id, section.title)} type="button">
                  <Icon name="quiz" size={15} />
                  <span><strong>Chapter quiz</strong><small>Repeat anytime</small></span>
                </button>
              </div>
            </details>
          );
        })}
      </div>
    </aside>
  );
}

function DataLab({ dataLab }: { dataLab: NonNullable<LessonMaterial['dataLab']> }) {
  const [workedReadingRevealed, setWorkedReadingRevealed] = useState(false);
  const titleId = useId();
  const workedReadingId = useId();

  return (
    <section className="data-lab" aria-labelledby={titleId}>
      <div className="data-lab__header">
        <div>
          <h2 id={titleId}>{dataLab.title}</h2>
        </div>
      </div>

      <div
        aria-label={`${dataLab.title} data table`}
        className="data-lab__table-wrap"
        role="region"
        tabIndex={0}
      >
        <table>
          <caption>{dataLab.context}</caption>
          <thead>
            <tr>
              {dataLab.columns.map((column) => <th key={column} scope="col">{column}</th>)}
            </tr>
          </thead>
          <tbody>
            {dataLab.rows.map((row, rowIndex) => (
              <tr key={`${row[0]}-${rowIndex}`}>
                {row.map((cell, cellIndex) => cellIndex === 0
                  ? <th key={`${cell}-${cellIndex}`} scope="row">{cell}</th>
                  : <td key={`${cell}-${cellIndex}`}>{cell}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="data-lab__prompts">
        <ol>
          {dataLab.prompts.map((prompt) => <li key={prompt}>{prompt}</li>)}
        </ol>
      </div>

      <div className="data-lab__reveal-row">
        <button
          aria-controls={workedReadingId}
          aria-expanded={workedReadingRevealed}
          className="data-lab__reveal"
          onClick={() => setWorkedReadingRevealed((current) => !current)}
          type="button"
        >
          <Icon name={workedReadingRevealed ? 'eye-off' : 'eye'} size={16} />
          {workedReadingRevealed ? 'Hide worked reading' : 'Reveal worked reading'}
        </button>
      </div>

      <div className="data-lab__worked" hidden={!workedReadingRevealed} id={workedReadingId}>
        <p>{dataLab.workedReading}</p>
      </div>
    </section>
  );
}

function ArticleBody({ article, sources }: Pick<LessonMaterial, 'article' | 'sources'>) {
  const sourceIndex = new Map(sources.map((source, index) => [source.id, index + 1]));
  function renderParagraph(text: string) {
    return text.split(/\[\[([^\]]+)\]\]/g).map((part, index) => {
      if (index % 2 === 0) return part;
      const source = sources.find((candidate) => candidate.id === part);
      if (!source) return part;
      return (
        <a
          aria-label={`Reference ${sourceIndex.get(source.id)}: ${source.title}`}
          className="lesson-citation"
          href={source.url}
          key={`${source.id}-${index}`}
          rel="noreferrer"
          target="_blank"
        >
          [{sourceIndex.get(source.id)}]
        </a>
      );
    });
  }

  return (
    <div className="lesson-reading">
      {article.sections.map((section) => (
        <section className="lesson-reading__section" key={section.heading}>
          <h2>{section.heading}</h2>
          {section.paragraphs.map((paragraph, index) => <p key={`${section.heading}-${index}`}>{renderParagraph(paragraph)}</p>)}
        </section>
      ))}
    </div>
  );
}

function LessonReferences({ sources }: { sources: LessonMaterial['sources'] }) {
  if (sources.length === 0) return null;
  return (
    <section className="lesson-references" aria-label="References">
      <p className="eyebrow">References</p>
      <ol>
        {sources.map((source) => (
          <li key={source.id}>
            <a href={source.url} rel="noreferrer" target="_blank">{source.title}</a>
            <span>{source.publisher} · {source.kind}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}

function LessonNodeRenderer({ node, index }: { node: LessonNode; index: number }) {
  if (node.type === 'prose') {
    return (
      <section className="lesson-block lesson-node lesson-node--prose" key={`${node.type}-${node.heading}-${index}`}>
        <div>
          <h2>{node.heading}</h2>
          <p>{node.body}</p>
          {node.bullets.length > 0 && <ul>{node.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
        </div>
      </section>
    );
  }

  if (node.type === 'example') {
    return (
      <section className="lesson-node lesson-node--example" key={`${node.type}-${node.heading}-${index}`}>
        <h2>{node.heading}</h2>
        <p className="lesson-node__context">{node.context}</p>
        <ol className="lesson-node__steps">{node.steps.map((step) => <li key={step}>{step}</li>)}</ol>
        <p className="lesson-node__insight">{node.insight}</p>
      </section>
    );
  }

  if (node.type === 'comparison') {
    return (
      <section className="lesson-node lesson-node--comparison" key={`${node.type}-${node.heading}-${index}`}>
        <h2>{node.heading}</h2>
        <div className="lesson-node__table-wrap"><table>
          <thead><tr><th scope="col">Criterion</th><th scope="col">{node.leftLabel}</th><th scope="col">{node.rightLabel}</th></tr></thead>
          <tbody>{node.rows.map((row) => <tr key={row.criterion}><th scope="row">{row.criterion}</th><td>{row.left}</td><td>{row.right}</td></tr>)}</tbody>
        </table></div>
      </section>
    );
  }

  if (node.type === 'scenario') {
    return (
      <section className="lesson-node lesson-node--scenario" key={`${node.type}-${node.heading}-${index}`}>
        <h2>{node.heading}</h2>
        <p>{node.situation}</p>
        <p className="lesson-node__prompt">{node.prompt}</p>
        <ol className="lesson-node__choices">{node.choices.map((choice) => <li key={choice}>{choice}</li>)}</ol>
        <details className="lesson-node__reveal"><summary>See the reasoning</summary><p>{node.reasoning}</p></details>
      </section>
    );
  }

  if (node.type === 'flow') {
    return (
      <section className="lesson-node lesson-node--flow" key={`${node.type}-${node.heading}-${index}`}>
        <h2>{node.heading}</h2>
        <ol className="lesson-node__flow">{node.sequence.map((step, stepIndex) => <li key={`${step.label}-${stepIndex}`}><span>{String(stepIndex + 1).padStart(2, '0')}</span><div><strong>{step.label}</strong><p>{step.description}</p></div></li>)}</ol>
        <p className="lesson-node__outcome">{node.outcome}</p>
      </section>
    );
  }

  if (node.type === 'timeline') {
    return (
      <section className="lesson-node lesson-node--timeline" key={`${node.type}-${node.heading}-${index}`}>
        <h2>{node.heading}</h2>
        <ol className="lesson-node__timeline">{node.events.map((event) => <li key={event.label}><strong>{event.label}</strong><p>{event.description}</p></li>)}</ol>
      </section>
    );
  }

  return (
    <section className="lesson-node lesson-node--code" key={`${node.type}-${node.heading}-${index}`}>
      <h2>{node.heading}</h2>
      <pre><code>{node.code}</code></pre>
      <p>{node.explanation}</p>
      {node.bullets.length > 0 && <ul>{node.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
    </section>
  );
}

function LessonContent({
  completing,
  item,
  onComplete,
  onQuiz,
}: {
  completing: boolean;
  item: LessonWithSection;
  onComplete: () => void;
  onQuiz: () => void;
}) {
  const { lesson, section } = item;
  const material = lesson.material;
  const [practiceDraft, setPracticeDraft] = useState('');
  const [practiceSaved, setPracticeSaved] = useState(false);

  useEffect(() => {
    if (!material?.practice) return;
    setPracticeDraft(window.localStorage.getItem(`synau.practice.${lesson.id}`) ?? '');
    setPracticeSaved(false);
  }, [lesson.id, material?.practice]);

  function savePracticeDraft() {
    window.localStorage.setItem(`synau.practice.${lesson.id}`, practiceDraft);
    setPracticeSaved(true);
    window.setTimeout(() => setPracticeSaved(false), 2200);
  }

  if (!material) return null;

  return (
    <article className="lesson-article">
      <div className="lesson-overview">
        <p>{material.overview}</p>
      </div>

      {material.article.sections.length > 0 ? <ArticleBody article={material.article} sources={material.sources} /> : (
        <div className="lesson-blocks">
          {material.nodes.length > 0
            ? material.nodes.map((node, index) => <LessonNodeRenderer index={index} key={`${node.type}-${index}`} node={node} />)
            : material.blocks.map((block, index) => (
              <section className="lesson-block" key={`${block.heading}-${index}`}>
                <span className="lesson-block__index">{String(index + 1).padStart(2, '0')}</span>
                <div>
                  <h2>{block.heading}</h2>
                  <p>{block.body}</p>
                  {block.bullets.length > 0 && <ul>{block.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
                </div>
              </section>
            ))}
        </div>
      )}

      {material.article.sections.length > 0 && material.nodes.length > 0 && (
        <section className="lesson-components" aria-label="Supporting lesson material">
          <div className="lesson-components__list">
            {material.nodes.map((node, index) => <LessonNodeRenderer index={index} key={`${node.type}-${index}`} node={node} />)}
          </div>
        </section>
      )}

      {material.dataLab && <DataLab dataLab={material.dataLab} key={lesson.id} />}

      <aside className="takeaway-card">
        <span>Key takeaway</span>
        <p>{material.keyTakeaway}</p>
      </aside>

      <section className="reflection-card" aria-label="Reflection prompt">
        <p className="reflection-card__prompt">{material.reflectivePrompt}</p>
      </section>

      {material.practice && (
        <section className="practice-studio" aria-label="Optional practice">
          <p className="practice-studio__prompt">{material.practice.prompt}</p>
          <div className="practice-studio__grid">
            <div>
              <ol>
                {material.practice.steps.map((step) => <li key={step}>{step}</li>)}
              </ol>
            </div>
            <div>
              <ul>
                {material.practice.rubric.map((criterion) => <li key={criterion}>{criterion}</li>)}
              </ul>
            </div>
          </div>
          <div className="practice-studio__draft">
            <textarea aria-label="Practice draft" onChange={(event) => { setPracticeDraft(event.target.value); setPracticeSaved(false); }} placeholder="Write a first pass here. It stays in this browser." rows={5} value={practiceDraft} />
          </div>
          <div className="practice-studio__footer">
            {practiceSaved && <small>Draft saved locally in this browser.</small>}
            <button className="button button--secondary" onClick={savePracticeDraft} type="button">Save draft</button>
          </div>
        </section>
      )}

      <div className="lesson-source-note">
        <strong>About this material</strong>
        <p>{material.sourceNote}</p>
      </div>

      <LessonReferences sources={material.sources} />

      <section className="lesson-finish" aria-label="Lesson actions">
        <div>
          <p className="eyebrow">End of subchapter</p>
          <h2>{lesson.completedAt ? 'You marked this complete' : 'Ready to close the loop?'}</h2>
          <p>{lesson.completedAt ? 'You can still review this lesson or repeat its quiz at any time.' : 'Marking complete updates progress. It does not affect quiz access.'}</p>
        </div>
        <div className="lesson-finish__actions">
          <button className="button button--secondary" onClick={onQuiz} type="button">
            <Icon name="quiz" size={17} /> Lesson quiz
          </button>
          <button className="button button--primary" disabled={Boolean(lesson.completedAt) || completing} onClick={onComplete} type="button">
            {completing ? <><span className="spinner spinner--light" />Saving progress</> : lesson.completedAt ? <><Icon name="check" />Completed</> : <><Icon name="check" />Mark complete</>}
          </button>
        </div>
      </section>
    </article>
  );
}

export function CourseWorkspace({ courseId, onBack }: CourseWorkspaceProps) {
  const [course, setCourse] = useState<Course | null>(null);
  const [selectedLessonId, setSelectedLessonId] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [openingLessons, setOpeningLessons] = useState<Set<string>>(() => new Set());
  const [lessonErrors, setLessonErrors] = useState<Record<string, string>>({});
  const [lessonGenerationBusy, setLessonGenerationBusy] = useState<Record<string, boolean>>({});
  const activeLessonGenerationRef = useRef<string | null>(null);
  const [completingLessonId, setCompletingLessonId] = useState('');
  const [completionError, setCompletionError] = useState('');
  const [quizLaunch, setQuizLaunch] = useState<QuizLaunch | null>(null);
  const lessonTopRef = useRef<HTMLDivElement>(null);

  const openLesson = useCallback(async (lessonId: string) => {
    const activeLessonId = activeLessonGenerationRef.current;
    if (activeLessonId && activeLessonId !== lessonId) {
      setLessonErrors((current) => ({
        ...current,
        [lessonId]: 'Another lesson is currently being generated in this course. Please wait for it to finish before opening another subchapter.',
      }));
      setLessonGenerationBusy((current) => ({ ...current, [lessonId]: true }));
      return;
    }
    if (activeLessonId === lessonId) return;
    activeLessonGenerationRef.current = lessonId;
    setOpeningLessons((current) => new Set(current).add(lessonId));
    setLessonErrors((current) => ({ ...current, [lessonId]: '' }));
    setLessonGenerationBusy((current) => ({ ...current, [lessonId]: false }));
    try {
      const { course: updatedCourse } = await api.openLesson(courseId, lessonId);
      setCourse(updatedCourse);
    } catch (error) {
      setLessonErrors((current) => ({
        ...current,
        [lessonId]: error instanceof Error ? error.message : 'Could not generate this lesson.',
      }));
      setLessonGenerationBusy((current) => ({
        ...current,
        [lessonId]: error instanceof ApiError && error.code === 'lesson_generation_in_progress',
      }));
    } finally {
      if (activeLessonGenerationRef.current === lessonId) activeLessonGenerationRef.current = null;
      setOpeningLessons((current) => {
        const next = new Set(current);
        next.delete(lessonId);
        return next;
      });
    }
  }, [courseId]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setLoadError('');
    api.course(courseId)
      .then(({ course: loadedCourse }) => {
        if (!active) return;
        setCourse(loadedCourse);
        const lessons = flattenCourse(loadedCourse);
        const firstLesson = lessons.find(({ lesson }) => !lesson.completedAt) ?? lessons[0];
        if (firstLesson) {
          setSelectedLessonId(firstLesson.lesson.id);
        }
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load this course.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [courseId, openLesson]);

  const lessons = useMemo(() => course ? flattenCourse(course) : [], [course]);
  const selectedIndex = lessons.findIndex(({ lesson }) => lesson.id === selectedLessonId);
  const selectedItem = selectedIndex >= 0 ? lessons[selectedIndex] : null;

  function selectLesson(lessonId: string) {
    setSelectedLessonId(lessonId);
    setCompletionError('');
    const item = lessons.find(({ lesson }) => lesson.id === lessonId);
    if (item && !item.lesson.material && !openingLessons.has(lessonId)) {
      void openLesson(lessonId);
    }
    if (window.innerWidth < 900) {
      window.setTimeout(() => lessonTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 20);
    }
  }

  async function completeSelectedLesson() {
    if (!selectedItem || selectedItem.lesson.completedAt) return;
    setCompletingLessonId(selectedItem.lesson.id);
    setCompletionError('');
    try {
      const { course: updatedCourse } = await api.completeLesson(courseId, selectedItem.lesson.id);
      setCourse(updatedCourse);
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : 'Could not save your progress.');
    } finally {
      setCompletingLessonId('');
    }
  }

  function launchQuiz(scope: QuizScope, scopeId: string, scopeTitle: string) {
    if (!course) return;
    const initialRequest = api.generateQuiz({ course, scope, scopeId, scopeTitle });
    setQuizLaunch({ initialRequest, scope, scopeId, scopeTitle });
  }

  if (loading) {
    return (
      <section className="workspace-loading" aria-live="polite">
        <span className="spinner" />
        <h1>Opening your course</h1>
        <p>Loading the roadmap and your latest progress.</p>
      </section>
    );
  }

  if (loadError || !course) {
    return (
      <section className="page page--narrow empty-page">
        <p className="eyebrow">Course unavailable</p>
        <h1>We could not open this learning path.</h1>
        <p>{loadError || 'The requested course could not be found.'}</p>
        <div className="button-row">
          <button className="button button--ghost" onClick={onBack} type="button"><Icon name="arrow-left" /> Dashboard</button>
          <button className="button button--primary" onClick={() => window.location.reload()} type="button">Try again</button>
        </div>
      </section>
    );
  }

  const selectedLesson = selectedItem?.lesson;
  const selectedSection = selectedItem?.section;
  const lessonOpening = selectedLesson ? openingLessons.has(selectedLesson.id) : false;
  const lessonError = selectedLesson ? lessonErrors[selectedLesson.id] : '';
  const lessonIsBusy = selectedLesson ? Boolean(lessonGenerationBusy[selectedLesson.id]) : false;

  return (
    <div className="course-workspace">
      <header className="course-header">
        <div className="course-header__inner">
          <button className="back-link" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Dashboard</button>
          <div className="course-header__title">
            <span>{course.topic}</span>
            <h1>{course.title}</h1>
          </div>
          <button className="button button--secondary course-quiz-button" onClick={() => launchQuiz('course', course.id, course.title)} type="button">
            <Icon name="quiz" size={17} /> Course quiz
          </button>
        </div>
      </header>

      <div className="course-layout">
        <SectionRail
          course={course}
          onQuiz={launchQuiz}
          onSelectLesson={selectLesson}
          selectedLessonId={selectedLessonId}
        />

        <main className="lesson-pane" ref={lessonTopRef}>
          {selectedLesson && selectedSection ? (
            <>
              <header className="lesson-header">
                <div className="lesson-header__meta">
                  <span>Section {selectedSection.position + 1}</span>
                  <i />
                  <span>{selectedSection.title}</span>
                  <i />
                  <span><Icon name="clock" size={14} />{selectedLesson.estimatedMinutes} min</span>
                </div>
                <h1>{selectedLesson.title}</h1>
                <p>{selectedLesson.summary}</p>
                <div className="lesson-header__status">
                  {selectedLesson.completedAt
                    ? <span className="status-chip status-chip--complete"><Icon name="check" size={14} />Completed</span>
                    : <span className="status-chip">In progress</span>}
                  <button onClick={() => launchQuiz('lesson', selectedLesson.id, selectedLesson.title)} type="button">
                    <Icon name="quiz" size={15} /> Quick quiz
                  </button>
                </div>
              </header>

              {lessonOpening && !selectedLesson.material && <LessonLoading lesson={selectedLesson} />}

              {lessonError && !lessonOpening && !selectedLesson.material && (
                <div className="lesson-generation-error" role="alert">
                  <span><Icon name="book" size={22} /></span>
                  <div>
                    <p className="eyebrow">{lessonIsBusy ? 'Another lesson is generating' : 'Generation paused'}</p>
                    <h2>{lessonIsBusy ? 'Synau is preparing another subchapter.' : 'This lesson could not be prepared.'}</h2>
                    <p>{lessonError}</p>
                    <button className="button button--primary" onClick={() => void openLesson(selectedLesson.id)} type="button">{lessonIsBusy ? 'Check again when it finishes' : 'Try generating again'}</button>
                  </div>
                </div>
              )}

              {!lessonOpening && !lessonError && !selectedLesson.material && (
                <div className="lesson-generation-error">
                  <span><Icon name="book" size={22} /></span>
                  <div>
                    <p className="eyebrow">Ready when you are</p>
                    <h2>Generate this lesson on demand.</h2>
                    <p>Synau creates material only when a subchapter is opened.</p>
                    <button className="button button--primary" onClick={() => void openLesson(selectedLesson.id)} type="button">Open lesson</button>
                  </div>
                </div>
              )}

              {selectedLesson.material && (
                <LessonContent
                  completing={completingLessonId === selectedLesson.id}
                  item={selectedItem}
                  onComplete={() => void completeSelectedLesson()}
                  onQuiz={() => launchQuiz('lesson', selectedLesson.id, selectedLesson.title)}
                />
              )}

              {completionError && <p className="form-error lesson-completion-error" role="alert">{completionError}</p>}

              <nav className="lesson-pagination" aria-label="Lesson navigation">
                <button
                  disabled={selectedIndex <= 0}
                  onClick={() => selectLesson(lessons[selectedIndex - 1].lesson.id)}
                  type="button"
                >
                  <Icon name="arrow-left" />
                  <span><small>Previous</small><strong>{selectedIndex > 0 ? lessons[selectedIndex - 1].lesson.title : 'First lesson'}</strong></span>
                </button>
                <button
                  disabled={selectedIndex >= lessons.length - 1}
                  onClick={() => selectLesson(lessons[selectedIndex + 1].lesson.id)}
                  type="button"
                >
                  <span><small>Next</small><strong>{selectedIndex < lessons.length - 1 ? lessons[selectedIndex + 1].lesson.title : 'End of course'}</strong></span>
                  <Icon name="arrow-right" />
                </button>
              </nav>
            </>
          ) : (
            <div className="library-empty"><h2>This course has no subchapters yet.</h2></div>
          )}
        </main>
      </div>

      {quizLaunch && (
        <QuizPanel course={course} launch={quizLaunch} onClose={() => setQuizLaunch(null)} />
      )}
    </div>
  );
}
