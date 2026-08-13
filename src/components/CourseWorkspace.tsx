import { memo, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import katex from 'katex';
import 'katex/dist/katex.min.css';
import { api, ApiError } from '../api';
import type { Course, CourseLesson, CourseSection, LessonArticleBlock, LessonMaterial, LessonNode, LessonWithSection, QuizScope } from '../types';
import { CodeBlock, HighlightedCode } from './CodeBlock';
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
        <span><i />Polishing the article and sources</span>
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

const SectionRail = memo(function SectionRail({
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
});

function CitationText({ text, sources }: { text: string; sources: LessonMaterial['sources'] }) {
  const sourceIndex = new Map(sources.map((source, index) => [source.id, index + 1]));
  return <>{text.split(/\[\[([^\]]+)\]\]/g).map((part, index) => {
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
  })}</>;
}

function EquationBlock({ block }: { block: Extract<LessonArticleBlock, { type: 'equation' }> }) {
  const html = useMemo(() => katex.renderToString(block.latex, {
    displayMode: true,
    throwOnError: false,
    trust: false,
  }), [block.latex]);
  return (
    <figure className="lesson-rich-block lesson-rich-block--equation">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}

function MermaidBlock({ block }: { block: Extract<LessonArticleBlock, { type: 'mermaid' }> }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const renderId = `synau-mermaid-${useId().replace(/:/g, '')}`;
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setError(false);
    void import('mermaid').then(async ({ default: mermaid }) => {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: {
          background: '#fbfbf8',
          primaryColor: '#f1f1ec',
          primaryTextColor: '#171716',
          primaryBorderColor: '#9c9c94',
          lineColor: '#676761',
          secondaryColor: '#f7f7f3',
          tertiaryColor: '#ffffff',
          fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        },
      });
      try {
        const result = await mermaid.render(renderId, block.code);
        if (cancelled || !containerRef.current) return;
        containerRef.current.innerHTML = result.svg;
        result.bindFunctions?.(containerRef.current);
      } catch {
        if (!cancelled) setError(true);
      }
    }).catch(() => {
      if (!cancelled) setError(true);
    });
    return () => { cancelled = true; };
  }, [block.code, renderId]);

  return (
    <figure className="lesson-rich-block lesson-rich-block--mermaid">
      {error ? <pre className="lesson-rich-block__fallback"><code><HighlightedCode code={block.code} language="text" /></code></pre> : <div aria-label={block.caption ?? 'Lesson diagram'} ref={containerRef} />}
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
  );
}

function ArticleBlock({ block, sources }: { block: LessonArticleBlock; sources: LessonMaterial['sources'] }) {
  switch (block.type) {
    case 'paragraph':
      return <p><CitationText sources={sources} text={block.text} /></p>;
    case 'code':
      return <CodeBlock code={block.code} language={block.language} caption={block.caption} />;
    case 'equation':
      return <EquationBlock block={block} />;
    case 'mermaid':
      return <MermaidBlock block={block} />;
    case 'table':
      return (
        <figure className="lesson-rich-block lesson-rich-block--table">
          <div className="lesson-rich-block__table-wrap">
            <table>
              <thead><tr>{block.columns.map((column) => <th key={column} scope="col">{column}</th>)}</tr></thead>
              <tbody>{block.rows.map((row, rowIndex) => <tr key={`${row[0]}-${rowIndex}`}>{row.map((cell, cellIndex) => cellIndex === 0
                ? <th key={`${cell}-${cellIndex}`} scope="row"><CitationText sources={sources} text={cell} /></th>
                : <td key={`${cell}-${cellIndex}`}><CitationText sources={sources} text={cell} /></td>)}</tr>)}</tbody>
            </table>
          </div>
          {block.caption && <figcaption>{block.caption}</figcaption>}
        </figure>
      );
    case 'quote':
      return (
        <blockquote className="lesson-rich-block lesson-rich-block--quote">
          <p><CitationText sources={sources} text={block.text} /></p>
          {block.attribution && <cite><CitationText sources={sources} text={block.attribution} /></cite>}
          {block.sourceId && <CitationText sources={sources} text={`[[${block.sourceId}]]`} />}
        </blockquote>
      );
  }
}

