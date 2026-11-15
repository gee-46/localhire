# LocalHire: deployment, rollback and launch checklist

This is the operating procedure for staging and production. It describes what the repository enforces, what **you** must configure in
external dashboards, and what has and has not been verified. Nothing here requires, or should trigger, a destructive database action.

## 0. Ground rules

| Never | Why / what stops it |
|---|---|
| `prisma migrate reset`, `prisma db push --force-reset`, `DROP SCHEMA`, restoring a dump over a live database without a plan | Destroys customers, payments and ledgers. Only ever use `prisma migrate deploy` (applies pending migrations, never resets). |
| `npm run prisma:seed` on a real database | Creates fictional accounts with a published password. The script **refuses** when `NODE_ENV=production`. On staging, do not run it either: use real test accounts. |
| `npm test` against staging or production data | The tests create and delete rows. `npm test` **refuses** under `NODE_ENV=production`, and refuses a hosted Supabase `DATABASE_URL` unless `ALLOW_TESTS_ON_HOSTED_DB=yes` is set deliberately (use only for a throw-away project). |
| Live payments or live payouts without explicit sign-off | See section 6. |
| Committing `.env` | `.gitignore` excludes it. Secrets live only in the host's secret store and the provider dashboards. |

## 1. Environments

* **Local**: `NODE_ENV=development`, local or dev Supabase, Razorpay **test** keys. Missing optional settings are warnings.
* **Staging**: a **separate** Supabase project, **separate** database, Razorpay **test** keys, its own webhook. Run it with
  `NODE_ENV=production` so it behaves exactly like production (HTTPS redirect, hidden errors, strict CORS, mandatory secrets). A staging
  server that runs in development mode proves nothing about production.
* **Production**: its own Supabase project and database, Razorpay **live** keys (only after sign-off, section 6), `NODE_ENV=production`.

Never point two environments at the same database or the same Supabase project.

## 2. What the server does at startup

`server/config/env.js` validates the environment before the server listens. With `NODE_ENV=production` the process **exits with
a clear `[FATAL]` message** (variable names only, never values) if any of these is missing, a placeholder, a development default or malformed:
`JWT_SECRET` (random, at least 32 characters), `DATABASE_URL`, `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY`
(and the two keys must differ), `CLIENT_URL` and `SERVER_PUBLIC_URL` (https, not localhost), `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` +
`RAZORPAY_WEBHOOK_SECRET`, plus `NODE_ENV` itself (a typo such as `prod` is refused), `PAYOUT_MODE`, the percentage settings (0-100),
`BUSINESS_TIMEZONE`, `ALLOWED_ORIGIN` (no `*`, https only), and VAPID keys (all three valid or none).
It warns (does not stop) about: Razorpay **test** keys, `PAYOUT_MODE=ROUTE`, missing `TRUST_PROXY`, missing push keys, missing `DIRECT_URL`.

