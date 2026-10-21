# Real Estate Platform - Backend API

Express + MongoDB API for the no-broker property platform. It runs independently of the frontend and deploys to Render. No Redis.

Architecture: [`../docs/BACKEND_ARCHITECTURE.md`](../docs/BACKEND_ARCHITECTURE.md). Endpoint catalogue: [`../docs/API_ROUTES.md`](../docs/API_ROUTES.md). Specification: [`../docs/SPEC.md`](../docs/SPEC.md).

## Run locally

```
npm install
cp .env.example .env        # defaults work with a local MongoDB replica set
npm run seed                # super admin, Pune masters, property types, amenities, CMS pages, agreement templates
npm run dev                 # http://localhost:4102/api/health
```

`MONGO_URI` must point to a replica set (transactions are used for deal verification and invoicing). MongoDB Atlas works as-is. With no SMTP / SMS keys set, OTPs and messages print to the console.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` / `npm start` | Development (nodemon) / production |
| `npm run seed` | Idempotent seed |
| `node scripts/seed-demo-users.js` | Development only: one demo account per role (buyer, owner, builder, agent, manager, admin) with a shared test password, for clicking through the frontend |
| `node scripts/dev-launch.js` | Starts the API from any working directory (used by editor and preview launchers) |
| `npm run routes` | Route map per panel / module with build status |
| `npm test` | Jest + Supertest on `re_test` (local replica set) |
| `node scripts/gen-route-doc.js` | Regenerate `../docs/API_ROUTES.md` |
| `node scripts/spec-scaffold.js` | Generate missing constants / module stubs from the spec (never overwrites edited files; `--force` to regenerate) |

## Build status

All 353 designed endpoints are implemented (`npm run routes` shows 0 left at 501).

| Phase | Modules | Tests |
|---|---|---|
| 1 Foundation | M auth, K notifications and logs, L CMS and masters | `tests/phase1` |
| 2 Supply | A listings, D approvals and agreements, F KYC and no-broker, G builder projects | `tests/phase2` |
| 3 Public portal | E search and discovery, B masking and badges, A-20 photo verification | `tests/phase3` |
| 4 Leads | C lead management (capture, routing, SLA, visits, offers, feedback), J teams and routing, F-10 seeker flags | `tests/phase4` |
| 5 Money | H deals and receipt verification (transactional verify and reverse), I receivables and GST invoices, N outbox monitor and referral codes, H-10..12 partner services | `tests/phase5` |
| 6 Insights | O reports, exports, dashboards, lister stats, retention; D-13 site verification visits; K-08 WhatsApp inbound webhook | `tests/phase6` |

Background work (no Redis): `deals.claims` (5 min), `deals.sla` (hourly), `receivables.daily` (07:00 IST, overdue + reminders), `reports.snapshot` (01:00), `retention.leads` (1st of the month, 03:00), `reports.export` (exports over 10,000 rows), `verification.expire` (photo and site badges).

## Deploy (Render)

Use `render.yaml` as a Blueprint, set the `sync: false` secrets (MongoDB Atlas URI, Cloudinary, SMTP, MSG91, ENCRYPTION_KEY), then run `npm run seed` once from the Render shell.

## Growth Hub (MLM engine) integration (optional)

Outbox events (`deal.closed`, `deal.reversed`, `user.signup`, `lead.created`, `lead.updated`) go to the hub signed with HMAC-SHA256 (`src/core/outbox`). The hub reports lead status back through a signed webhook (`src/modules/leads/hubWebhook.service.js`, contract `mlm-engine/docs/INTEGRATION_CONTRACT.md` section 8). Real Estate reads only the `MLM_*` names.

| Variable | Meaning |
|---|---|
| `MLM_ENGINE_URL` | hub origin without `/api` (events go to `<url>/api/integrations/realestate/events`); sending also needs admin setting `mlm.enabled` |
| `MLM_PLATFORM_KEY` | platform key id `pk_realestate_...` (`X-Platform-Key`) |
| `MLM_PLATFORM_SECRET` | `whsec_...`: signs outgoing events and verifies incoming hub webhooks. **The webhook `POST /api/integrations/hub/webhooks` answers 404 until it is set** |

Hub webhook: configure `https://<api>/api/integrations/hub/webhooks` in hub admin > Platforms and keys > `realestate` > Webhooks (events `lead.accepted`, `lead.assigned`, `lead.status_changed`, `lead.converted`). The receiver checks `X-Hub-Signature` = HMAC(`MLM_PLATFORM_SECRET`, `X-Hub-Timestamp + "." + rawBody`) (or `X-Hub-Signature-Previous` during a hub secret rotation), refuses timestamps outside 300 s (401, security event), answers a repeated `X-Hub-Delivery-Id` with 200 and no change, and stores the hub status on the lead whose `leadNo` equals `externalLeadId` (field `hub`, a `hub` timeline entry, audit `lead.hub_status`). The hub's "Send test" and unknown leads are acknowledged and ignored.

## Control Center adapter (optional)

The central Control Center (control-center/, contract in control-center/docs/CC_CONTRACT.md) monitors and governs this platform through signed calls to `/api/cc/*` and signs owners in through `POST /api/auth/cc-sso` (frontend route `/sso/cc`, Control bar on the admin panel). Code: `src/modules/control/` (`provider.js` holds this platform's specifics). **Nothing changes until `CC_KEY_ID` and `CC_SECRET` are both set.**

| Variable | Meaning |
|---|---|
| `CC_KEY_ID` | Control Center key id for this platform (`X-CC-Key`) |
| `CC_SECRET` | HMAC secret, 32+ characters |
| `CC_ALLOWED_SCOPES` | scopes granted, comma list (default `ops.read`; full: `ops.read,ops.write,staff.read,staff.write,settings.read,settings.write,keys.write`) |
| `CC_JWKS_URL` | Control Center public keys (`https://<cc-api>/.well-known/jwks.json`); single sign-on is off without it |
| `CC_SECRET_PREVIOUS`, `CC_ISSUER` (control-center), `CC_AUDIENCE` (realestate), `CC_SSO_ROLES` (superadmin,admin) | optional |

Frontend: `VITE_CC_ENABLED=true` shows the maintenance banner set from the Control Center (no request is made without it). Local development keys: control-center/docs/PLATFORM_SETUP.md.
