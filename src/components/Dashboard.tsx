import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { Course, Roadmap } from '../types';
import { Icon } from './Icon';
import { RoadmapPreview } from './RoadmapPreview';

type DashboardProps = {
  onOpenCourse: (courseId: string) => void;
  onOpenLibrary: () => void;
};

const topicSuggestions = [
  'Learn digital marketing from zero',
  'Start a small online business',
  'Python for beginners',
  'Learn project management from zero',
  'Learn sales conversations from zero',
  'Learn customer service basics',
  'Learn UX research from zero',
  'Understand financial reports for non-finance roles',
  'Prepare for your first internship',
];

type CourseCardProps = {
  course: Course;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
};

export function CourseCard({ course, onOpen, onRename, onDelete }: CourseCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const nextLesson = course.sections
    .flatMap((section) => section.lessons)
    .find((lesson) => !lesson.completedAt);
  const started = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(course.createdAt));
  const isComplete = course.progress.percent === 100;

  useEffect(() => {
    if (!menuOpen) return;
    function closeMenu(event: MouseEvent) {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false);
    }
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menuOpen]);

  return (
    <article className="course-card">
      <div className="course-card__topline">
        <div className="course-card__identity">
          <span className="course-card__topic">{course.topic}</span>
          <span className={`course-card__status ${isComplete ? 'course-card__status--complete' : ''}`}>
            {isComplete ? 'Complete' : 'In progress'}
          </span>
          <span className="course-card__percent">{course.progress.percent}%</span>
        </div>
        <div className="course-card__menu" ref={menuRef}>
          <button
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            aria-label={`Manage ${course.title}`}
            className="course-card__menu-button"
            onClick={() => setMenuOpen((open) => !open)}
            type="button"
          >
            <Icon name="more-vertical" size={19} />
          </button>
          {menuOpen && (
            <div className="course-card__menu-popover" role="menu">
              <button onClick={() => { setMenuOpen(false); onRename(); }} role="menuitem" type="button">Rename path</button>
              <button className="course-card__menu-item--danger" onClick={() => { setMenuOpen(false); onDelete(); }} role="menuitem" type="button">Delete course</button>
            </div>
          )}
        </div>
      </div>
      <div className="course-card__body">
        <h3>{course.title}</h3>
        <p>{course.description}</p>
      </div>
      <div className="progress-track" aria-label={`${course.progress.percent}% complete`}>
        <span style={{ width: `${course.progress.percent}%` }} />
      </div>
      <div className="course-card__meta">
        <span>{course.progress.completedLessons} of {course.progress.totalLessons} complete</span>
        <span>{course.sections.length} sections</span>
        <span>Started {started}</span>
      </div>
      <button
        className="course-card__action"
        onClick={onOpen}
        onFocus={() => { void api.prefetchCourse(course.id); }}
        onMouseEnter={() => { void api.prefetchCourse(course.id); }}
        type="button"
      >
        <span>
          <small>{course.progress.percent === 100 ? 'Course complete' : nextLesson ? 'Continue with' : 'Open course'}</small>
          <strong>{course.progress.percent === 100 ? 'Review your learning' : nextLesson?.title ?? 'View learning path'}</strong>
        </span>
        <span className="round-arrow"><Icon name="arrow-right" /></span>
      </button>
    </article>
  );
}

