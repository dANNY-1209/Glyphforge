# Glyphforge — Discord auth + self-request whitelist + promotable admins

Status: DRAFT — pending user confirmation on open questions (§ Open
Questions). Once confirmed, this is the execution checklist.

## Goal

Replace the hardcoded single-admin bcrypt login with a Discord-OAuth
based auth system that supports:

1. **Whitelist gating** — only users whose Discord ID is on the
   whitelist can see/use gated parts of the site. (Glyphforge already
   has Discord OAuth wired up for the Request feature — we reuse it.)
2. **Self-service request flow** — non-whitelisted users can submit
   a "request access" form; admins review and approve/deny.
3. **Promotable admin role** — admins can promote any whitelisted
   user to admin, and demote (except the bootstrap super-admin).
4. **Bootstrap super-admin** — one Discord ID hardcoded in `.env`
   (`SUPER_ADMIN_DISCORD_ID`) that is always admin and cannot be
   demoted. This is the recovery path if the persisted admin list
   gets corrupted.
5. **Retire the legacy bcrypt login** — `ADMIN_USERNAME` /
   `ADMIN_PASSWORD_HASH` / `POST /api/gallery/admin/login` go away
   once Discord-admin works end-to-end.

## Why this matters

- Current admin login is `ADMIN_USERNAME` + bcrypt password — single
  account, password sits in `.env`, no audit trail, no way to revoke
  per-person, and the bcrypt-`$$`-escaping pitfall has bitten us
  twice already (skill rule 5).
- Right now anyone who knows the URL can read every prompt, costume,
  LoRA, and workflow. Some of this content is intended only for
  trusted collaborators.
- A Discord-first auth flow is the same pattern the user already
  uses on asmr-archiver, so the mental model and operational
  knowledge transfer.

## Reference: asmr-archiver's pattern (the proven model)

`~/deployments/asmr-archiver/auth.js` does almost exactly what we
want, minus the self-request flow:

- `data/whitelist.json` — `{ google: [...], discord: [...] }` of
  allowed identifiers.
- `data/user_profiles.json` — cached `{ name, avatar, lastSeen }`
  per identifier, refreshed on every login. Admin UI uses this to
  show friendly names next to raw IDs.
- `data/access.log.jsonl` — append-only audit log of every auth
  event (login, denied, approve, revoke). One JSON object per line.
- `ADMIN_DISCORD_ID` / `ADMIN_GOOGLE_EMAIL` env vars — the bootstrap
  admin. `isAdmin(provider, id)` is env-check only.
- `isAllowed(provider, id)` = admin OR present in whitelist.
- Single-provider lookup: `provider` is `'google' | 'discord'`.

We diverge in three ways:

1. **Discord only** for Glyphforge (no Google).
2. **Admin role is persisted, not env-only.** Env defines the
   bootstrap super-admin; other admins are stored in
   `data/admins.json` and managed via the admin UI.
3. **Self-request flow** — new `whitelist_requests.json` table for
   pending requests, with admin approve/deny.

## Architecture

### Storage layout

All under `deployment_datas/Glyphforge/auth/` (new top-level
directory mounted into the container):

```
auth/
├── whitelist.json           { discord: ["<id1>", "<id2>", ...] }
├── admins.json              { discord: ["<id1>", ...] }   # excludes super-admin
├── user_profiles.json       { discord: { "<id>": { username, globalName,
│                                                   avatar, lastSeen,
│                                                   firstSeen } } }
├── whitelist_requests.json  { requests: [ { id, discordId, profile,
│                                            reason, createdAt,
│                                            status: 'pending'|'approved'|
│                                                    'denied'|'cancelled',
│                                            reviewedBy, reviewedAt,
│                                            reviewNote } ] }
└── access.log.jsonl         JSONL audit: login, denied, request,
                             approve, deny, promote, demote, revoke
```

`writeJsonAtomic` (existing helper) is used for every write. Reads
are cached in-memory with a 60-second TTL to avoid disk hits on
every request — invalidated on every write.