Also enforced in production: HTTP is redirected to HTTPS (needs `TRUST_PROXY`), `Strict-Transport-Security` is sent, development origins
(`localhost`) and the opaque `null` origin are not trusted by CORS, and no error text, SQL fragment or stack trace is ever returned to a client
(the server log has it). `X-Powered-By` is removed; `nosniff`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` and `Cache-Control: no-store` (API) are always set.

## 3. Environment variables

Set these in the host's secret store (never in the repository or the frontend). `Req` = required in production.

| Variable | Req | Where it comes from / notes |
|---|---|---|
| `NODE_ENV` | yes | `production` on staging and production. |
| `PORT` | no | Provided by most hosts. |
| `JWT_SECRET` | yes | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Different per environment. Changing it signs everyone out. |
| `DATABASE_URL` | yes | Supabase → Connect → pooled connection (port 6543, `?pgbouncer=true`). |
| `DIRECT_URL` | for migrations | Supabase direct/session connection (port 5432). Used by `prisma migrate deploy`. |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | yes | Supabase → Project Settings → API. The service-role key is a server secret and bypasses RLS. |
| `CLIENT_URL`, `SERVER_PUBLIC_URL` | yes | The public https URL of the app (the same value, since Express serves the frontend). |
| `ALLOWED_ORIGIN` | no | Comma-separated exact https origins. Empty is fine when the frontend is served by this server. |
| `TRUST_PROXY` | yes behind a proxy | Number of proxies in front of the app, normally `1`. Without it every visitor shares the proxy's IP (rate limits become one shared bucket) and HTTPS cannot be detected. Do not use `true`. |
| `FORCE_HTTPS` | no | `false` only if your platform already redirects and you must disable the app's redirect. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | yes | Razorpay → Settings → API Keys (`rzp_test_...` for staging). |
| `RAZORPAY_WEBHOOK_SECRET` | yes | Chosen by you when creating the webhook. Different from the key secret. |
| `PAYOUT_MODE` | no | Leave `LEDGER_ONLY` (default). `ROUTE` only after section 6. |
| `WORKER_COMMISSION_PERCENT` | no | Default **10**. `PLATFORM_FEE_PERCENT`, `PLATFORM_FEE_TAX_PERCENT`, `CUSTOMER_CANCELLATION_FEE_PERCENT` default 0. |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | `npm --prefix server run push:generate-keys`; subject `mailto:ops@yourdomain`. All three or none. |
| `BUSINESS_TIMEZONE` | no | Default `Asia/Kolkata`. |
| `REVIEW_RATE_LIMIT_MAX`, `REVIEW_READ_RATE_LIMIT_MAX`, `PAYMENT_RATE_LIMIT_MAX`, `TRACKING_RATE_LIMIT_MAX`, `PUSH_RATE_LIMIT_MAX` | no | Rate-limit tuning (defaults are sensible). |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | no | Only for the **development** seed. Do not set in production. |

## 4. Dashboard settings you must configure

**Supabase (per environment)**
1. Authentication → Providers → Email: enabled, **Confirm email = ON**.
2. Authentication → URL Configuration: Site URL = `CLIENT_URL`; Redirect URLs exactly `<CLIENT_URL>/pages/auth.html` and `<SERVER_PUBLIC_URL>/api/auth/google/callback`.
3. Project Settings → Authentication → SMTP: your own SMTP provider (the built-in mailer only reaches team members and is rate-limited to a few emails per hour). Raise the email rate limit.
4. Authentication → Providers → Google (Client ID/Secret); in Google Cloud, the authorized redirect URI is the **Supabase** one `https://<project-ref>.supabase.co/auth/v1/callback`.
5. Storage → bucket **`profile-photos`**: public; file size limit 5 MB; allowed types `image/jpeg, image/png, image/webp` only; **no** anonymous upload/update/delete policy.
6. Storage → bucket **`worker-documents`**: **private**; limit 8 MB; allowed `application/pdf, image/jpeg, image/png, image/webp`. The server creates it on first use as private, and refuses to use it if it is public. No policies for `anon`/`authenticated`: only the service-role key accesses it, and admins get 2-minute signed URLs.
7. Backups: confirm daily backups are on; for production enable Point-in-Time Recovery (paid plan) before launch.
8. After configuring, run `npm --prefix server run storage:verify` and `npm --prefix server run auth:verify` with that environment's real variables. These are read-only/non-destructive checks of the live project.
9. The first migration grants/revokes on the Supabase roles `anon`, `authenticated`, `service_role`, and PostGIS is created in schema `extensions`. A Supabase project has both. On a plain PostgreSQL server you must first create those roles and enable PostGIS.

**Razorpay (per environment)**
1. Settings → API Keys: test keys for staging; live keys only after section 6.
2. Settings → Webhooks: URL `https://<your-domain>/api/payments/webhook`, secret = `RAZORPAY_WEBHOOK_SECRET`, events `payment.authorized, payment.captured, payment.failed, order.paid, refund.processed, refund.failed`.
3. Enable the payment methods you want. Do **not** enable Route unless you intend to use it (section 6).

