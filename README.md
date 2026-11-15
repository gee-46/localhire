# LocalHire 🚀

## Empowering Local Employment Through Smart Hiring

LocalHire is a smart hiring platform designed to connect local job seekers with nearby employers quickly and efficiently. Our goal is to simplify the recruitment process for both candidates and recruiters by using location-based job matching, easy application tracking, and a user-friendly interface.

This project helps reduce unemployment gaps by making local opportunities more accessible and visible to everyone.

---

## 🌟 Features

- 🔍 Location-based job search
- 👤 Job seeker profile creation
- 🏢 Employer job posting dashboard
- 📄 Resume upload and management
- 📌 Job application tracking
- 🤖 Smart job recommendations
- 📊 Admin monitoring and management
- 📱 Responsive and simple UI

---

## 🛠️ Tech Stack

### Frontend
- HTML
- CSS
- JavaScript
- React.js (if used)

### Backend
- Node.js
- Express.js

### Database
- MongoDB / Firebase (update based on your project)

### Other Tools
- Git & GitHub
- VS Code
- APIs for job/location services

---

## 🎯 Problem Statement

Many job seekers struggle to find opportunities near their location, while small businesses often find it difficult to hire local talent efficiently.

LocalHire solves this by creating a bridge between employers and candidates within the same area, making hiring faster, smarter, and more accessible.

---

## 🚀 How It Works

1. Users create their profile
2. Employers post available jobs
3. Job seekers search jobs based on location and skills
4. Candidates apply directly through the platform
5. Employers review applications and shortlist candidates
6. Hiring becomes faster and more localized

---

## 📸 Project Preview

(Add screenshots of your project here)

Example:

![Home Page Screenshot](your-image-link-here)

---

## 📂 Installation & Running

```bash
git clone https://github.com/amraqureshi/localhire.git
cd LOCALHIRE_MAIN-main
npm install
npm --prefix server install
npm run dev
```

The entire application (backend API, WebSocket server, and static frontend) runs on port **5000** (`http://localhost:5000`).

---

> **Going live?** Read [DEPLOYMENT.md](DEPLOYMENT.md): environment variables, dashboard settings, release and rollback procedure, and the staging-to-production checklist.

## 🛡️ Admin Account Setup & Governance

For security reasons, **public registration does not allow registering with an Admin role** (`authController` strictly blocks unprivileged role escalation).

> **Production:** the demo seed refuses to run when `NODE_ENV=production`. Create the first admin by signing up normally, verifying the e-mail, then running
> `npm --prefix server run admin:promote -- person@example.com --apply` (dry run without `--apply`). See [DEPLOYMENT.md](DEPLOYMENT.md).

**Development only:** to bootstrap an Administrator account with the demo seed, configure `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `server/.env`:

```env
ADMIN_EMAIL=admin@localhire.dev
ADMIN_PASSWORD=YourSecurePassword123!
```

Then execute the database seed script:

```bash
npm --prefix server run prisma:seed
```

This creates or updates the administrative user in the PostgreSQL database. You can then log in at `http://localhost:5000/pages/auth.html` using the configured credentials and open the **Admin console** at `http://localhost:5000/pages/admin-console.html` (overview, workers, customers, bookings, finance, categories, analytics, audit log). Identity-document review and payment/dispute handling stay in the original panel, `http://localhost:5000/pages/admin.html`, linked from the console sidebar.


---

## 🔐 Authentication setup (email verification, password reset, Google)

Identity provider: the project's existing **Supabase** project (Supabase Auth). The Prisma `User` table
remains the only user table (linked by `User.supabaseAuthId`), roles are unchanged, and the backend still
issues its own session JWT. Secrets live only in `server/.env` and the Supabase/Google dashboards.

### Environment variables (`server/.env`)