export function CourseRenameDialog({
  course,
  saving,
  error,
  onClose,
  onSave,
}: {
  course: Course;
  saving: boolean;
  error: string;
  onClose: () => void;
  onSave: (title: string) => void;
}) {
  const [title, setTitle] = useState(course.title);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !saving) onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose, saving]);

  return (
    <div
      className="dialog-backdrop dialog-backdrop--manager"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
      role="presentation"
    >
      <section aria-describedby="rename-course-help" aria-labelledby="rename-course-title" aria-modal="true" className="manager-dialog" role="dialog">
        <header className="manager-dialog__header">
          <div>
            <p className="eyebrow">Learning path</p>
            <h2 id="rename-course-title">Rename this path</h2>
          </div>
          <button aria-label="Close rename dialog" className="icon-button" disabled={saving} onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const cleanTitle = title.trim();
            if (cleanTitle.length > 0 && cleanTitle !== course.title) onSave(cleanTitle);
          }}
        >
          <div className="manager-dialog__body">
            <label className="field" htmlFor="rename-course-input">
              Path name
              <input
                id="rename-course-input"
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                ref={inputRef}
                value={title}
              />
            </label>
            <p className="manager-dialog__help" id="rename-course-help">Only the name changes. Your roadmap, lessons, and progress stay intact.</p>
            {error && <p className="form-error" role="alert">{error}</p>}
          </div>
          <footer className="manager-dialog__footer">
            <button className="button button--ghost" disabled={saving} onClick={onClose} type="button">Cancel</button>
            <button className="button button--primary" disabled={saving || title.trim().length === 0 || title.trim() === course.title} type="submit">
              {saving ? <><span className="spinner spinner--light" />Saving</> : 'Save name'}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function CourseDeleteDialog({
  course,
  deleting,
  error,
  onClose,
  onConfirm,
}: {
  course: Course;
  deleting: boolean;
  error: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const deleteButtonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    deleteButtonRef.current?.focus();
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape' && !deleting) onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [deleting, onClose]);

  return (
    <div
      className="dialog-backdrop dialog-backdrop--manager"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !deleting) onClose();
      }}
      role="presentation"
    >
      <section aria-describedby="delete-course-help" aria-labelledby="delete-course-title" aria-modal="true" className="manager-dialog manager-dialog--danger" role="dialog">
        <header className="manager-dialog__header">
          <div>
            <p className="eyebrow">Permanent action</p>
            <h2 id="delete-course-title">Delete this course?</h2>
          </div>
          <button aria-label="Close delete dialog" className="icon-button" disabled={deleting} onClick={onClose} type="button">
            <Icon name="close" />
          </button>
        </header>
        <div className="manager-dialog__body">
          <p className="manager-dialog__course-name">{course.title}</p>
          <p id="delete-course-help">This will permanently remove the learning path, its lessons, quiz attempts, and activity history. This action cannot be undone.</p>
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <footer className="manager-dialog__footer">
          <button className="button button--ghost" disabled={deleting} onClick={onClose} type="button">Keep course</button>
          <button className="button button--danger" disabled={deleting} onClick={onConfirm} ref={deleteButtonRef} type="button">
            {deleting ? <><span className="spinner spinner--light" />Deleting</> : 'Delete course'}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function CourseSkeleton() {
  return (
    <div className="course-card course-card--skeleton" aria-hidden="true">
      <span className="skeleton skeleton--short" />
      <span className="skeleton skeleton--title" />
      <span className="skeleton skeleton--line" />
      <span className="skeleton skeleton--line" />
      <span className="skeleton skeleton--footer" />
    </div>
  );
}