`docker-compose.yml` bind-mount:

```yaml
- /volume1/homes/dannyho/deployment_datas/Glyphforge/auth:/app/data/auth
```

### JWT shape (replaces the current Discord JWT)

Current JWT carries `{ discordId, username, globalName, avatar }`.
The post-change JWT additionally carries the **derived** authorization
flags so the frontend doesn't need to re-query:

```js
{
  discordId, username, globalName, avatar,
  isWhitelisted: boolean,
  isAdmin: boolean,
  iat, exp,
}
```

These flags are computed at **token-issue time** (callback) and at
**verification time** (middleware, on every request — since admins
can revoke between login and the request). This is important: a
stale flag in a long-lived JWT must not grant access after revoke.

JWT lifetime stays at 30 days but every protected request re-runs
`isAllowed()` / `isAdmin()` against the live whitelist/admins file,
so revocation is effective immediately.

### Three new middlewares

```js
requireLogin(req, res, next)        // 401 if no valid Discord JWT
requireWhitelist(req, res, next)    // 401 → login, 403 → request-access page
requireAdmin(req, res, next)        // 401/403 as appropriate
```

Each is a thin wrapper around the existing JWT-verify code in
`/api/auth/discord/me`. The legacy `authMiddleware` + `verifyToken`
aliases get replaced project-wide:

- Routes that need **admin** (every `POST/PUT/DELETE` for
  loras/fn-loras/prompts/costumes/workflows, the gallery admin
  endpoints, `/api/admin/*`) → `requireAdmin`.
- Routes that need **whitelisted** read access (TBD per § Open
  Questions) → `requireWhitelist`.
- Routes that need **any logged-in user** (request submit,
  whitelist self-request submit, `/api/auth/discord/me`) →
  `requireLogin`.

### API surface

New endpoints (all under `/api/auth/*`):

| Method | Path                                | Auth          | Purpose |
|--------|-------------------------------------|---------------|---------|
| GET    | /api/auth/discord                   | public        | (exists) issue redirect URL |
| GET    | /api/auth/discord/callback          | public        | (exists) exchange code, issue JWT, but now also: upsert profile, compute & embed auth flags |
| GET    | /api/auth/me                        | login         | return `{ user, isWhitelisted, isAdmin }` from live state (not just JWT claims) |
| POST   | /api/auth/logout                    | public        | client-side token discard; server-side just bumps access.log |
| POST   | /api/auth/whitelist-request         | login         | body: `{ reason }` — creates a pending request for the logged-in user |
| GET    | /api/auth/whitelist-request/mine    | login         | returns the caller's latest request (so frontend knows pending state) |
| DELETE | /api/auth/whitelist-request/mine    | login         | cancel a pending request |
| GET    | /api/admin/users                    | admin         | merged view: whitelist + admins + recent profiles |
| GET    | /api/admin/whitelist-requests       | admin         | list pending requests |
| POST   | /api/admin/whitelist-requests/:id/approve | admin   | body: `{ note? }` — moves user to whitelist, marks request approved |
| POST   | /api/admin/whitelist-requests/:id/deny    | admin   | body: `{ note? }` — marks denied (does NOT add to whitelist) |
| POST   | /api/admin/whitelist                | admin         | body: `{ discordId, note? }` — add directly (bypass request flow) |
| DELETE | /api/admin/whitelist/:discordId     | admin         | revoke whitelist (also demotes from admin if applicable) |
| POST   | /api/admin/admins                   | admin         | body: `{ discordId, note? }` — promote whitelisted user to admin |
| DELETE | /api/admin/admins/:discordId        | admin         | demote — refuses to demote super-admin; refuses self-demote if you're the last non-super admin |

Each admin write also fires a Discord notification (reuse
`sendDiscordNotification` with new event types: `whitelist_request`,
`whitelist_approve`, `whitelist_deny`, `admin_promote`,
`admin_demote`, `whitelist_revoke`).

