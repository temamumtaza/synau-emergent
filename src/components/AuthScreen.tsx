import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import type { User } from '../types';
import { Icon } from './Icon';
import { getSupabaseBrowserClient, signInWithGoogle, supabaseBrowserConfigured } from '../supabase';

type AuthScreenProps = {
  onAuthenticated: (user: User) => void;
};

function GoogleMark() {
  return (
    <svg
      aria-hidden="true"
      className="google-auth-button__icon"
      focusable="false"
      viewBox="0 0 24 24"
    >
      <path fill="currentColor" d="M21.35 12.27c0-.79-.07-1.55-.2-2.27H12v4.3h5.24a4.48 4.48 0 0 1-1.94 2.94v2.45h3.14c1.84-1.69 2.91-4.18 2.91-7.42Z" />
      <path fill="currentColor" d="M12 21.5c2.63 0 4.84-.87 6.45-2.36l-3.14-2.45c-.87.58-1.98.92-3.31.92-2.54 0-4.69-1.71-5.46-4.01H3.3v2.52A9.74 9.74 0 0 0 12 21.5Z" />
      <path fill="currentColor" d="M6.54 13.6A5.87 5.87 0 0 1 6.23 12c0-.56.1-1.1.31-1.6V7.88H3.3A9.74 9.74 0 0 0 2.25 12c0 1.57.38 3.05 1.05 4.12l3.24-2.52Z" />
      <path fill="currentColor" d="M12 6.39c1.43 0 2.71.49 3.72 1.45l2.79-2.79C16.84 3.48 14.63 2.5 12 2.5a9.74 9.74 0 0 0-8.7 5.38l3.24 2.52C7.31 8.1 9.46 6.39 12 6.39Z" />
    </svg>
  );
}

function GoogleButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  return (
    <button className="google-auth-button" disabled={disabled} onClick={onClick} type="button">
      <span className="google-auth-button__side google-auth-button__side--leading"><GoogleMark /></span>
      <span className="google-auth-button__label">{disabled ? 'Opening Google' : 'Continue with Google'}</span>
      <span className="google-auth-button__side google-auth-button__side--trailing">
        {disabled ? <span className="spinner" aria-hidden="true" /> : <Icon name="arrow-right" />}
      </span>
    </button>
  );
}

function GoogleAuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [step, setStep] = useState<'google' | 'profile'>('google');
  const [accessToken, setAccessToken] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [submitting, setSubmitting] = useState(true);
  const [error, setError] = useState('');
  const errorId = useId();
  const resumedToken = useRef('');

  async function completeGoogleSession(token: string, profile?: { firstName: string; lastName: string; username: string }) {
    if (!profile && resumedToken.current === token) return;
    if (!profile) resumedToken.current = token;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.completeGoogleAuth(token, profile);
      if (result.status === 'profile_required') {
        setAccessToken(token);
        setEmail(result.profile.email);
        setFirstName(result.profile.firstName);
        setLastName(result.profile.lastName);
        setUsername(result.profile.username);
        setStep('profile');
        return;
      }
      onAuthenticated(result.user);
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Google sign-in could not be completed.');
    } finally {
      setSubmitting(false);
    }
  }

  useEffect(() => {
    let active = true;
    async function resumeGoogleSession() {
      try {
        if (!supabaseBrowserConfigured()) throw new Error('Google sign-in is not configured for this environment.');
        const { data, error: sessionError } = await getSupabaseBrowserClient().auth.getSession();
        if (sessionError) throw sessionError;
        if (active && data.session) await completeGoogleSession(data.session.access_token);
      } catch (authError) {
        if (active) setError(authError instanceof Error ? authError.message : 'Google sign-in is unavailable.');
      } finally {
        if (active) setSubmitting(false);
      }
    }
    void resumeGoogleSession();
    return () => { active = false; };
  }, []);

  async function startGoogleSignIn() {
    setSubmitting(true);
    setError('');
    try {
      await signInWithGoogle();
    } catch (authError) {
      setError(authError instanceof Error ? authError.message : 'Google sign-in could not be started.');
      setSubmitting(false);
    }
  }

  async function submitProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!accessToken) return;
    await completeGoogleSession(accessToken, { firstName: firstName.trim(), lastName: lastName.trim(), username: username.trim() });
  }

  return (
    <main className="auth-layout">
      <section className="auth-story" aria-labelledby="auth-story-title">
        <a className="brand brand--inverse" href="/" aria-label="Synau home">
          <span className="brand-mark">S</span>
          <span>Synau</span>
        </a>
        <div className="auth-story__content">
          <p className="eyebrow eyebrow--inverse">Learning, deliberately shaped</p>
          <h1 id="auth-story-title">Turn curiosity into a path you can finish.</h1>
          <p>
            Start with any topic. Review the plan before it becomes a course, then learn one focused
            subchapter at a time.
          </p>
        </div>
        <div className="auth-principles" aria-label="Product principles">
          <div><span>01</span><p>A clear path before content</p></div>
          <div><span>02</span><p>Lessons generated when needed</p></div>
          <div><span>03</span><p>Practice without progress gates</p></div>
        </div>
      </section>

      <section className="auth-panel" aria-labelledby="auth-title">
        <div className="auth-panel__inner">
          <div className="auth-mobile-brand">
            <span className="brand-mark">S</span>
            <span>Synau</span>
          </div>
          <p className="eyebrow">Your learning space</p>
          <h2 id="auth-title">{step === 'profile' ? 'Complete your profile' : 'Welcome to Synau'}</h2>
          <p className="auth-intro">
            {step === 'profile'
              ? 'One last step. Confirm the details that will appear in your Synau profile.'
              : 'Sign in or create your account securely with Google.'}
          </p>

          {step === 'google' ? (
            <div className="auth-google-panel">
              <GoogleButton disabled={submitting} onClick={() => void startGoogleSignIn()} />
              <p className="auth-provider-note">Google is the only sign-in method for Synau. Your Google account handles authentication; Synau only stores your learning profile.</p>
            </div>
          ) : (
            <form className="auth-form auth-profile-form" onSubmit={(event) => void submitProfile(event)}>
              <label className="field">
                <span>Email</span>
                <input disabled type="email" value={email} />
              </label>
              <div className="auth-name-grid">
                <label className="field">
                  <span>First Name</span>
                  <input autoComplete="given-name" onChange={(event) => setFirstName(event.target.value)} required type="text" value={firstName} />
                </label>
                <label className="field">
                  <span>Last Name</span>
                  <input autoComplete="family-name" onChange={(event) => setLastName(event.target.value)} required type="text" value={lastName} />
                </label>
              </div>
              <label className="field">
                <span>Username</span>
                <input
                  autoComplete="username"
                  maxLength={32}
                  minLength={3}
                  onChange={(event) => setUsername(event.target.value)}
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]"
                  required
                  type="text"
                  value={username}
                />
                <small>Use 3–32 letters, numbers, dots, underscores, or hyphens.</small>
              </label>
              {error && <p className="form-error" id={errorId} role="alert">{error}</p>}
              <button className="button button--primary button--wide" disabled={submitting} type="submit">
                <span>{submitting ? 'Saving profile' : 'Continue to Synau'}</span>
                {!submitting && <Icon name="arrow-right" />}
                {submitting && <span className="spinner spinner--light" aria-hidden="true" />}
              </button>
            </form>
          )}

          {step === 'google' && error && <p className="form-error auth-google-error" id={errorId} role="alert">{error}</p>}
          {step === 'profile' && (
            <div className="auth-code-actions">
              <button disabled={submitting} onClick={() => void getSupabaseBrowserClient().auth.signOut()} type="button">Use a different Google account</button>
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

function AuthLoading() {
  return (
    <main className="app-loading" aria-live="polite">
      <span className="brand-mark">S</span>
      <div className="spinner" aria-hidden="true" />
      <p>Preparing secure sign-in</p>
    </main>
  );
}

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  return <GoogleAuthScreen onAuthenticated={onAuthenticated} />;
}