export function Dashboard({ onOpenCourse, onOpenLibrary }: DashboardProps) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [topic, setTopic] = useState('');
  const [language, setLanguage] = useState<'en' | 'id'>('en');
  const [roadmap, setRoadmap] = useState<Roadmap | null>(null);
  const [generating, setGenerating] = useState(false);
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState('');
  const [createError, setCreateError] = useState('');
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [deletingCourse, setDeletingCourse] = useState<Course | null>(null);
  const [managerBusy, setManagerBusy] = useState<'rename' | 'delete' | null>(null);
  const [managerError, setManagerError] = useState('');

  const summary = useMemo(() => {
    const completed = courses.reduce((total, course) => total + course.progress.completedLessons, 0);
    const total = courses.reduce((count, course) => count + course.progress.totalLessons, 0);
    return { completed, total, active: courses.filter((course) => course.progress.percent < 100).length };
  }, [courses]);

  const continueCourse = useMemo(() => courses.find((course) => course.status === 'active' && course.progress.percent < 100), [courses]);
  const continueLesson = continueCourse?.sections.flatMap((section) => section.lessons).find((lesson) => !lesson.completedAt);
  const visibleCourses = courses.slice(0, 6);

  useEffect(() => {
    let active = true;
    api.courses()
      .then(({ courses: loadedCourses }) => {
        if (active) {
          setCourses(loadedCourses);
          setLoadError('');
        }
      })
      .catch((error) => {
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load your courses.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  async function generate(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    const cleanTopic = topic.trim();
    if (cleanTopic.length < 3) {
      setFormError('Enter a topic with at least 3 characters.');
      return;
    }
    setGenerating(true);
    setFormError('');
    setCreateError('');
    try {
      const result = await api.generateRoadmap(cleanTopic, language);
      setRoadmap(result.roadmap);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Could not generate a roadmap.');
    } finally {
      setGenerating(false);
    }
  }

  async function approveRoadmap() {
    if (!roadmap) return;
    setCreating(true);
    setCreateError('');
    try {
      const { course } = await api.createCourse(roadmap);
      onOpenCourse(course.id);
    } catch (error) {
      setCreateError(error instanceof Error ? error.message : 'Could not create this course.');
      setCreating(false);
    }
  }

  function useSuggestion(suggestion: string) {
    setTopic(suggestion);
    setFormError('');
    document.getElementById('topic-input')?.focus();
  }

  function openRename(course: Course) {
    setManagerError('');
    setEditingCourse(course);
  }

  function openDelete(course: Course) {
    setManagerError('');
    setDeletingCourse(course);
  }

  async function renameCourse(title: string) {
    if (!editingCourse) return;
    const previousCourses = courses;
    const optimisticCourse = { ...editingCourse, title };
    setManagerBusy('rename');
    setManagerError('');
    setCourses((current) => current.map((item) => item.id === optimisticCourse.id ? optimisticCourse : item));
    try {
      const { course } = await api.renameCourse(editingCourse.id, title);
      setCourses((current) => current.map((item) => item.id === course.id ? course : item));
      setEditingCourse(null);
    } catch (error) {
      setCourses(previousCourses);
      setManagerError(error instanceof Error ? error.message : 'Could not rename this learning path.');
    } finally {
      setManagerBusy(null);
    }
  }

  async function deleteCourse() {
    if (!deletingCourse) return;
    const previousCourses = courses;
    setManagerBusy('delete');
    setManagerError('');
    setCourses((current) => current.filter((item) => item.id !== deletingCourse.id));
    try {
      await api.deleteCourse(deletingCourse.id);
      setDeletingCourse(null);
    } catch (error) {
      setCourses(previousCourses);
      setManagerError(error instanceof Error ? error.message : 'Could not delete this course.');
    } finally {
      setManagerBusy(null);
    }
  }

  return (
    <div className="page dashboard-page">
      <header className="dashboard-hero">
        <div>
          <p className="eyebrow">Learner dashboard</p>
          <h1>What do you want to understand next?</h1>
          <p>Describe a topic. Synau will shape it into a focused path for you to review.</p>
        </div>
          <div className="dashboard-stats" aria-label="Learning summary">
            <div><strong>{courses.length}</strong><span>Courses</span></div>
            <div><strong>{summary.completed}<small>/{summary.total}</small></strong><span>Lessons complete</span></div>
            <div><strong>{summary.active}</strong><span>Active paths</span></div>
          </div>
      </header>

      {continueCourse && continueLesson && (
        <section className="continue-card" aria-labelledby="continue-title">
          <div className="continue-card__copy">
            <p className="eyebrow">Continue learning</p>
            <h2 id="continue-title">{continueLesson.title}</h2>
            <p>{continueCourse.title}</p>
          </div>
          <div className="continue-card__progress">
            <span>{continueCourse.progress.percent}% complete</span>
            <div className="progress-track" aria-label={`${continueCourse.progress.percent}% complete`}><span style={{ width: `${continueCourse.progress.percent}%` }} /></div>
          </div>
          <button className="button button--primary" onClick={() => onOpenCourse(continueCourse.id)} type="button">
            Resume path <Icon name="arrow-right" />
          </button>
        </section>
      )}

      <section className="topic-builder" aria-labelledby="topic-builder-title">
        <div className="topic-builder__lead">
          <div>
            <h2 id="topic-builder-title">Build a course around your goal</h2>
            <p>Specific topics produce more useful learning paths.</p>
          </div>
        </div>
        <form className="topic-form" onSubmit={(event) => void generate(event)}>
          <div className="topic-form__field-head">
            <label htmlFor="topic-input">I want to learn</label>
          </div>
          <div className="topic-form__input-row">
            <input
              aria-describedby={formError ? 'topic-error' : 'topic-help'}
              disabled={generating}
              id="topic-input"
              maxLength={120}
              minLength={3}
              onChange={(event) => {
                setTopic(event.target.value);
                setFormError('');
              }}
              placeholder="e.g. How to run useful customer interviews"
              required
              type="text"
              value={topic}
            />
            <button className="button button--primary" disabled={generating || topic.trim().length < 3} type="submit">
              {generating ? <><span className="spinner spinner--light" />Generating course</> : <>Generate Course <Icon name="arrow-right" /></>}
            </button>
          </div>
          <div className="topic-form__footer">
            {formError
              ? <p className="form-error" id="topic-error" role="alert">{formError}</p>
              : <p className="field-help" id="topic-help">You will review outcomes, sequence, and time estimates before creating anything.</p>}
            <div aria-labelledby="course-language-label" className="topic-form__language" role="group">
              <span id="course-language-label">Course language</span>
              <div className="language-toggle">
                {(['en', 'id'] as const).map((option) => (
                  <button
                    aria-pressed={language === option}
                    className={language === option ? 'is-active' : ''}
                    disabled={generating}
                    key={option}
                    onClick={() => setLanguage(option)}
                    type="button"
                  >
                    {option === 'en' ? 'English' : 'Bahasa Indonesia'}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </form>
        <div aria-labelledby="topic-suggestions-title" className="topic-suggestions">
          <div className="topic-suggestions__header">
            <div>
              <p className="eyebrow" id="topic-suggestions-title">Try a topic</p>
              <p>Choose a starting point to fill the field.</p>
            </div>
          </div>
          <div className="topic-suggestions__list">
            {topicSuggestions.map((suggestion) => (
              <button className="topic-suggestion" disabled={generating} key={suggestion} onClick={() => useSuggestion(suggestion)} type="button">
                <span className="topic-suggestion__icon"><Icon name="plus" size={14} /></span>
                <span className="topic-suggestion__label">{suggestion}</span>
                <Icon name="arrow-right" size={14} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="course-library" aria-labelledby="course-library-title">
        <div className="section-heading-row">
          <div>
            <p className="eyebrow">Your library</p>
            <h2 id="course-library-title">Learning paths</h2>
          </div>
          {!loading && courses.length > 0 && (
            <div className="library-heading-actions">
              <p>{visibleCourses.length} of {courses.length} {courses.length === 1 ? 'course' : 'courses'}, ordered by recent activity</p>
              {courses.length > 6 && <button className="text-link" onClick={onOpenLibrary} type="button">View all paths <Icon name="arrow-right" size={15} /></button>}
            </div>
          )}
        </div>

        {loadError && (
          <div className="inline-notice inline-notice--error" role="alert">
            <div><strong>Your courses could not be loaded</strong><p>{loadError}</p></div>
            <button className="button button--secondary" onClick={() => window.location.reload()} type="button">Try again</button>
          </div>
        )}

        {loading && <div className="course-grid"><CourseSkeleton /><CourseSkeleton /></div>}

        {!loading && !loadError && courses.length === 0 && (
          <div className="library-empty">
            <span className="library-empty__icon"><Icon name="book" size={24} /></span>
            <h3>Your first learning path starts above</h3>
            <p>Enter a topic, inspect the proposed roadmap, and approve it when the sequence feels right.</p>
            <button className="button button--secondary" onClick={() => document.getElementById('topic-input')?.focus()} type="button">
              Choose a topic
            </button>
          </div>
        )}

        {!loading && courses.length > 0 && (
          <div className="course-grid">
            {visibleCourses.map((course) => (
              <CourseCard
                course={course}
                key={course.id}
                onDelete={() => openDelete(course)}
                onOpen={() => onOpenCourse(course.id)}
                onRename={() => openRename(course)}
              />
            ))}
          </div>
        )}
      </section>

      {editingCourse && (
        <CourseRenameDialog
          course={editingCourse}
          error={managerError}
          onClose={() => {
            if (!managerBusy) {
              setEditingCourse(null);
              setManagerError('');
            }
          }}
          onSave={(title) => void renameCourse(title)}
          saving={managerBusy === 'rename'}
        />
      )}

      {deletingCourse && (
        <CourseDeleteDialog
          course={deletingCourse}
          deleting={managerBusy === 'delete'}
          error={managerError}
          onClose={() => {
            if (!managerBusy) {
              setDeletingCourse(null);
              setManagerError('');
            }
          }}
          onConfirm={() => void deleteCourse()}
        />
      )}

      {roadmap && (
        <RoadmapPreview
          creating={creating}
          error={createError}
          onApprove={() => void approveRoadmap()}
          onClose={() => {
            if (!creating) {
              setRoadmap(null);
              setCreateError('');
            }
          }}
          roadmap={roadmap}
        />
      )}
    </div>
  );
}
