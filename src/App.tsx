import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import { api, clearToken, getToken } from './api';
import { AuthScreen } from './components/AuthScreen';
import { Dashboard } from './components/Dashboard';
import { LibraryPage } from './components/LibraryPage';
import { Icon } from './components/Icon';
import { ProfilePage } from './components/ProfilePage';
import { ProductProgressPage } from './components/ProductProgressPage';
import { CreditsPage } from './components/CreditsPage';
import { CourseWorkspace } from './components/CourseWorkspace';
import type { User } from './types';

type AuthState =
  | { status: 'checking'; user: null }
  | { status: 'anonymous'; user: null }
  | { status: 'authenticated'; user: User };

type AppShellProps = {
  children: ReactNode;
  currentPath: string;
  onLogout: () => Promise<void>;
  onNavigate: (path: string) => void;
  user: User;
};

function useLocation() {
  const [path, setPath] = useState(() => window.location.pathname);

  useEffect(() => {
    const handlePopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  const navigate = useCallback((nextPath: string) => {
    if (nextPath !== window.location.pathname) {
      window.history.pushState({}, '', nextPath);
      setPath(nextPath);
      window.scrollTo({ top: 0, behavior: 'instant' });
    }
  }, []);

  return { path, navigate };
}

function AppLink({ children, className, href, onNavigate }: {
  children: ReactNode;
  className?: string;
  href: string;
  onNavigate: (path: string) => void;
}) {
  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) {
      event.preventDefault();
      onNavigate(href);
    }
  }

  return <a className={className} href={href} onClick={handleClick}>{children}</a>;
}

