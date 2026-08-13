# Synau

Synau is a local-first agentic learning workspace. A learner enters a topic, reviews a generated roadmap, approves it, and receives each subchapter only when it is opened. The backend keeps a small course memory of generated takeaways and prompts so later subchapters can avoid unhelpful repetition.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). Supabase mode uses Google as the only authentication provider. On the first Google sign-in, Synau asks for First Name, Last Name, and username; returning users go straight to their learning space. The SQLite fallback still keeps the email-code harness for deterministic local QA.

The backend is configured with one fixed OpenAI-compatible provider: Sumopod's `deepseek-v4-flash` endpoint. The provider base URL and API key are server environment settings; the browser never receives or edits the provider key. Set `SYNAU_DEMO_MODE=true` only for deterministic local harnesses. Every generator is forced through a named function tool, sends thinking disabled, records provider usage, and is validated with the matching Zod schema.

## Product surfaces

- Dashboard: continue an existing course or start from a topic; the home library shows the six most recent paths.
- Library: manage every learning path from a dedicated full-library view, including rename and confirmed deletion.
- Profile & settings: account identity, access controls, library shortcut, and credits shortcut live behind the profile menu instead of a top navigation bar.
- Roadmap approval: inspect outcomes, sections, time estimates, and approve before persistence.
- Course workspace: navigate subchapters, lazy-generate material, complete freely, and revisit any lesson. New material is a single flowing article with a key takeaway and references; there are no practice, reflection, comparison, data-lab, or other card surfaces in the active learner reading flow.
- Lesson rendering: the Zod contract accepts only paragraph, code snippet, equation, Mermaid diagram, structured table, and quote blocks. Paragraphs are the default; optional blocks stay inline and are emitted only when they materially clarify the topic. The article prompt requires a two-sentence editorial deck, a distinct 45+ word opening, a natural 2–5 section arc, and a Mermaid diagram when the lesson explains a process, framework, relationship, or sequence. Code is escaped, equations use KaTeX, Mermaid is sanitized and has a visible code fallback, tables render accessibly, quotes can link to a source, and unsupported formats are rejected server-side. A small backend normalizer handles safe provider aliases such as `text` on a code/equation/diagram block before the same strict Zod contract runs. Legacy stored lessons remain readable during migration.
- Quizzes: generate repeatable lesson, chapter, or course checks with exactly three questions: two grounded in the supplied article and one clearly marked challenge; attempts never gate progress.
- Progress: course completion, learning activity, and quality comparison evidence. The quality report remains available at `/quality` for internal review but is hidden from the learner navigation.
- Credits: backend-managed credit balance, Midtrans top-up checkout, recent ledger activity, and a read-only summary of the fixed Sumopod provider. The balance is visible next to the profile menu; the browser never receives the Sumopod API key.

Supabase is the active runtime when `SYNAU_STORAGE=supabase`. The backend uses the server-only `SUPABASE_SECRET_KEY` for application tables and to validate Supabase Auth Google sessions; the browser receives only the publishable key and the OAuth session. RLS is enabled on every application table; browser roles have no table or RPC privileges, so learners can only reach the Express API boundary. The SQLite implementation remains an explicit local fallback at `.data/synau.db`; in Supabase mode the native SQLite module is not loaded at startup.

For a fresh Supabase project, configure the variables in `.env` (never put the secret in `NEXT_PUBLIC_*`, `VITE_*`, source control, or the browser bundle), link the project, apply the schema, and migrate the existing local data:

```bash
supabase link --project-ref <project-ref> --skip-pooler
supabase db push --linked                 # requires SUPABASE_DB_PASSWORD
# If the database password is unavailable, use the linked Management API:
supabase db query --linked --file supabase/migrations/20260812113729_synau_core_schema.sql
npm run migrate:supabase                  # reads .data/synau.db and writes Supabase
```

`npm run migrate:supabase` preserves Synau IDs, creates or maps Supabase Auth users, migrates courses, sections, lazy lesson material, quiz attempts, progress events, credits, LLM usage, top-ups, sessions, and auth challenges, then verifies row counts. The checked-in migration is [supabase/migrations/20260812113729_synau_core_schema.sql](/Users/temamumtaza/Documents/synau2026/supabase/migrations/20260812113729_synau_core_schema.sql). Set `SYNAU_STORAGE=sqlite` and run `npm run seed` only when intentionally using the local fallback.

### Supabase Google authentication

Create a Web OAuth client in Google Cloud. Add the app origins (`http://localhost:8787` and `http://127.0.0.1:8787` during development) as authorized JavaScript origins. Add the exact Supabase callback shown in Authentication → Providers → Google as an authorized redirect URI; for this hosted project it follows `https://<project-ref>.supabase.co/auth/v1/callback`. In Supabase Authentication → URL Configuration, add both local app URLs to the redirect allow list.

For a repeatable hosted setup, add a Supabase Personal Access Token and the Google OAuth client values to your local `.env`, then run:

```bash
npm run auth:configure-google
```