### Frontend changes

1. **App-level auth state** moves from `adminMode` (boolean) to
   `authState = { user, isWhitelisted, isAdmin }`. The "🔐 Login"
   button in the header still kicks Discord OAuth.
2. **Admin mode toggle** stays UX-wise (so you can browse as a
   regular user without seeing edit affordances), but the underlying
   permission check is `authState.isAdmin`, not a password modal.
3. **Gated tabs/sections** (TBD per § Open Questions) render a
   "Login required" placeholder for anonymous users and a
   "Pending approval / Request access" placeholder for logged-in
   non-whitelisted users.
4. **New Request-access modal** — single textarea ("Why do you want
   access?"), submits to `POST /api/auth/whitelist-request`. Once
   submitted, the placeholder switches to "⏳ Pending review"
   until approval.
5. **New Admin > Users panel** — list of whitelisted users (with
   profile cards), pending requests with Approve/Deny buttons, and
   admin badge + promote/demote controls. Lives next to the existing
   Gallery admin panel.
6. **Remove the AdminLogin component** entirely once the Discord-
   admin path is verified working. Drop the bcrypt password modal,
   the `ADMIN_USERNAME` env var, the `ADMIN_PASSWORD_HASH` env var,
   `loginLimiter`, `POST /api/gallery/admin/login`, and the
   `adminToken` localStorage key (migration: on first load post-
   deploy, delete it client-side if present).

### Migration / rollout

This is the risky part — getting it wrong locks the user out.

**Phase 1 — additive, no breakage.** Land the new system in parallel
with the old. New routes work, old `authMiddleware` still works.
Bootstrap super-admin = user's Discord ID in `.env`. Hand-add user's
ID + 1-2 trusted IDs to `whitelist.json` and `admins.json` before
first deploy, so the admin UI is reachable on day one.

**Phase 2 — flip protected routes.** Switch every write route from
`authMiddleware` to `requireAdmin`. Old bcrypt-issued tokens stop
working at this point — but Discord-issued admin tokens work, and
the user has one because of Phase 1.

**Phase 3 — gate read routes** (only if Open Question 1 chooses
B or C). Add `requireWhitelist` to selected `GET` routes / SPA
pages.

**Phase 4 — delete the legacy.** Remove bcrypt code, env vars,
login route, frontend modal. Update skill `glyphforge-development`
to remove Rule 5 (bcrypt fail-fast) and the bcrypt-`$$` pitfall —
replaced by a new section on Discord auth.

Each phase is its own commit so rollback is one `git revert`.

## Open Questions (please answer before I start)

1. **Which features are gated and at what level?** Pick one:
   - **A)** Gate writes only — public still reads everything.
     Only `POST/PUT/DELETE` admin routes get `requireAdmin`. No
     `requireWhitelist` anywhere. This is the smallest change.
   - **B)** Whole site behind login + whitelist. Anonymous users
     see only the login page.
   - **C)** Partial: which tabs/sections are public vs. gated?
     (e.g. Workflow + Request public; Prompt/Costume/LoRA gated)
   - My default if you don't answer: **A**, because it solves the
     hardcoded-bcrypt problem you flagged without restricting your
     audience.

2. **Should non-admin whitelisted users get any extra capability
   over anonymous?** E.g. submit requests, see hidden tags, etc.
   If A above is chosen, whitelisting still matters only for
   self-request → admin escalation. Default: **whitelisted users
   can submit Requests with a verified identity badge** (Request
   feature already supports this).

3. **Bootstrap super-admin id**: your Discord ID, hardcoded in
   `.env` as `SUPER_ADMIN_DISCORD_ID`. Confirm yes/no — if yes I
   need the ID. (Or I can pull it from your existing
   `submittedBy.discordId` on past requests if there are any.)

4. **Audit log retention** — `access.log.jsonl` grows unbounded.
   asmr-archiver has the same issue. Options: (a) leave it (matches
   asmr-archiver, low traffic site, fine forever); (b) rotate
   monthly. Default: **(a)** unless you want rotation.