**Hosting platform**
1. Node 20 LTS or newer. No build step: `npm ci` in `server/`, then start `node server/server.js` (root `npm start`).
2. HTTPS terminated by the platform; WebSocket (Socket.IO) upgrades must be allowed; set `TRUST_PROXY=1`.
3. Health check: `GET /api/health` (exempt from the HTTPS redirect).
4. **Run exactly one app instance.** Live tracking state and Socket.IO rooms are in process memory; several instances without sticky sessions and a shared adapter (not implemented) would break real-time features. Scale vertically.
5. Run migrations from a pipeline step or machine that has the dev dependencies installed (the Prisma CLI is a dev dependency).

## 5. Release procedure (do it on staging first, then production)

1. **Freeze and tag** the release commit. Read the migration list below.
2. **Back up** (before anything else): Supabase dashboard backup or `pg_dump "$DIRECT_URL" -Fc -f localhire-$(date +%F).dump`. Verify the file is non-empty. Note the time.
3. `cd server && npm ci`
4. **Check what will run**: `npx prisma migrate status` (needs `DIRECT_URL`). Pending migrations must be only the ones you expect.
5. **Apply**: `npm --prefix server run prisma:migrate:deploy`. It applies pending migrations in order and stops at the first failure.
6. Deploy the new app version and restart.
7. **Smoke test** (section 7), watch logs and the admin console for 30 minutes.

Migrations 20261103 to 20261110 contain one-time data backfills (category rename, rating counters, booking and conversation links,
notification categories, journey timestamps). They are idempotent in effect but not reversible: that is why step 2 matters.
`20261110000000_reviews_trust_moderation` adds triggers that make a submitted review immutable and allow a review only on a completed booking.
Schema drift note: `prisma migrate diff` will always suggest `ALTER COLUMN "location" DROP DEFAULT` on `WorkerLocation`. This is a false positive for a
PostGIS generated column (applying it fails). Never apply auto-generated `migrate dev` SQL blindly.

**Verified on an empty database**: all 13 migrations apply in order, `migrate status` reports up to date, a second `migrate deploy` is a no-op, and
`schema.prisma` matches the migrated database except for the false positive above.

## 6. Money: what is and is not enabled

* **Test mode until you say otherwise.** Staging uses `rzp_test_` keys. Nothing in this repository performs a live payment test.
* **Live launch needs your explicit approval** and these steps, in order: (1) Razorpay account activated for live payments; (2) live keys and a live webhook set on **production** only; (3) one real low-value payment by you, then confirm the webhook arrived (Razorpay dashboard → Webhooks → recent deliveries), the booking shows paid, and the finance dashboard reconciles to ₹0.00; (4) refund that payment and confirm `refund.processed` is reflected; (5) only then open to customers.
* **Worker payouts stay `LEDGER_ONLY`.** Earnings are recorded as *owed* and never shown as paid or transferred; settling professionals is an external, approved process you operate. `PAYOUT_MODE=ROUTE` requires Razorpay to have enabled Route for your account, a passing `npm --prefix server run razorpay:route-check`, and a real successful test transfer. The Route code has only been tested against a test double.
* The default commission is **10%**. Each settlement stores the rate in force when the customer paid, so changing the setting later never rewrites past jobs.

## 7. Smoke test after each deploy

1. `GET /api/health` is 200; the startup log shows `Razorpay gateway credentials present (TEST|LIVE mode)` and `PAYOUT_MODE=LEDGER_ONLY`, and no `[Config] WARNING` you did not expect.
2. `curl -I http://<domain>/` redirects to https; the https response has `Strict-Transport-Security`.
3. Sign up with a new e-mail, receive the verification e-mail, verify, sign in. Test Google sign-in and password reset.
4. As a professional: complete onboarding with a sample document; as admin: open it (signed URL works, expires in ~2 minutes) and approve.
5. As a customer: book, pay (test card `4111 1111 1111 1111`), confirm completion, leave a review; check the professional's earnings show an **available balance**, not "paid".
6. Razorpay dashboard → Webhooks: recent deliveries are 200.
7. Turn on browser notifications in a real browser on the staging https URL and send a real push (this has **not** been verified in the development environment; see the report).
8. Admin console: overview, finance reconciliation shows ₹0.00 difference, audit log records your actions.

## 8. Rollback

