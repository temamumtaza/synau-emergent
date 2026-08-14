# Synau

Synau is a local-first agentic learning workspace. A learner enters a topic, reviews a generated roadmap, approves it, and receives each subchapter only when it is opened. The backend keeps a small course memory of generated takeaways and prompts so later subchapters can avoid unhelpful repetition.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). Supabase is the only runtime and Google is the only authentication provider. On the first Google sign-in, Synau asks for First Name, Last Name, and username; returning users go straight to their learning space.

The backend is configured with one fixed OpenAI-compatible provider: Sumopod's `deepseek-v4-flash` endpoint. The provider base URL and API key are server environment settings; the browser never receives or edits the provider key. Set `SYNAU_DEMO_MODE=true` only for deterministic local harnesses. Every generator is forced through a named function tool, sends thinking disabled, records provider usage, and is validated with the matching Zod schema.

## Product surfaces

- Dashboard: continue an existing course or start from a topic; the home library shows the six most recent paths.
- Library: manage every learning path from a dedicated full-library view, including rename and confirmed deletion.
- Profile & settings: account identity, access controls, library shortcut, and credits shortcut live behind the profile menu instead of a top navigation bar.
- Roadmap approval: inspect outcomes, sections, time estimates, and approve before persistence.
- Course workspace: navigate subchapters, lazy-generate material, complete freely, and revisit any lesson. New material is a single flowing article with a key takeaway and references; there are no practice, reflection, comparison, data-lab, or other card surfaces in the active learner reading flow.
- Lesson rendering: provider lesson output is intentionally loose. The model may return a Markdown string or another clear article/source representation; the backend extracts the readable content, filters unsafe metadata, and creates one renderer-safe Markdown record only after the call. The model can choose natural headings, paragraphs, emphasis, links, lists, blockquotes, tables, fenced code, and Mermaid when useful; there is no fixed section or card template. Markdown is sanitized in the browser, Mermaid is rendered with a visible code fallback, source markers remain clickable, and legacy structured lessons remain readable during migration. The lesson endpoint forwards incremental Markdown SSE events into the lesson article while the provider tool call is being assembled, then saves the normalized material. Generation is one-pass: there is no repair or retry model call after an invalid final envelope; the request fails and its credit hold is returned. `SYNAU_LESSON_MAX_OUTPUT_TOKENS` controls the streamed article budget (default 6,000; maximum 12,000).
- Quizzes: generate repeatable lesson, chapter, or course checks with exactly three questions: two grounded in the supplied article and one clearly marked challenge; attempts never gate progress.
- Progress: course completion, learning activity, and quality comparison evidence. The quality report remains available at `/quality` for internal review but is hidden from the learner navigation.
- Credits: backend-managed credit balance, Midtrans top-up checkout, recent ledger activity, and a read-only summary of the fixed Sumopod provider. The balance is visible next to the profile menu; the browser never receives the Sumopod API key.

Supabase is the only runtime (`SYNAU_STORAGE=supabase`). The backend uses the server-only `SUPABASE_SECRET_KEY` for application tables and to validate Supabase Auth Google sessions; the browser receives only the publishable key, while Synau application access uses a hashed opaque session in an `HttpOnly` cookie. RLS is enabled on every application table; browser roles have no table or RPC privileges, so learners can only reach the Express API boundary. The server fails fast when Supabase is not configured; there is no local database fallback.

### Production server

Production refuses to start without an explicit app origin and binds to `0.0.0.0` by default. Serve it behind HTTPS and set the cookie/security options for the deployed origin:

```bash
NODE_ENV=production \
SYNAU_HOST=0.0.0.0 \
SYNAU_CORS_ORIGIN=https://learn.example.com \
SYNAU_COOKIE_SECURE=true \
SYNAU_COOKIE_SAMESITE=lax \
npm start
```

The frontend no longer stores a Synau bearer token in `localStorage`. Bearer authentication is disabled in production unless `SYNAU_ALLOW_BEARER_AUTH=true` is explicitly enabled for a controlled QA harness. For multiple application replicas, put an edge/shared rate limiter in front of the process; the built-in limiter protects a single instance.

### GitHub Pages frontend

GitHub Pages can host Synau's static React frontend, but it cannot run the Express API, lesson generators, authentication session boundary, or provider key. The checked-in [`deploy-pages.yml`](/Users/temamumtaza/Documents/synau2026/.github/workflows/deploy-pages.yml) therefore builds only `dist/`. The Supabase browser variables are required; `SYNAU_API_BASE_URL` may remain empty for the initial static bootstrap and must be filled before login or generation can work:

- `SYNAU_API_BASE_URL`: public HTTPS URL of the Express/Supabase backend.
- `VITE_SUPABASE_URL`: the Supabase project URL.
- `VITE_SUPABASE_PUBLISHABLE_KEY`: the Supabase publishable browser key.

The Pages URL for this repository is `https://temamumtaza.github.io/synau-emergent/`. Add that exact URL to Supabase Auth's redirect allow list. Configure the backend CORS origin as `https://temamumtaza.github.io`; when the API is on a different site, use HTTPS with `SYNAU_COOKIE_SAMESITE=none` and `SYNAU_COOKIE_SECURE=true`. Do not put `SUPABASE_SECRET_KEY`, provider keys, or other server secrets into GitHub variables used by the frontend.

For a fresh Supabase project, configure the variables in `.env` (never put the secret in `NEXT_PUBLIC_*`, `VITE_*`, source control, or the browser bundle), link the project, and apply the schema:

```bash
supabase link --project-ref <project-ref> --skip-pooler
supabase db push --linked                 # requires SUPABASE_DB_PASSWORD
# If the database password is unavailable, run the checked-in migrations from the Supabase dashboard.
```

The checked-in schema migrations are under [`supabase/migrations`](/Users/temamumtaza/Documents/synau2026/supabase/migrations). To create a small remote fixture for an existing Google-linked profile, run `SYNAU_SEED_EMAIL='you@example.com' npm run seed:supabase`; the seed is idempotent and writes directly to Supabase.

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
npm run qa:security
```

The E2E runner uses a real Supabase Auth access token supplied through `SYNAU_TEST_TOKEN` and a headless Chromium browser. The harness injects it only into its isolated browser context as the `HttpOnly` `synau_session` cookie; it does not write `localStorage` or emulate the old client bearer flow. It exercises the authenticated topic-specific roadmap generation, roadmap approval, no-prefetch lazy lesson generation, verifies Markdown appears inside the real lesson article before the final response, then checks the article-only learner surface, completion, and a repeatable three-question quiz. `qa:provider:browser` repeats the same streaming assertion against the fixed provider. The access token is a headless QA harness input only; the running app uses the normal Google Supabase session.

The security boundary smoke confirms that backend source, shared/server-only modules, and environment files return `404` in development and production, generator endpoints reject unauthenticated requests, and the production client bundle contains no generator tool names, prompts, provider settings, or server secret names.

The UI shell smoke adds temporary learning paths, verifies the six-card dashboard cap, opens the profile-first settings and credits routes, confirms that `/quality` is not in learner navigation while remaining directly accessible, and checks the full `/library` view. Temporary fixtures are deleted after the run.

The performance smoke checks the authenticated dashboard request budget, cache-hot route clicks, cache expiry refreshes, and the single credit refresh emitted after a generator mutation. It requires an existing Supabase Auth access token through `SYNAU_PERF_TOKEN`; the harness never creates a local session.

Performance instrumentation is development-only and request-scoped: development/debug API responses include `x-request-id` and `Server-Timing` with application duration and Supabase query counts. Production keeps the request ID for tracing but suppresses timing detail unless `SYNAU_PERF_DEBUG=true`. User-private API responses remain `private, no-store`; caching is intentionally handled in the client with in-flight deduplication and targeted invalidation. Course lists and course details use metadata-only read models, while material is fetched only for the lesson being opened. Set `SYNAU_PERF_LOG=true` only when a local or protected development log sink is available.

The remote CRUD harness verifies one server-side RPC per course mutation, at most one additional auth lookup, metadata/material separation, and progress in the completion response:

```bash
SYNAU_BASE_URL=http://127.0.0.1:8787 npm run qa:performance:crud
```

The browser performance harness verifies the full dashboard request budget, cache-hot navigation, single refresh after expiry, and one credit refresh after roadmap generation:

```bash
SYNAU_BASE_URL=http://127.0.0.1:8792 \
SYNAU_PERF_TOKEN='<supabase-access-token>' \
SYNAU_PERF_CACHE_WAIT_MS=16000 SYNAU_PERF_SETTLE_WAIT_MS=2500 \
npx tsx scripts/performance-smoke.ts
```

The 8792 example assumes a deterministic Supabase QA server (`SYNAU_DEMO_MODE=true`); it never calls the paid model path. Keep `SYNAU_DEMO_MODE=false` for a provider run. Supabase free-tier network latency is still an external variable, so the harness records server-side timings and query counts separately from browser round-trip time.

For a live fixed-provider run, use a real Google-authenticated Supabase access token from the browser session:

```bash
SYNAU_TEST_TOKEN='<supabase-access-token>' npm run qa:provider
SYNAU_TEST_TOKEN='<supabase-access-token>' npm run qa:provider:browser
```

These checks cover the fixed provider, every generator, one-credit reserve/settlement per successful generator, lazy lesson opening, grounded three-question quizzes, progress, archive/reopen behavior, and Google-only auth boundaries. Temporary QA courses are deleted through the Supabase-backed API by their explicit IDs.

## Credits and Midtrans

Credits use a backend append-only ledger and LLM usage records for input, cached input, output, total tokens, request count, and settled credit cost. In Supabase mode holds, refunds, idempotent grants, and usage settlement run through locked server-side RPCs. Every new account receives 100 free credits exactly once. The demo account also has an additional 10,000-credit development top-up applied idempotently. Roadmap, lesson, and quiz generation each cost exactly 1 credit. Token usage is retained for diagnostics only and never changes the user charge. Failed, timed-out, invalid, and interrupted reservations are returned automatically, including stale reservation recovery after a process crash.

Top-up packages use a base rate of 100 credits per Rp1,000 and add a larger bonus at higher values: Rp15,000 = 1,500 credits; Rp30,000 = 3,010 credits (10 bonus); Rp50,000 = 5,025 credits (25 bonus); Rp100,000 = 10,050 credits (50 bonus).

Midtrans top-ups are currently disabled while the payment credentials are being corrected. Package cards remain visible as locked mockups, and the backend returns `410 midtrans_disabled` without calling the MCP. Reviewers and testers use the personal redeem-token field instead. A random 1,500-credit token is generated and stored in the database; it is never exposed through the UI, API response, logs, or seed output, and each account can redeem it only once. When payment is re-enabled, the existing Midtrans MCP and signed webhook path can be restored.