The command enables Google and disables Supabase email auth through the Management API. `SUPABASE_SECRET_KEY` cannot perform this configuration; do not paste either token or Google secret into source control or the browser bundle. The dashboard equivalent is Authentication → Providers → Google and Authentication → URL Configuration. Supabase Auth still has abuse protection/rate limits on authentication endpoints, but Google-only login avoids the hosted email-send quota; repeated OAuth attempts can still receive HTTP 429 and should be handled with retry/backoff.

## Verification

```bash
npm run typecheck
npm run build
npm run e2e
npm run qa:ui-shell
npm run qa:performance
```

The E2E runner uses the seeded account and a headless Chromium browser. It exercises login, topic-specific roadmap generation, roadmap approval, no-prefetch lazy lesson generation, the article-only learner surface, completion, and a repeatable three-question quiz.

The UI shell smoke adds temporary learning paths, verifies the six-card dashboard cap, opens the profile-first settings and credits routes, confirms that `/quality` is not in learner navigation while remaining directly accessible, and checks the full `/library` view. Temporary fixtures are deleted after the run.

The performance smoke checks the authenticated dashboard request budget, cache-hot route clicks, cache expiry refreshes, and the single credit refresh emitted after a generator mutation. A local SQLite run creates a temporary session from `SYNAU_PERF_EMAIL`; a hosted-auth run must provide an existing browser session token through `SYNAU_PERF_TOKEN`.

Performance instrumentation is development-only and request-scoped: development/debug API responses include `x-request-id` and `Server-Timing` with application duration and Supabase query counts. Production keeps the request ID for tracing but suppresses timing detail unless `SYNAU_PERF_DEBUG=true`. User-private API responses remain `private, no-store`; caching is intentionally handled in the client with in-flight deduplication and targeted invalidation. Course lists and course details use metadata-only read models, while material is fetched only for the lesson being opened. Set `SYNAU_PERF_LOG=true` only when a local or protected development log sink is available.

The remote CRUD harness verifies one server-side RPC per course mutation, at most one additional auth lookup, metadata/material separation, and progress in the completion response:

```bash
SYNAU_BASE_URL=http://127.0.0.1:8787 npm run qa:performance:crud
```

The browser performance harness verifies the full dashboard request budget, cache-hot navigation, single refresh after expiry, and one credit refresh after roadmap generation:

```bash
SYNAU_STORAGE=supabase SYNAU_BASE_URL=http://127.0.0.1:8792 \
SYNAU_PERF_REMOTE_EMAIL='demo@synau.local' \
SYNAU_PERF_CACHE_WAIT_MS=16000 SYNAU_PERF_SETTLE_WAIT_MS=2500 \
npx tsx scripts/performance-smoke.ts
```

The 8792 example assumes a deterministic Supabase QA server (`SYNAU_DEMO_MODE=true`); it never calls the paid model path. Keep `SYNAU_DEMO_MODE=false` for a provider run. Supabase free-tier network latency is still an external variable, so the harness records server-side timings and query counts separately from browser round-trip time.

For a live fixed-provider run against the local SQLite harness, use the demo credentials:

```bash
SYNAU_TEST_EMAIL='demo@synau.local' SYNAU_TEST_CODE='020599' npm run qa:provider
SYNAU_TEST_EMAIL='demo@synau.local' SYNAU_TEST_CODE='020599' npm run qa:provider:browser
```

These checks cover the fixed provider, every generator, one-credit reserve/settlement per successful generator, lazy lesson opening, grounded three-question quizzes, progress, archive/reopen behavior, and the local email-code fallback. Supabase Google OAuth requires a real browser session and configured Google provider, so it is not synthetically claimed by these harnesses. Temporary QA courses are deleted by their explicit IDs after each run.

## Credits and Midtrans

Credits use a backend append-only ledger and LLM usage records for input, cached input, output, total tokens, request count, and settled credit cost. In Supabase mode holds, refunds, idempotent grants, and usage settlement run through locked server-side RPCs. Every new account receives 100 free credits exactly once. The demo account also has an additional 10,000-credit development top-up applied idempotently. Roadmap, lesson, and quiz generation each cost exactly 1 credit. Token usage is retained for diagnostics only and never changes the user charge. Failed, timed-out, invalid, and interrupted reservations are returned automatically, including stale reservation recovery after a process crash.

Top-up packages use a base rate of 100 credits per Rp1,000 and add a larger bonus at higher values: Rp15,000 = 1,500 credits; Rp30,000 = 3,010 credits (10 bonus); Rp50,000 = 5,025 credits (25 bonus); Rp100,000 = 10,050 credits (50 bonus).

Midtrans top-ups are currently disabled while the payment credentials are being corrected. Package cards remain visible as locked mockups, and the backend returns `410 midtrans_disabled` without calling the MCP. Reviewers and testers use the personal redeem-token field instead. A random 1,500-credit token is generated and stored in the database; it is never exposed through the UI, API response, logs, or seed output, and each account can redeem it only once. When payment is re-enabled, the existing Midtrans MCP and signed webhook path can be restored.
