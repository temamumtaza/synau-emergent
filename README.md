# Synau

Synau is a local-first agentic learning workspace. A learner enters a topic, reviews a generated roadmap, approves it, and receives each subchapter only when it is opened. The backend keeps a small course memory of generated takeaways and prompts so later subchapters can avoid unhelpful repetition.

## Run locally

```bash
npm install
npm run dev
```

Open [http://localhost:8787](http://localhost:8787). The seeded login is:

- Email: `demo@synau.local`
- Verification code: `020599`

Authentication is passwordless. Sign in with an email or username, request a six-digit code, and verify it. New accounts require First Name, Last Name, username, and email before the verification code is sent. The demo account is the only local exception and accepts `020599`.

For real email delivery, configure `SYNAU_EMAIL_MODE=smtp`, `SYNAU_EMAIL_FROM`, and the `SYNAU_SMTP_*` variables in the backend environment. During local development, `SYNAU_EMAIL_MODE=console` prints the generated code to the server terminal; it is never the production default.

The backend is configured with one fixed OpenAI-compatible provider: Sumopod's `deepseek-v4-flash` endpoint. The provider base URL and API key are server environment settings; the browser never receives or edits the provider key. Set `SYNAU_DEMO_MODE=true` only for deterministic local harnesses. Every generator is forced through a named function tool, sends thinking disabled, records provider usage, and is validated with the matching Zod schema.

## Product surfaces

- Dashboard: continue an existing course or start from a topic; the home library shows the six most recent paths.
- Library: manage every learning path from a dedicated full-library view, including rename and confirmed deletion.
- Profile & settings: account identity, access controls, library shortcut, and credits shortcut live behind the profile menu instead of a top navigation bar.
- Roadmap approval: inspect outcomes, sections, time estimates, and approve before persistence.
- Course workspace: navigate subchapters, lazy-generate material, complete freely, and revisit any lesson. Topic-specific material can include worked examples, an illustrative data lab with prompts and a revealable worked reading, practice steps, a self-check rubric, and a locally saved draft.
- Lesson rendering: new provider lessons are flowing article documents first: 2–5 sections of natural paragraphs with inline source links and a references list. The model may add a supported `example`, `comparison`, `scenario`, `flow`, `timeline`, or `code` component only when it improves the lesson; unknown formats are rejected server-side, while legacy block lessons remain readable.
- Quizzes: generate repeatable lesson, chapter, or course checks; attempts never gate progress.
- Progress: course completion, learning activity, and quality comparison evidence. The quality report remains available at `/quality` for internal review but is hidden from the learner navigation.
- Credits: backend-managed credit balance, Midtrans top-up checkout, recent ledger activity, and a read-only summary of the fixed Sumopod provider. The balance is visible next to the profile menu; the browser never receives the Sumopod API key.

Supabase is the active runtime when `SYNAU_STORAGE=supabase`. The backend uses the server-only `SUPABASE_SECRET_KEY` for the application tables and Supabase Auth's publishable key only for email OTP. RLS is enabled on every application table; browser roles have no table or RPC privileges, so learners can only reach the Express API boundary. The SQLite implementation remains an explicit local fallback at `.data/synau.db`; in Supabase mode the native SQLite module is not loaded at startup.

For a fresh Supabase project, configure the variables in `.env` (never put the secret in `NEXT_PUBLIC_*`, `VITE_*`, source control, or the browser bundle), link the project, apply the schema, and migrate the existing local data:

```bash
supabase link --project-ref <project-ref> --skip-pooler
supabase db push --linked                 # requires SUPABASE_DB_PASSWORD
# If the database password is unavailable, use the linked Management API:
supabase db query --linked --file supabase/migrations/20260812113729_synau_core_schema.sql
npm run migrate:supabase                  # reads .data/synau.db and writes Supabase
```

`npm run migrate:supabase` preserves Synau IDs, creates or maps Supabase Auth users, migrates courses, sections, lazy lesson material, quiz attempts, progress events, credits, LLM usage, top-ups, sessions, and auth challenges, then verifies row counts. The checked-in migration is [supabase/migrations/20260812113729_synau_core_schema.sql](/Users/temamumtaza/Documents/synau2026/supabase/migrations/20260812113729_synau_core_schema.sql). Set `SYNAU_STORAGE=sqlite` and run `npm run seed` only when intentionally using the local fallback.

## Verification

```bash
npm run typecheck
npm run build
npm run e2e
npm run qa:ui-shell
```

The E2E runner uses the seeded account and a headless Chromium browser. It exercises login, topic-specific roadmap generation, roadmap approval, lazy lesson generation, data-lab reveal, practice draft saving, completion, and a repeatable quiz.

The UI shell smoke adds temporary learning paths, verifies the six-card dashboard cap, opens the profile-first settings and credits routes, confirms that `/quality` is not in learner navigation while remaining directly accessible, and checks the full `/library` view. Temporary fixtures are deleted after the run.

For a live fixed-provider run, use a configured backend environment and run the provider checks with the demo credentials:

```bash
SYNAU_TEST_EMAIL='demo@synau.local' SYNAU_TEST_CODE='020599' npm run qa:provider
SYNAU_TEST_EMAIL='demo@synau.local' SYNAU_TEST_CODE='020599' npm run qa:provider:browser
```

These checks cover the fixed provider, every generator, credit reserve/settlement, lazy lesson opening, repeatable quizzes, progress, archive/reopen behavior, and authentication. Temporary QA courses are deleted by their explicit IDs after each run.

## Credits and Midtrans

Credits use a backend append-only ledger and LLM usage records for input, cached input, output, total tokens, request count, and settled credit cost. In Supabase mode holds, refunds, idempotent grants, and usage settlement run through locked server-side RPCs. Every new account receives 100 free credits exactly once. The demo account also has an additional 10,000-credit development top-up applied idempotently. Roadmap, lesson, and quiz generation each cost exactly 1 credit. Token usage is retained for diagnostics only and never changes the user charge. Failed, timed-out, invalid, and interrupted reservations are returned automatically, including stale reservation recovery after a process crash.

Top-up packages use a base rate of 100 credits per Rp1,000 and add a larger bonus at higher values: Rp15,000 = 1,500 credits; Rp30,000 = 3,010 credits (10 bonus); Rp50,000 = 5,025 credits (25 bonus); Rp100,000 = 10,050 credits (50 bonus).

Top-ups create a Midtrans Snap token through the [`@theyahia/midtrans-mcp`](https://github.com/theyahia/midtrans-mcp) MCP server, then wait for the signed `/api/midtrans/notification` webhook before adding credits. Configure the notification URL in the Midtrans dashboard as a public HTTPS endpoint when deploying; localhost cannot receive Midtrans callbacks directly. Keep the server key and Sumopod key in `.env` or a production secret manager, never in the client bundle or repository.
