import { db, newId, nowIso, json } from './db.js';
import { createUser, getUserByEmail } from './auth.js';
import { grantCredits, grantNewUserCredits } from './credits.js';

const email = 'demo@synau.local';
const demoCode = '020599';

let user = getUserByEmail(email);
if (!user) {
  user = createUser({ email, firstName: 'Demo', lastName: 'Learner', username: 'demo' });
  grantNewUserCredits(user.id);
}

grantCredits({
  userId: user.id,
  credits: 10_000,
  referenceId: 'demo-development-topup-10000',
  description: 'Development top-up: 10.000 demo credits',
  type: 'topup',
  metadata: { credits: 10_000, amountIdr: 100_000, source: 'development grant' },
});

const existing = db.prepare('SELECT id FROM courses WHERE user_id = ? LIMIT 1').get(user.id) as { id: string } | undefined;
if (!existing) {
  const courseId = newId();
  const sectionId = newId();
  const createdAt = nowIso();
  db.prepare(`INSERT INTO courses (id, user_id, topic, language, title, description, outcomes_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`).run(
    courseId,
    user.id,
    'Writing better product briefs',
    'en',
    'Writing better product briefs: a practical learning path',
    'A seeded course that demonstrates an existing learner state while new courses can still be created from a topic.',
    json(['Frame a product problem clearly', 'Make a brief useful to collaborators', 'Use feedback to improve a decision']),
    createdAt,
    createdAt,
  );
  db.prepare('INSERT INTO course_sections (id, course_id, title, summary, position) VALUES (?, ?, ?, ?, ?)')
    .run(sectionId, courseId, 'Foundations', 'The building blocks of a useful brief.', 0);
  for (const [position, lesson] of [
    ['Start with the decision', 'A brief is a decision aid, not a document dump.'],
    ['Make the problem observable', 'Turn broad intent into a clear, testable problem.'],
  ].entries()) {
    db.prepare('INSERT INTO lessons (id, section_id, title, summary, estimated_minutes, position) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId(), sectionId, lesson[0], lesson[1], 12 + position * 3, position);
  }
  db.prepare(`INSERT INTO progress_events (id, user_id, course_id, event_type, data_json, created_at)
    VALUES (?, ?, ?, 'course_seeded', ?, ?)`).run(newId(), user.id, courseId, json({ seeded: true }), createdAt);
}

console.log(JSON.stringify({ seeded: true, email, username: user.username, demoCode, database: process.env.SYNAU_DB_PATH ?? '.data/synau.db' }, null, 2));