| Variable | Value |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` (Project Settings → API) |
| `SUPABASE_ANON_KEY` | the `anon` / publishable key |
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` / secret key (server only, never in the browser) |
| `JWT_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `DATABASE_URL`, `DIRECT_URL` | your Supabase Postgres pooler / direct strings |
| `CLIENT_URL` | where the browser loads the app, e.g. `http://localhost:5000` (https in production) |
| `SERVER_PUBLIC_URL` | public URL of this backend, normally the same as `CLIENT_URL` |

### Supabase dashboard

1. **Authentication → Sign In / Providers → Email**: enabled, **Confirm email = ON**. (Registration refuses to run if it is off.)
2. **Authentication → URL Configuration**: *Site URL* = `CLIENT_URL`. *Redirect URLs* must contain exactly:
   - `<CLIENT_URL>/pages/auth.html`
   - `<SERVER_PUBLIC_URL>/api/auth/google/callback`
3. **Project Settings → Authentication → SMTP Settings**: enable custom SMTP (Resend, SendGrid, SES, Brevo…). The built-in
   mailer only delivers to your own team members and is limited to ~2 emails/hour. Also raise *Authentication → Rate Limits → emails per hour* (custom SMTP starts at 30/hour).
4. **Authentication → Sign In / Providers → Google**: enabled; paste the Google Client ID and Secret.

### Google Cloud Console

