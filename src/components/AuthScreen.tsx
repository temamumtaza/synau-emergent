import { useId, useState, type FormEvent } from 'react';
import { api, setToken } from '../api';
import type { AuthCodeResponse, User } from '../types';
import { Icon } from './Icon';

type AuthMode = 'login' | 'register';
type AuthStep = 'identify' | 'verify';

type AuthScreenProps = {
  onAuthenticated: (user: User) => void;
};

export function AuthScreen({ onAuthenticated }: AuthScreenProps) {
  const [mode, setMode] = useState<AuthMode>('login');
  const [step, setStep] = useState<AuthStep>('identify');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [challenge, setChallenge] = useState<AuthCodeResponse | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const errorId = useId();

  function resetStep() {
    setStep('identify');
    setCode('');
    setChallenge(null);
    setError('');
  }

  function changeMode(nextMode: AuthMode) {
    setMode(nextMode);
    resetStep();
  }

  async function requestCode() {
    setSubmitting(true);
    setError('');
    try {
      const result = mode === 'login'
        ? await api.requestSignInCode(identifier.trim())
        : await api.requestSignUpCode({
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            username: username.trim(),
            email: email.trim(),
          });
      setChallenge(result);
      setStep('verify');
      setCode('');
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Could not send a verification code.');
    } finally {
      setSubmitting(false);
    }
  }

  async function verifyCode() {
    if (!challenge) return;
    setSubmitting(true);
    setError('');
    try {
      const result = await api.verifyAuthCode(challenge.challengeId, code.trim());
      setToken(result.token);
      onAuthenticated(result.user);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'That verification code could not be accepted.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === 'verify') await verifyCode();
    else await requestCode();
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
          <h2 id="auth-title">{step === 'verify' ? 'Enter your code' : mode === 'login' ? 'Welcome back' : 'Create your account'}</h2>
          <p className="auth-intro">
            {step === 'verify'
              ? challenge?.message ?? 'Enter the six-digit code from your email.'
              : mode === 'login'
                ? 'Sign in securely with a code sent to your email.'
                : 'Create your learning space with a few details.'}
          </p>

          <div className="auth-tabs" role="tablist" aria-label="Account access">
            <button
              aria-selected={mode === 'login'}
              className={mode === 'login' ? 'is-active' : ''}
              onClick={() => changeMode('login')}
              role="tab"
              type="button"
            >
              Sign in
            </button>
            <button
              aria-selected={mode === 'register'}
              className={mode === 'register' ? 'is-active' : ''}
              onClick={() => changeMode('register')}
              role="tab"
              type="button"
            >
              Sign up
            </button>
          </div>

          <form className="auth-form" onSubmit={(event) => void handleSubmit(event)}>
            {step === 'identify' && mode === 'register' && (
              <div className="auth-name-grid">
                <label className="field">
                  <span>First Name</span>
                  <input
                    autoComplete="given-name"
                    onChange={(event) => setFirstName(event.target.value)}
                    placeholder="First name"
                    required
                    type="text"
                    value={firstName}
                  />
                </label>
                <label className="field">
                  <span>Last Name</span>
                  <input
                    autoComplete="family-name"
                    onChange={(event) => setLastName(event.target.value)}
                    placeholder="Last name"
                    required
                    type="text"
                    value={lastName}
                  />
                </label>
              </div>
            )}

            {step === 'identify' && mode === 'register' && (
              <label className="field">
                <span>Username</span>
                <input
                  autoComplete="username"
                  maxLength={32}
                  minLength={3}
                  onChange={(event) => setUsername(event.target.value)}
                  pattern="[A-Za-z0-9][A-Za-z0-9._-]{1,30}[A-Za-z0-9]"
                  placeholder="e.g. tema.learns"
                  required
                  type="text"
                  value={username}
                />
                <small>Use 3–32 letters, numbers, dots, underscores, or hyphens.</small>
              </label>
            )}

            {step === 'identify' && mode === 'register' && (
              <label className="field">
                <span>Email address</span>
                <input
                  aria-describedby={error ? errorId : undefined}
                  autoComplete="email"
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="you@example.com"
                  required
                  type="email"
                  value={email}
                />
              </label>
            )}

            {step === 'identify' && mode === 'login' && (
              <label className="field">
                <span>Email or username</span>
                <input
                  aria-describedby={error ? errorId : undefined}
                  autoComplete="username"
                  onChange={(event) => setIdentifier(event.target.value)}
                  placeholder="you@example.com or username"
                  required
                  type="text"
                  value={identifier}
                />
                <small>We will send a six-digit sign-in code to the email on your account.</small>
              </label>
            )}

            {step === 'verify' && (
              <>
                <div className="auth-code-notice">
                  <span className="auth-code-notice__mark"><Icon name="check" size={16} /></span>
                  <div>
                    <strong>Check {challenge?.maskedEmail}</strong>
                    <p>The code is valid for {challenge ? Math.max(1, Math.round((new Date(challenge.expiresAt).getTime() - Date.now()) / 60_000)) : 10} minutes.</p>
                  </div>
                </div>
                {challenge?.isDemo && <p className="auth-demo-note">Demo account code: <strong>020599</strong></p>}
                <label className="field">
                  <span>Verification code</span>
                  <input
                    aria-describedby={error ? errorId : undefined}
                    autoComplete="one-time-code"
                    autoFocus
                    inputMode="numeric"
                    maxLength={6}
                    onChange={(event) => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))}
                    pattern="[0-9]{6}"
                    placeholder="000000"
                    required
                    type="text"
                    value={code}
                  />
                </label>
              </>
            )}

            {error && <p className="form-error" id={errorId} role="alert">{error}</p>}

            <button className="button button--primary button--wide" disabled={submitting || (step === 'verify' && code.length !== 6)} type="submit">
              <span>
                {submitting
                  ? step === 'verify' ? 'Verifying code' : 'Sending code'
                  : step === 'verify' ? 'Verify and continue' : mode === 'login' ? 'Send sign-in code' : 'Send verification code'}
              </span>
              {!submitting && <Icon name="arrow-right" />}
              {submitting && <span className="spinner spinner--light" aria-hidden="true" />}
            </button>
          </form>

          {step === 'verify' ? (
            <div className="auth-code-actions">
              <button disabled={submitting} onClick={() => void requestCode()} type="button">Resend code</button>
              <span aria-hidden="true">·</span>
              <button disabled={submitting} onClick={resetStep} type="button">Use a different account</button>
            </div>
          ) : (
            <p className="auth-switch">
              {mode === 'login' ? 'New to Synau?' : 'Already have an account?'}{' '}
              <button onClick={() => changeMode(mode === 'login' ? 'register' : 'login')} type="button">
                {mode === 'login' ? 'Create an account' : 'Sign in instead'}
              </button>
            </p>
          )}
        </div>
      </section>
    </main>
  );
}
