import { useMemo } from 'react';
import type { User } from '../types';
import { Icon } from './Icon';

type ProfilePageProps = {
  onLogout: () => Promise<void>;
  onNavigate: (path: string) => void;
  user: User;
};

export function ProfilePage({ onLogout, onNavigate, user }: ProfilePageProps) {
  const initials = useMemo(() => user.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join('').toUpperCase(), [user.name]);

  return (
    <div className="page profile-page">
      <header className="page-header">
        <p className="eyebrow">Account</p>
        <h1>Profile &amp; settings</h1>
        <p>Your account is the quiet control room for your learning space.</p>
      </header>

      <div className="profile-layout">
        <section className="profile-card profile-card--identity" aria-labelledby="profile-card-title">
          <div className="profile-card__label">
            <span className="eyebrow">Your profile</span>
            <span>ACCOUNT</span>
          </div>
          <div className="profile-identity-block">
            <span className="profile-avatar" aria-hidden="true">{initials || 'S'}</span>
            <div>
              <h2 id="profile-card-title">{user.name}</h2>
              <p>{user.email}</p>
            </div>
          </div>
          <dl className="profile-details">
            <div><dt>Account status</dt><dd><i /> Active</dd></div>
            <div><dt>Learning space</dt><dd>Personal</dd></div>
          </dl>
        </section>

        <section className="profile-card profile-card--settings" aria-labelledby="profile-settings-title">
          <div className="profile-card__label">
            <div>
              <span className="eyebrow">Account settings</span>
              <h2 id="profile-settings-title">Keep your essentials close</h2>
            </div>
            <Icon name="settings" size={19} />
          </div>
          <div className="profile-action-list">
            <button className="profile-action" onClick={() => onNavigate('/credits')} type="button">
              <span className="profile-action__icon"><Icon name="credit-card" size={18} /></span>
              <span><strong>Credits &amp; billing</strong><small>View balance, top up, and recent activity.</small></span>
              <Icon name="arrow-right" size={17} />
            </button>
            <button className="profile-action" onClick={() => onNavigate('/library')} type="button">
              <span className="profile-action__icon"><Icon name="book" size={18} /></span>
              <span><strong>Your learning paths</strong><small>Manage every course in your library.</small></span>
              <Icon name="arrow-right" size={17} />
            </button>
          </div>
        </section>
      </div>

      <section className="profile-security" aria-labelledby="profile-security-title">
        <div>
          <p className="eyebrow">Access</p>
          <h2 id="profile-security-title">Your account stays yours</h2>
          <p>Synau keeps generation behind the backend and uses this account to keep your courses, progress, and credits together.</p>
        </div>
        <button className="button button--secondary" onClick={() => void onLogout()} type="button">
          <Icon name="logout" size={16} /> Sign out
        </button>
      </section>
    </div>
  );
}