APIs & Services → Credentials → *OAuth client ID* → **Web application**. *Authorized redirect URI*:
`https://<project-ref>.supabase.co/auth/v1/callback` (the Supabase one, **not** your app's). Configure the OAuth consent screen
(scopes `email`, `profile`, `openid`; add yourself as a test user while the app is in *Testing*).

### Commands

```bash
npm --prefix server run prisma:migrate:deploy           # additive migration; modifies no existing row
npm --prefix server run auth:verify                     # read-only check of env, DB schema and live Supabase settings
npm --prefix server run auth:verify -- --probe-password-hash   # optional: proves legacy password import works on your project
npm --prefix server run auth:reset-legacy-preview       # dry run: who was flagged "verified" without ever verifying
npm --prefix server run auth:reset-legacy-apply         # explicit, separate step (add -- --skip-active to spare in-flight bookings)
```

Existing accounts: Admin keeps working with its current password. Other legacy accounts keep working until you choose to run the
reset above; after it, each user verifies once via the login page's "Resend verification email" and keeps their current password.

---

## 🧰 Worker onboarding & verification

New workers are routed (after login / email verification) to `pages/worker-onboarding.html`, a 5-step wizard
(personal → professional → identity → service → review) with save-and-resume. Applications appear for admins
under **Admin → Worker Verification**; approved workers get the ✓ Verified badge. Existing workers keep working
unchanged and can opt in to verification from `pages/worker-dashboard.html`.

**Setup**
1. `npm --prefix server run prisma:migrate:deploy` — adds the onboarding/document tables, the new profile columns
   and the 15 service categories (non-destructive; the seeded "AC Technician" is renamed in place to "AC Repair").
2. Documents live in a **private** Supabase Storage bucket named `worker-documents`. The server creates it on first
   upload with the service-role key (private, 8 MB limit, PDF/JPG/PNG/WebP only) and refuses to use it if it is ever made
   public. After deploying run `npm --prefix server run storage:verify` and confirm in Dashboard → Storage that the
   bucket shows **Private**. No new environment variables are needed.
3. Admin access to a document is only through a 2-minute signed URL minted by `GET /api/admin/worker-verifications/:userId/documents/:docId/url`;
   each view is written to the audit log. Workers can see their own document metadata and status, never a file URL.

**Verification states** (documents and applications): `PENDING → UNDER_REVIEW → VERIFIED | REJECTED | RESUBMISSION_REQUIRED`.
Nothing is ever verified automatically; uploading only creates a `PENDING` record. Approval requires at least one admin-verified
government photo ID. The legacy `User/WorkerProfile.verificationStatus` is kept in sync so search and the badge keep working.

**Identity documents:** any one government photo ID is accepted (passport, driving licence, voter ID, PAN, other). Aadhaar is
optional and only as a *masked* copy; the app never asks for or stores an ID number. Decide your own retention policy for
rejected/replaced files (they are kept, marked non-current, for the audit trail).

---

## 🛍️ Customer marketplace (homepage, categories, profiles, booking)

Customers land on `pages/customer-home.html` after login (workers and admins keep their own areas). Pages:
`customer-home.html` (homepage), `category.html` (category / search results with filters and sorting),
`profile.html` (professional profile + booking request). Shared UI lives in `css/marketplace.css` and `js/marketplace.js`.

**What customers can see:** only professionals who are (1) identity-verified, (2) active and (3) online (sharing a fresh
location within the last 15 minutes). All filters and sorting (`distance, rating, price, experience, working hours`) run in one
SQL query on the backend (`server/services/workerDiscovery.js`); the UI cannot widen what the server returns. Distances are coarse
(rounded up to 0.5 km); exact coordinates, email, phone and street address are never sent to customers.

**Workers must go online to be found:** Worker Hub → *Customer visibility* → **Go online**. The page refreshes the location every
4 minutes while it is open; if it is closed the worker drops out of search after 15 minutes. Portfolio photos are managed in the same page.

**Location / maps:** the project has no Google Maps integration. Location uses the browser's geolocation plus **OpenStreetMap Nominatim**
(the same provider the existing map search page already used) for address lookup. The public Nominatim service is rate-limited and meant for
light use; for production traffic use a paid geocoder or a self-hosted Nominatim and change the two URLs in `public/js/marketplace.js` (`NOMINATIM`).

**Setup:** `npm --prefix server run prisma:migrate:deploy` (adds `Booking.problemDescription` and the `WorkerPortfolioItem` table). No new environment variables.
Portfolio photos use the existing public `profile-photos` bucket.

## 💳 Payments, refunds and worker earnings

**Flow.** Customer requests → professional accepts and **confirms the price** → customer pays with **Razorpay Checkout** (service amount,
platform fee, tax and total are shown first) → professional does the job and presses *Finish & request confirmation* → customer
**confirms completion** → the professional's earnings become eligible for settlement. Three states are kept strictly apart:
*booking* status, *payment* status (`CREATED, AUTHORIZED, CAPTURED, FAILED, REFUNDED, PARTIALLY_REFUNDED`) and *settlement* status (what is owed to the professional).

**Server-side only.** The browser never sends an amount. The server computes it from the confirmed price and `PLATFORM_FEE_PERCENT`, `PLATFORM_FEE_TAX_PERCENT`
(`server/services/pricing.js`), creates the Razorpay order, and treats a payment as paid **only** after (a) the Checkout signature verifies against *our* stored order id and
(b) the server has fetched the payment from Razorpay and the amount matches; or when a signature-verified webhook says so. Webhooks are verified over the raw body, de-duplicated by
`x-razorpay-event-id`, and every money movement is an append-only ledger row guarded by a unique key, so replays are no-ops. A second payment for an already-paid booking is refunded automatically.

**Refunds.** Customer cancellation (full refund, or minus `CUSTOMER_CANCELLATION_FEE_PERCENT` once the professional is on the way), professional/admin cancellation (full), admin full or partial refunds and dispute
outcomes. A refund is shown as done only when Razorpay reports it processed. The professional's earnings are reduced by refunds (and LocalHire's commission on that share is returned).

**Disputes.** Either party can open one while the payment is held; the settlement is blocked and an admin resolves it (release / full refund / partial refund) with a recorded reason.

**Pages.** Customers: `pages/payments.html` (transaction history and details) and *My Jobs* (pay, confirm, dispute). Workers: *Worker Hub → Earnings*. Admins: *Payments* tab in the admin console.

### Razorpay setup you must do

1. Put your **test** keys in `server/.env` (`RAZORPAY_KEY_ID=rzp_test_…`, `RAZORPAY_KEY_SECRET`). Never put the secret in `public/`.
2. Dashboard → Settings → Webhooks: URL `https://<your-domain>/api/payments/webhook` (use a tunnel such as ngrok for local testing), choose a secret → `RAZORPAY_WEBHOOK_SECRET`.
   Events: `payment.authorized, payment.captured, payment.failed, order.paid, refund.processed, refund.failed`.