function ArticleBody({ article, sources }: Pick<LessonMaterial, 'article' | 'sources'>) {
  return (
    <div className="lesson-reading">
      {article.sections.map((section) => (
        <section className="lesson-reading__section" key={section.heading}>
          <h2>{section.heading}</h2>
          {section.content.length > 0
            ? section.content.map((block, index) => <ArticleBlock block={block} key={`${section.heading}-${block.type}-${index}`} sources={sources} />)
            : section.paragraphs.map((paragraph, index) => <p key={`${section.heading}-${index}`}><CitationText sources={sources} text={paragraph} /></p>)}
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

function legacyNodeText(node: LessonNode) {
  switch (node.type) {
    case 'prose': return { paragraphs: [node.body], bullets: node.bullets };
    case 'example': return { paragraphs: [node.context, node.insight], bullets: node.steps };
    case 'comparison': return { paragraphs: [node.rows.map((row) => `${row.criterion}: ${row.left}; ${row.right}.`).join(' ')] };
    case 'scenario': return { paragraphs: [node.situation, node.prompt, node.reasoning], bullets: node.choices };
    case 'flow': return { paragraphs: [node.sequence.map((step) => `${step.label}: ${step.description}`).join(' '), node.outcome] };
    case 'timeline': return { paragraphs: [node.events.map((event) => `${event.label}: ${event.description}`).join(' ')] };
    case 'code': return { paragraphs: [node.explanation], bullets: node.bullets, code: node.code, language: node.language };
  }
}

function LegacyLessonBody({ blocks, nodes }: Pick<LessonMaterial, 'blocks' | 'nodes'>) {
  if (blocks.length > 0) {
    return (
      <div className="lesson-reading lesson-reading--legacy">
        {blocks.map((block) => (
          <section className="lesson-reading__section" key={block.heading}>
            <h2>{block.heading}</h2>
            <p>{block.body}</p>
            {block.bullets.length > 0 && <ul>{block.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
          </section>
        ))}
      </div>
    );
  }

  return (
    <div className="lesson-reading lesson-reading--legacy">
      {nodes.map((node) => {
        const content = legacyNodeText(node);
        return (
          <section className="lesson-reading__section" key={`${node.type}-${node.heading}`}>
            <h2>{node.heading}</h2>
            {content.paragraphs.map((paragraph) => <p key={paragraph}>{paragraph}</p>)}
            {content.bullets && content.bullets.length > 0 && <ul>{content.bullets.map((bullet) => <li key={bullet}>{bullet}</li>)}</ul>}
            {content.code && <CodeBlock code={content.code} language={content.language ?? 'text'} />}
          </section>
        );
      })}
    </div>
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
  const { lesson } = item;
  const material = lesson.material;

  if (!material) return null;

  return (
    <article className="lesson-article">
      <div className="lesson-overview">
        <p>{material.overview}</p>
      </div>

      {material.article.sections.length > 0
        ? <ArticleBody article={material.article} sources={material.sources} />
        : <LegacyLessonBody blocks={material.blocks} nodes={material.nodes} />}

      <aside className="lesson-takeaway">
        <span>Key takeaway</span>
        <p>{material.keyTakeaway}</p>
      </aside>

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
  const quizLaunchKeyRef = useRef<string | null>(null);
  const completionInFlightRef = useRef(false);

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

  const selectLesson = useCallback((lessonId: string) => {
    setSelectedLessonId(lessonId);
    setCompletionError('');
    const item = lessons.find(({ lesson }) => lesson.id === lessonId);
    if (item && !item.lesson.material && !openingLessons.has(lessonId)) {
      void openLesson(lessonId);
    }
    if (window.innerWidth < 900) {
      window.setTimeout(() => lessonTopRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 20);
    }
  }, [lessons, openingLessons, openLesson]);

  const completeSelectedLesson = useCallback(async () => {
    if (!selectedItem || selectedItem.lesson.completedAt || completionInFlightRef.current) return;
    completionInFlightRef.current = true;
    setCompletingLessonId(selectedItem.lesson.id);
    setCompletionError('');
    try {
      const { course: updatedCourse } = await api.completeLesson(courseId, selectedItem.lesson.id);
      setCourse(updatedCourse);
    } catch (error) {
      setCompletionError(error instanceof Error ? error.message : 'Could not save your progress.');
    } finally {
      completionInFlightRef.current = false;
      setCompletingLessonId('');
    }
  }, [courseId, selectedItem]);

  const launchQuiz = useCallback((scope: QuizScope, scopeId: string, scopeTitle: string) => {
    if (!course) return;
    const key = `${scope}:${scopeId}`;
    if (quizLaunchKeyRef.current === key) return;
    quizLaunchKeyRef.current = key;
    const initialRequest = api.generateQuiz({ course, scope, scopeId, scopeTitle });
    setQuizLaunch({ initialRequest, scope, scopeId, scopeTitle });
  }, [course]);

  const closeQuiz = useCallback(() => {
    quizLaunchKeyRef.current = null;
    setQuizLaunch(null);
  }, []);

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
  const selectedSectionIndex = selectedSection
    ? course.sections.findIndex((section) => section.id === selectedSection.id)
    : -1;
  const selectedSectionNumber = selectedSectionIndex >= 0 ? selectedSectionIndex + 1 : 1;
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
                  <span>Section {selectedSectionNumber}</span>
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

      {quizLaunch && <QuizPanel course={course} launch={quizLaunch} onClose={closeQuiz} />}
    </div>
  );
}
