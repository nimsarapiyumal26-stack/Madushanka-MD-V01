# Madushanka MD — WhatsApp Bot

## Deploying on Railway

1. Push this project to a GitHub repo and create a new Railway service from it
   (or `railway up` from this folder).
2. Railway auto-detects `Procfile` / `npm start` — no build command needed.
3. Once deployed, open the Railway-provided URL. That's the pairing portal.
4. Enter your WhatsApp number (with country code, no `+` or spaces, e.g.
   `94771234567`) and submit to get a pairing code.
5. In WhatsApp: **Settings → Linked Devices → Link a Device → Link with phone
   number instead**, and enter the code.

## Important: session persistence

Railway's default filesystem is **ephemeral** — anything written to disk
(including the session folder Baileys uses to store your login
credentials) is wiped on every redeploy or restart. That means:

- Without a persistent volume, you'll need to re-pair via the portal every
  time the service restarts or redeploys.
- **To fix this:** in Railway, go to your service → **Volumes** → **New
  Volume**, and mount it at any path (e.g. `/data`). Railway automatically
  sets an env var called `RAILWAY_VOLUME_MOUNT_PATH` pointing at that path.
  The bot already detects this variable and stores the session there
  automatically — no extra config needed on the code side. Once the volume
  is attached, pairing survives redeploys and restarts.
- If you don't attach a volume, the bot falls back to storing the session
  next to the code, which works fine for local/dev use but won't survive a
  Railway redeploy.

## Connection reliability

If the bot loses connection (network blips, WhatsApp restarting the socket,
etc.) it now reconnects automatically with **exponential backoff** (3s, 6s,
12s, ... capped at 60s) instead of hammering the server every 3 seconds.
Logged-out sessions and corrupted session files are detected separately and
trigger a clean re-pair instead of an infinite retry loop.

## Pairing portal

The pairing page lives at `public/pair.html` as its own standalone file
(served as a static asset by Express) instead of being inlined inside
`index.js` — easier to tweak the design without touching bot logic. It
uses your actual logo (`public/assets/logo.png`, bundled in this repo,
resized/optimized so it loads fast), a fire/gold/black theme matching it,
a "100+ commands" badge, and short generated chime sounds
(success/error/click) — no external audio files needed.

The page also polls `/health` every few seconds and shows a live
"Waiting for connection... / Bot Connected ✅" status dot, so you can see
right on the pairing page once WhatsApp actually finishes linking after
you enter the code — you don't have to guess or check logs.

## What was fixed from the original

- **Pairing portal was disconnected from the running bot.** The `/code`
  route used to spin up a brand-new, throwaway Baileys socket/session on
  every request, so pairing through the web UI never actually connected
  the bot that `startMainBot()` was running. Now there is a single shared
  socket/session used by both the portal and the bot.
- **`.calc` used `eval()`** on raw, unsanitized user input from WhatsApp
  messages — a remote code execution risk. Replaced with a whitelist-based
  safe arithmetic evaluator that only allows digits and `+ - * / ( ) %`.
- **Crash risk on disconnect.** `lastDisconnect` itself could be
  `undefined` in some disconnect events; access is now optional-chained
  throughout, and reconnects are staggered with a short delay instead of
  reconnecting instantly in a tight loop.
- **Logged-out sessions weren't cleared**, which could leave the bot stuck
  trying to reuse invalid credentials. The session folder is now wiped
  automatically when WhatsApp reports a logout, so the portal can pair a
  fresh number.
- **Leaked sockets/session folders.** The old `/code` route never closed
  the sockets it created and left a `session_<timestamp>/` folder on disk
  per pairing attempt.
- **Express wasn't bound to `0.0.0.0`**, which can cause routing issues on
  some PaaS providers including Railway; now explicit.
- Removed the unused `rimraf` dependency, added a `.gitignore` so
  `node_modules/` and session folders never get committed, and added a
  `/health` endpoint.

## Commands

Send `.menu` (or `.help`) to the bot for the full, auto-generated list —
**90 unique commands, 104 total trigger words counting aliases** — across
five categories:

- **System** — ping, alive, runtime, owner, about, id, credits, etc.
- **Fun** — quote, joke, fact, riddle, 8ball, roll, rps, horoscope, trivia, etc.
- **Tools** — calc (safe, no `eval`), base64/hex/binary/url encode-decode,
  qr code generator, password generator, ascii art, `.weather` (Open-Meteo,
  free/no key), `.crypto` (CoinGecko, free/no key), `.ai` (existing AI proxy).
- **Group** (admin-only, group chats only) — tagall, hidetag, kick, add,
  promote, demote, mute/unmute, setname, setdesc, grouplink, revokelink,
  rules/setrules, antilink toggle, warn/resetwarn.
- **Owner-only** (set `OWNER_NUMBER` env var, digits only, with country
  code) — join, leave, block, unblock, restart, setbio.

### Environment variables

| Variable       | Required | Purpose                                             |
|----------------|----------|------------------------------------------------------|
| `OWNER_NUMBER` | Optional | Your WhatsApp number (digits only) to unlock owner-only commands. Defaults to `94744136085` if not set — override with an env var on Railway if you ever need to change it. |

### Notes on scope

- Media commands (stickers, image/video downloaders) were intentionally
  left out — they need heavier native dependencies (e.g. `sharp`) or
  third-party download APIs that are frequently unreliable/rate-limited,
  which would hurt deploy stability. Everything included here is either
  pure logic or a free public API with no key requirement, so it should
  work reliably out of the box.
- Group settings (`rules`, `antilink`, `warn` counts) are stored **in
  memory only** — they reset whenever the bot restarts/redeploys, same
  caveat as session persistence above. For anything you want to survive
  restarts, wire up a small database.