3. Dashboard → enable the payment methods you want (UPI, cards, netbanking, wallets…). Checkout shows whatever your account has enabled. Auto-capture is recommended; if your account uses manual capture, the server captures the exact order amount itself.
4. Set `PLATFORM_FEE_PERCENT` and `PLATFORM_FEE_TAX_PERCENT` (default 0) and `WORKER_COMMISSION_PERCENT` (**default 10**: LocalHire keeps 10% of each professional's service amount once the customer confirms the job; set `0` to charge no commission).
5. Test mode card: `4111 1111 1111 1111`, any future expiry, any CVV; UPI test id `success@razorpay`; failure: `failure@razorpay`. No real money moves in test mode.

### Worker payouts: what is and is not possible

* **Default (`PAYOUT_MODE=LEDGER_ONLY`).** LocalHire records exactly what each professional is owed (`ELIGIBLE` = *available balance*) but **does not move money to them**, simulates nothing, and never
  labels earnings "paid". Customer money sits in your Razorpay balance, so settling professionals must be done by you outside the app (or by turning on Route). This is not an escrow account.
* **Razorpay Route (`PAYOUT_MODE=ROUTE`).** Route is Razorpay's product for splitting a payment to sub-merchants ("linked accounts"). It is **not enabled by default**: Razorpay must activate it for your merchant account after their review
  (marketplace business, KYC, and RBI payment-aggregator rules apply). Run `npm --prefix server run razorpay:route-check` with your keys to see whether the Route APIs respond for your account.
  When enabled, LocalHire onboards each professional as a linked account (PAN + bank details go straight to Razorpay and are never stored here), creates a transfer **on hold** when the customer pays, releases the hold when the customer confirms
  completion, reverses it on refunds, and marks earnings `PAID` only when Razorpay reports the settlement. Payment is blocked for professionals whose linked account is not activated.
* **Verification status.** The Route code was written from Razorpay's public documentation and tested against a test double only. It has **not** been run against a live Razorpay account, and the exact webhook payloads for linked-account events are
  unverified. Treat it as unproven until you have run an end-to-end transfer in Razorpay test mode and then with Razorpay's approval in live mode.

### Tests

`npm --prefix server test` (needs the migrated PostgreSQL in `DATABASE_URL`). `tests/payments.test.js` drives the real routes and database with real HMAC signatures against an in-memory Razorpay fake
(`tests/helpers/fakeRazorpay.js`), covering success/failure, invalid signatures, duplicate webhooks and payments, cancellations, refunds, disputes, earnings, payout failure and settlement status.
It proves LocalHire's logic, not the behaviour of the live Razorpay service.

## 💬 Chat, notifications and browser push

**Chat.** Every conversation belongs to one booking (`Conversation.bookingId`, unique) and only that booking's customer and assigned worker can read or write it
(`server/services/chatService.js`). Admins have no chat access; support works through disputes. Messages are stored in PostgreSQL, delivered live over the existing Socket.IO server
(`chat:join`, `chat:send`, `chat:message`, `chat:read`) with acknowledgements, and are idempotent: the client sends a `clientMessageId`, and `(senderId, clientMessageId)` is unique, so a retry,
a double click or a reconnect can never create a second message. After a reconnect the page re-joins the room and fetches everything newer than its last message. The session is re-checked on
every chat event, and logout / password change disconnects the user's sockets, so a revoked session stops receiving messages. A cancelled booking, or one completed more than 14 days ago, is read-only.
Conversations created before bookings were required are attached to the most recent booking between the two people by the migration; any with no booking stay unlinked and unreachable.

**Notifications.** Created only by real events (booking requested / accepted / declined / rescheduled / cancelled, on the way, arrived, completion requested, payment, refund, dispute, completion, earnings,
payout, new message) and stored with a category and the booking id. They arrive live over Socket.IO (bell badge + toast), appear in the bell and in the **Notification centre**
(`pages/notifications.html`: unread state, categories, mark read / mark all read, paging, click-through to the booking or chat). Chat messages coalesce into one unread notification per booking.
A worker can reschedule a booking before the journey starts (`PATCH /api/bookings/:id/reschedule`); the customer is notified and may cancel.

**Browser push (Web Push).** Optional. Generate keys once with `npm --prefix server run push:generate-keys` and set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` in `server/.env`.
Without them push is reported as "not switched on" and everything else still works. Push needs a secure origin (HTTPS in production; `localhost` is allowed) and a user gesture: the browser's permission
prompt appears only when the person presses "Turn on browser notifications" (a quiet banner is offered on My Jobs / the worker hub, and "Not now" is remembered for 30 days). The private key never leaves the server.
Subscriptions answered with 404/410 are deleted; five consecutive failures also delete one. A browser that cannot do background notifications (including iPhone Safari unless LocalHire is added to the Home Screen) is told so.

**What is and is not proven.** Automated tests use real PostgreSQL and real Socket.IO. Push *transport* is tested in Chrome with a real Google (FCM) subscription: the service worker received a push and showed
a notification with every LocalHire page closed. That was Chrome on Windows only. Firefox, Safari, Android and iOS devices, OS "do not disturb" settings and real-world delivery delays were not tested.

### Tests

`tests/chat-realtime.test.js` (authorization, real-time delivery, persistence, duplicate prevention, offline/unread, reconnect, revoked sessions) and `tests/notifications.test.js` (every notification type, live delivery,
notification centre API, push subscription validation, delivery, expired subscriptions). The push transport is a recording fake there; it is not a claim about delivery to a device.

## 📍 Worker location and booking journey tracking

**Two separate things.**
1. *Availability* ("Go online", worker hub): a coarse position so verified workers appear in nearby searches. It needs a fix within ±2 km and no older than 2 minutes, is refreshed every ~4 minutes while the page is open,
   and the server treats a position older than 15 minutes as **offline**. Going offline erases it. Public search shows the worker's locality and an approximate distance (rounded up to 0.5 km). **No map pin and no coordinates, exact or coarse, appear in any public response.** The search map only draws the search radius. The booking-specific tracking map is shown only to the booking's customer, after the worker consents to share for that booking, and a worker can pause sharing at any time (the customer sees "Updates have stopped" at once).
2. *Journey tracking* (booking page `pages/track.html`): the worker explicitly presses **Start journey** (booking status `DISPATCHED`). From then until they press **I've arrived** (or start the service, complete, cancel or dispute),
   their live position is shared with **that booking's customer only**. The last position is stored on the booking (one row, no history) and erased when sharing ends. It is independent of the availability toggle and never
   written to the marketplace location. Admins have no tracking access.

**Journey states** (derived, existing booking/payment states are unchanged): `BOOKING_ACCEPTED` (CONFIRMED) → `JOURNEY_STARTED` (DISPATCHED) → `WORKER_ARRIVED` (DISPATCHED + `arrivedAt`) → `SERVICE_IN_PROGRESS` (IN_PROGRESS) →
`COMPLETION_REQUESTED` (AWAITING_CUSTOMER_CONFIRMATION) → `COMPLETED`.

**What the customer sees.** Worker name, photo, profession, booking and journey status, a map (Leaflet + OpenStreetMap), "live / delayed / not live" with the age of the last update, and a straight-line distance **only** when the fix is
accurate (±200 m or better) and recent. There is **no ETA**: LocalHire has no routing service configured, so none is invented. Positions are validated on the server (range, accuracy ≤ 1 km, age ≤ 2 min, no physically impossible jumps, max one update per 3 s);
freshness is judged from the server's receive time.

**Background tracking limits.** A website can only read the GPS while the page is open and the device awake. If the worker closes the page, locks the phone or the OS suspends the browser, updates stop: the customer is told "Updates have stopped" at once
(connection lost) and "Not live" after minutes, with the last known time; nothing is shown as live. The worker page asks the browser to keep the screen awake (Wake Lock, where supported) but that is a best effort. Reliable background tracking needs a **native
Android/iOS app** (foreground service with a persistent notification on Android; "Always" location permission and background modes on iOS) or a progressive web app installed to the home screen, which still cannot promise background GPS on iOS.

**Maps and geocoding policy.** Tiles come from `tile.openstreetmap.org` with the required attribution link, no prefetching or bulk download. Geocoding (Nominatim) goes through `public/js/geo.js`: one request per second at most, cached for 7 days,
explicit searches only (no autocomplete). OpenStreetMap's public servers are for light use; for production traffic use a commercial tile provider or your own tile/geocoding servers and change `TILE_URL` in `public/js/tracking.js` and `NOMINATIM` in `public/js/marketplace.js`.
Leaflet is loaded from unpkg with integrity hashes. No paid Google Maps API is used.

**Setup.** `npm --prefix server run prisma:migrate:deploy` (adds journey columns on `Booking` and `WorkerLocation.accuracyMeters`). Optional: `TRACKING_RATE_LIMIT_MAX` (REST fallback updates per minute per IP, default 60).
Tests: `server/tests/tracking.test.js` (real PostgreSQL/PostGIS and Socket.IO; coordinates are sent like a browser would, no GPS hardware).

## 🧭 Admin console (marketplace management and analytics)

Open `pages/admin-console.html` as an Admin. Every `/api/admin/*` endpoint requires a signed-in Admin (role re-checked against the database on every request); customers and professionals get 401/403 and the page sends them to sign in.

| Section | What it does |
|---|---|
| Overview | People, booking and money KPIs from the database, plus a bookings chart. |
| Workers | Search; filter by profession, city, locality, verification, availability and account status; profile with completed jobs, genuine reviews and verification history; **suspend / reactivate with a reason**. Reactivation never changes verification, and nothing here approves identity: that stays in the document-review queue. Documents are shown only as type and status, never as files. |
| Customers | Masked contact details in the list; the full profile (bookings, payments, complaints) is an audited view; suspend / reactivate with a reason. |
| Bookings | Filters Requested, Accepted, Active, Journey started, Arrived, In service, Completion requested, Completed, Cancelled, Disputed, with payment and settlement status. **Read-only**: states change only through the normal booking/payment flows. |
| Finance | Reads payment, refund, settlement and transaction records (see definitions below). |
| Categories | Create, rename, describe, upload an icon, enable/disable (a reason is required to disable), booking counts. A category that has workers, jobs or bookings cannot be deleted, only disabled. |
| Analytics | Daily or monthly bookings, revenue trend, popular categories, top localities (customer city + PIN), acceptance, cancellation and completion rates, customer and worker growth, for a chosen date range (max 800 days). Rates show "–" when there is nothing to measure, never 0%. |
| Audit log | Who did what, when and why, for suspensions, reactivations, category changes, refunds and audited profile views. |

**Finance definitions** (all amounts are summed in integer paise from the records; payments are never simply added up as revenue):
* *Customer payment value*: what customers paid (service + platform fee + tax). *Net cash received* = that minus refunds, before Razorpay's own charges.
* *Gross service value*: the professionals' service prices on those payments. *Platform fees* and *taxes held* are separate; **taxes are never LocalHire revenue**.
* *Commission earned*: `WORKER_COMMISSION_PERCENT` (default 10) of the service amount, only after the customer confirms the job and net of refunds; *commission pending* is paid-but-unconfirmed. *Revenue earned* = commission earned + platform fees earned.
* *Worker net entitlement* = service value minus commission. Of that, *owed, not yet transferred* is a liability, and *actual payouts completed* counts only transfers the payment provider reported as settled.
* *Razorpay charges* are shown only where Razorpay reported a fee for the payment; they are never estimated.
* A reconciliation panel checks that net cash = worker entitlement + commission + fees + taxes, and shows the difference (₹0.00 when the books balance).
* **`PAYOUT_MODE=LEDGER_ONLY` earnings are not money already transferred.** Unless Razorpay Route is enabled, the console says plainly that settlements need an external, approved payout process.

**Setup.** `npm --prefix server run prisma:migrate:deploy` (adds `User.suspendedAt/suspensionReason/suspendedById` and `Payment.gatewayFee/gatewayFeeTax`). Category icons are stored in the existing public `profile-photos` Supabase bucket under `category-icons/`, so that bucket must exist. Optional: `BUSINESS_TIMEZONE` (default `Asia/Kolkata`) decides which day a booking or payment falls on in analytics.
Tests: `server/tests/admin-console.test.js` (real PostgreSQL, real HTTP, no fabricated figures).

## ⭐ Reviews and trust

**Who can review.** Only the customer who made a booking, only once the booking is `COMPLETED` (so never `REQUESTED/CONFIRMED/IN_PROGRESS`, `CANCELLED` or `DISPUTED`, and not while a dispute ticket on it is still open), and only once. A review is a 1-5 star rating plus a written comment of 10-1000 characters. The request names the booking (`POST /api/reviews { bookingId, rating, comment }`); the server takes the customer, professional and status from the booking, never from the request. Someone else's booking looks exactly like a booking that does not exist.

**Enforced in the database too** (migration `20261110000000_reviews_trust_moderation`): one review per booking (unique index), rating 1-5 and comment length checks, a trigger that only allows a review to be inserted for a `COMPLETED` booking by that booking's customer about that booking's professional, and a trigger that makes a submitted review's booking, customer, professional, rating and comment immutable. Nobody, including admins, can edit a review; there is no delete endpoint.

**States.** `PUBLISHED` (public, counts towards ratings), `HIDDEN` (removed from public view and from every rating; the record, its reports and its moderation history are kept) and *reported* (a published review with at least one open report from the professional). Only published reviews feed `WorkerProfile.rating / reviewsCount`, which are recomputed in the same transaction as every review, hide or restore. A professional with no published reviews has **no rating** (never 0 or a default).

**Customers** are prompted when they confirm completion (a "How did it go?" notification and the review dialog opens straight away), and every completed booking in *My bookings* shows "Rate your experience" until reviewed, then "Submitted" with their stars and comment. Public profiles and discovery cards show the real average with the review count, or "No reviews yet". Public reviews show a first name and last initial only: no customer id, e-mail, phone or photo.

**Professionals** see their rating summary and received reviews in the dashboard (`#reviews`), are notified of each new review (existing notification centre, type `REVIEW_SUBMITTED`), cannot edit or delete reviews, and can **report** an abusive, fake or private-information review (one report per professional per review). A reported review stays visible until a moderator decides. Reviews a moderator removed show only as a placeholder.

**Admin moderation** (*Reviews* in the admin console, `/api/admin/reviews`): list with Reported / Published / Hidden filters, rating filter and search; a detail view with the review, its booking, the professional's reports and the full moderation history (customer name only: no contact details). Admins can **hide**, **restore** or **dismiss reports**, each requiring a written reason (5-500 characters), recorded as an append-only `ReviewModerationEvent` and in the audit log (`REVIEW_HIDDEN`, `REVIEW_RESTORED`, `REVIEW_REPORTS_DISMISSED`, with actor, time, IP and reason). Hiding upholds open reports; the reporting professional is told the outcome.

**Rate limits** (per signed-in account for writes): `REVIEW_RATE_LIMIT_MAX` (default 20 review/report requests per 15 minutes) and `REVIEW_READ_RATE_LIMIT_MAX` (default 120 public reads per minute per IP).

**Setup.** `npm --prefix server run prisma:migrate:deploy`. No other configuration. Note: `npm run prisma:seed` (development only) still creates one fictional demo review; do not run it against a real database.
Tests: `server/tests/reviews.test.js` (real PostgreSQL, real HTTP, real triggers and constraints).