* **Application**: redeploy the previous release. The migrations in this project are additive (new tables, columns, indexes, triggers); the previous app version keeps working against the newer schema, so for an application problem roll the **app** back and leave the schema alone.
* **Migration failed half way**: `migrate deploy` stops at the failing migration and records it as failed. Do not edit the database by hand. Fix forward, or if the migration must be abandoned, restore the pre-release backup into a **new** database, verify it, switch `DATABASE_URL`, then `npx prisma migrate resolve --rolled-back <migration_name>` where appropriate. Restoring discards everything written after the backup (including payments), so reconcile with Razorpay's dashboard afterwards.
* **Bad data change**: use a point-in-time restore into a new database, never over the live one; copy the needed rows back.
* **Secrets leaked**: rotate `JWT_SECRET` (signs everyone out), Supabase keys, Razorpay key and webhook secret, VAPID keys (users must re-subscribe).

## 9. Creating the first administrator (production-safe)

The demo seed refuses to run in production. Instead: the person signs up normally and verifies their e-mail, then

```bash
npm --prefix server run admin:promote -- person@example.com            # dry run
npm --prefix server run admin:promote -- person@example.com --apply    # makes them ADMIN, signs them out, writes an audit entry
```

It never creates accounts or handles passwords, and refuses unverified or deactivated accounts.

## 10. Known limitations to decide on before launch

* **Single instance** only (section 4).
* **No Content-Security-Policy**: the frontend uses inline scripts and third-party scripts (Leaflet, Razorpay Checkout), so a strict CSP would break it today. All dynamic output is escaped by the clients; add a nonce-based CSP as a later hardening project.
* **Dependency advisories**: after `npm audit fix` the remaining production advisories are the Prisma CLI chain (needs a major upgrade to Prisma 7; it runs at build/migrate time, not on request paths) and a moderate `qs` denial-of-service advisory held by Express 4 (needs Express 5). Plan these upgrades; do not use `npm audit fix --force` on a release day.
* **Public job board** (`GET /api/jobs`) is unauthenticated and shows the customer's name and internal id alongside the job. Decide whether to restrict it to signed-in professionals.
* **Push notifications** are implemented and unit-tested, but real delivery depends on a browser with a working push service; verify on staging (section 7, step 7).
* Real-time location uses the browser's GPS while the page is open; background tracking would need a native app.

## 11. Staging-to-production launch checklist

**A. Before staging**
- [ ] Separate Supabase project and Razorpay test keys for staging; secrets in the host secret store.
- [ ] All variables in section 3 set; `NODE_ENV=production`; `TRUST_PROXY=1`.
- [ ] Supabase dashboard settings (section 4) done; buckets created with the right visibility and limits; backups on.

**B. On staging**
- [ ] Backup taken; `migrate status` shows only expected migrations; `prisma:migrate:deploy` succeeded.
- [ ] Server starts with no unexpected `[Config] WARNING`; `/api/health` OK; HTTP redirects to HTTPS.
- [ ] `storage:verify` and `auth:verify` pass against the staging project.
- [ ] Full smoke test (section 7) passed, including webhook deliveries and a real browser push.
- [ ] First admin created with `admin:promote`; seed was **not** run.
- [ ] Payments: test-card payment, failed payment, refund, completion; finance reconciliation ₹0.00; earnings show "available balance", never "paid".

**C. Go / no-go (needs your approval)**
- [ ] Razorpay live activation complete; you accept that professionals are settled outside the app (`LEDGER_ONLY`).
- [ ] Support, refund and dispute process agreed (admin console and the Payments panel).
- [ ] Rollback plan understood; pre-release backup process rehearsed once on staging.

**D. Production launch**
- [ ] Production Supabase project configured exactly like staging; PITR on.
- [ ] Production secrets set (live Razorpay keys and a **live** webhook with a new secret).
- [ ] Backup, `migrate status`, `migrate deploy`, deploy, smoke test.
- [ ] One real low-value payment and refund by you; webhook deliveries 200; reconciliation ₹0.00.
- [ ] Monitor logs and the admin console for the first hours; keep the backup until the first settlement cycle is reconciled.
