import { useEffect, useState } from 'react';
import { api } from '../api';
import type { Course } from '../types';
import { CourseCard, CourseDeleteDialog, CourseRenameDialog, CourseSkeleton } from './Dashboard';
import { Icon } from './Icon';

type LibraryPageProps = {
  onBack: () => void;
  onOpenCourse: (courseId: string) => void;
};

export function LibraryPage({ onBack, onOpenCourse }: LibraryPageProps) {
  const [courses, setCourses] = useState<Course[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [editingCourse, setEditingCourse] = useState<Course | null>(null);
  const [deletingCourse, setDeletingCourse] = useState<Course | null>(null);
  const [managerBusy, setManagerBusy] = useState<'rename' | 'delete' | null>(null);
  const [managerError, setManagerError] = useState('');

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
        if (active) setLoadError(error instanceof Error ? error.message : 'Could not load your learning paths.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, []);

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

  const closeRename = () => {
    if (!managerBusy) {
      setEditingCourse(null);
      setManagerError('');
    }
  };
  const closeDelete = () => {
    if (!managerBusy) {
      setDeletingCourse(null);
      setManagerError('');
    }
  };

  return (
    <div className="page library-page">
      <header className="page-header page-header--split">
        <div>
          <button className="back-link library-page__back" onClick={onBack} type="button"><Icon name="arrow-left" size={16} /> Dashboard</button>
          <p className="eyebrow">Your library</p>
          <h1>All learning paths</h1>
          <p>Everything you have started, ready to continue or revisit.</p>
        </div>
        {!loading && !loadError && <div className="library-page__count"><strong>{courses.length}</strong><span>{courses.length === 1 ? 'learning path' : 'learning paths'}</span></div>}
      </header>

      {loadError && (
        <div className="inline-notice inline-notice--error" role="alert">
          <div><strong>Your learning paths could not be loaded</strong><p>{loadError}</p></div>
          <button className="button button--secondary" onClick={() => window.location.reload()} type="button">Try again</button>
        </div>
      )}

      {loading && <div className="course-grid"><CourseSkeleton /><CourseSkeleton /><CourseSkeleton /></div>}

      {!loading && !loadError && courses.length === 0 && (
        <div className="library-empty">
          <span className="library-empty__icon"><Icon name="book" size={24} /></span>
          <h3>Your library is ready for its first path</h3>
          <p>Start on the dashboard by describing something you want to understand.</p>
          <button className="button button--secondary" onClick={onBack} type="button">Choose a topic</button>
        </div>
      )}

      {!loading && !loadError && courses.length > 0 && (
        <div className="course-grid library-page__grid">
          {courses.map((course) => (
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

      {editingCourse && <CourseRenameDialog course={editingCourse} error={managerError} onClose={closeRename} onSave={(title) => void renameCourse(title)} saving={managerBusy === 'rename'} />}
      {deletingCourse && <CourseDeleteDialog course={deletingCourse} deleting={managerBusy === 'delete'} error={managerError} onClose={closeDelete} onConfirm={() => void deleteCourse()} />}
    </div>
  );
}