function AppShell({ children, currentPath, onLogout, onNavigate, user }: AppShellProps) {
  const [profileOpen, setProfileOpen] = useState(false);
  const [creditBalance, setCreditBalance] = useState<number | null>(null);
  const profileRef = useRef<HTMLDivElement>(null);
  const initials = useMemo(() => user.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(), [user.name]);

  function navigate(path: string) {
    setProfileOpen(false);
    onNavigate(path);
  }

  useEffect(() => {
    let active = true;
    api.credits()
      .then(({ credits }) => {
        if (active) setCreditBalance(credits.balance);
      })
      .catch(() => {
        if (active) setCreditBalance(null);
      });
    return () => { active = false; };
  }, [currentPath]);

  useEffect(() => {
    if (!profileOpen) return;
    function closeMenu(event: globalThis.MouseEvent) {
      if (!profileRef.current?.contains(event.target as Node)) setProfileOpen(false);
    }
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') setProfileOpen(false);
    }
    document.addEventListener('mousedown', closeMenu);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [profileOpen]);

  return (
    <div className="app-frame">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <header className="app-header">
        <div className="app-header__inner">
          <AppLink className="brand" href="/" onNavigate={navigate}>
            <span className="brand-mark">S</span>
            <span>Synau</span>
          </AppLink>

          <div className="app-header__actions">
            <AppLink className="credit-chip" href="/credits" onNavigate={navigate}>
              <Icon name="credit-card" size={16} />
              <span>Credits</span>
              <strong>{creditBalance === null ? '—' : new Intl.NumberFormat('id-ID').format(creditBalance)}</strong>
            </AppLink>

            <div className="profile-menu" ref={profileRef}>
              <button
                aria-expanded={profileOpen}
                aria-haspopup="menu"
                aria-label="Open profile menu"
                className="profile-trigger"
                onClick={() => setProfileOpen((open) => !open)}
                type="button"
              >
                <span className="user-avatar" aria-hidden="true">{initials || 'S'}</span>
                <span className="user-identity">
                  <strong>{user.name}</strong>
                  <small>{user.email}</small>
                </span>
                <Icon name="chevron-down" size={15} />
              </button>
              {profileOpen && (
                <div className="profile-menu__popover" role="menu">
                  <div className="profile-menu__identity">
                    <span className="eyebrow">Signed in as</span>
                    <strong>{user.name}</strong>
                    <small>{user.email}</small>
                  </div>
                  <div className="profile-menu__links">
                    <AppLink className={currentPath === '/profile' || currentPath === '/settings' ? 'is-active' : ''} href="/profile" onNavigate={navigate}>
                      <Icon name="settings" size={16} /> Profile &amp; settings
                    </AppLink>
                    <AppLink className={currentPath === '/library' ? 'is-active' : ''} href="/library" onNavigate={navigate}>
                      <Icon name="book" size={16} /> Your library
                    </AppLink>
                    <AppLink className={currentPath === '/credits' ? 'is-active' : ''} href="/credits" onNavigate={navigate}>
                      <Icon name="credit-card" size={16} /> Credits
                    </AppLink>
                  </div>
                  <button className="profile-menu__signout" onClick={() => void onLogout()} role="menuitem" type="button">
                    <Icon name="logout" size={16} /> Sign out
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>
      <main id="main-content">{children}</main>
    </div>
  );
}

function AppLoading() {
  return (
    <main className="app-loading" aria-live="polite">
      <span className="brand-mark">S</span>
      <div className="spinner" aria-hidden="true" />
      <p>Opening your learning space</p>
    </main>
  );
}

function NotFound({ onNavigate }: { onNavigate: (path: string) => void }) {
  return (
    <section className="page page--narrow empty-page">
      <p className="eyebrow">Page not found</p>
      <h1>This path does not exist.</h1>
      <p>Return to your dashboard to continue learning.</p>
      <button className="button button--primary" onClick={() => onNavigate('/')} type="button">
        Back to dashboard
      </button>
    </section>
  );
}

export function App() {
  const { path, navigate } = useLocation();
  const [auth, setAuth] = useState<AuthState>(() => getToken()
    ? { status: 'checking', user: null }
    : { status: 'anonymous', user: null });

  useEffect(() => {
    if (!getToken()) return;
    let active = true;
    api.me()
      .then(({ user }) => {
        if (active) setAuth({ status: 'authenticated', user });
      })
      .catch(() => {
        if (active) setAuth({ status: 'anonymous', user: null });
      });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const handleUnauthorized = () => setAuth({ status: 'anonymous', user: null });
    window.addEventListener('synau:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('synau:unauthorized', handleUnauthorized);
  }, []);

  const handleLogout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      // A local sign-out should still succeed when the session has already expired.
    } finally {
      clearToken();
      setAuth({ status: 'anonymous', user: null });
      navigate('/');
    }
  }, [navigate]);

  if (auth.status === 'checking') {
    return <AppLoading />;
  }

  if (auth.status === 'anonymous') {
    return <AuthScreen onAuthenticated={(user) => {
      setAuth({ status: 'authenticated', user });
      navigate('/');
    }} />;
  }

  const courseMatch = path.match(/^\/courses\/([^/]+)$/);
  let page: ReactNode;
  if (path === '/') {
    page = <Dashboard onOpenCourse={(courseId) => navigate(`/courses/${courseId}`)} onOpenLibrary={() => navigate('/library')} />;
  } else if (path === '/library') {
    page = <LibraryPage onBack={() => navigate('/')} onOpenCourse={(courseId) => navigate(`/courses/${courseId}`)} />;
  } else if (courseMatch) {
    page = <CourseWorkspace courseId={decodeURIComponent(courseMatch[1])} onBack={() => navigate('/')} />;
  } else if (path === '/credits') {
    page = <CreditsPage />;
  } else if (path === '/profile' || path === '/settings') {
    page = <ProfilePage onLogout={handleLogout} onNavigate={navigate} user={auth.user} />;
  } else if (path === '/quality') {
    page = <ProductProgressPage />;
  } else {
    page = <NotFound onNavigate={navigate} />;
  }

  return (
    <AppShell currentPath={path} onLogout={handleLogout} onNavigate={navigate} user={auth.user}>
      {page}
    </AppShell>
  );
}