5. **Self-request rate limit** — `express-rate-limit` per IP and
   per Discord ID. Default: **5 requests per Discord ID lifetime
   (regardless of approve/deny), 3 per IP per day**. Tunable.

6. **Notification channel for admin events** — same Discord
   webhook as the `new_*`/`edit_*` notifications, or a separate
   admin-only webhook URL? Default: **same channel** for
   simplicity; flip to dedicated later if it's too noisy.

7. **Login UX during Phase 2 transition** — after switching admin
   routes to `requireAdmin`, the old bcrypt modal will still render
   but its login will fail. Options: (a) leave it broken (it's
   gone in Phase 4 anyway, short-lived); (b) replace the modal
   immediately in Phase 2 with "Click to log in via Discord".
   Default: **(b)**, cleaner.

## Verification plan

After each phase:

- `node --check app/server.js`
- `npm run lint` (no new errors)
- Smoke: log in via Discord with super-admin account → `/api/auth/me`
  returns `{ isAdmin: true, isWhitelisted: true }`. Admin write
  endpoint (e.g. `PUT /api/loras/:id`) returns 200.
- Smoke: log in via Discord with a non-whitelisted account → `me`
  returns `{ isAdmin: false, isWhitelisted: false }`. Admin write
  returns 403. Whitelist-request submit returns 201.
- Smoke: revoke a user → their next admin write returns 403 within
  the cache TTL (≤60s).
- Smoke: hand-edit `admins.json` to invalid JSON → server boots,
  logs an error, falls back to "no admins except super-admin"
  rather than crashing.

End-to-end (manual, in a browser):

1. Bootstrap: super-admin login → admin panel → see one whitelist
   entry (super-admin) + zero pending requests.
2. Anonymous user login → "request access" form → submit.
3. Super-admin sees pending request → approve.
4. Same user reloads → now whitelisted, no longer sees the form.
5. Super-admin promotes them → they see admin UI on next reload.
6. Super-admin demotes them → admin UI hidden.
7. Super-admin revokes them → they're back to non-whitelisted on
   next page navigation (no relog needed).

## File-by-file change preview (Phase 1 only — for sizing)

| File | Lines added (est) | Notes |
|------|------------------:|-------|
| `app/lib/auth-store.js` (new) | ~250 | analogue of asmr-archiver/auth.js, but Discord-only + admins.json + requests |
| `app/server.js` | ~200 add, ~30 modify | new middlewares + auth routes |
| `app/src/contexts/AuthContext.jsx` (new) | ~120 | replace adminToken plumbing |
| `app/src/components/Auth/*` (new) | ~400 | LoginButton, RequestAccessModal, AdminUsersPanel |
| `app/src/App.jsx` | ~80 modify | swap adminMode for authState |
| `app/docker-compose.yml` | ~3 | new bind-mount for auth/ |
| `app/.env.example` | ~6 | new vars: SUPER_ADMIN_DISCORD_ID (DISCORD_CLIENT_ID/SECRET/REDIRECT_URI already there) |
| `skills/glyphforge-development` | ~50 | retire Rule 5, add "Discord auth" section |

Phase 2-4 are mostly find-and-replace + deletion.

## Risks

1. **Locking yourself out.** Mitigated by `SUPER_ADMIN_DISCORD_ID`
   in `.env` — even if `admins.json` is wiped, you stay admin.
2. **JWT secret rotation invalidates all logins.** Current behavior
   too; no regression.
3. **Discord OAuth rate limits**. Discord allows generous OAuth use;
   we cache profiles, so /me check hits Discord only on token
   refresh, not every request.
4. **Race on `whitelist.json` writes.** `writeJsonAtomic` already
   handles atomicity; concurrent admins approving the same request
   are handled by checking `status === 'pending'` before mutating.
5. **The existing Request feature's Discord-user tracking already
   uses the same JWT shape.** No collision — we extend it.
