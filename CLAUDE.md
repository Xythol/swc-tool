# SWC Tool

Tampermonkey userscripts and tools for Star Wars Combine (swcombine.com), a persistent
text-based browser MMO. Built because the game has no native way to bookmark systems,
and because it exposes a real (if undocumented-to-search-engines) web API worth building
more tools against.

Repo: https://github.com/Xythol/swc-tool (public, so raw.githubusercontent.com URLs work
directly as Tampermonkey install/update URLs).

## Important environment note

**swcombine.com is fully behind Anubis bot-protection.** WebFetch/curl/any automated
tool gets served a challenge page instead of real content, for every URL on every
subdomain (www, www2, dev, guide, holocron, custom, images, ...) — this includes the
API's own documentation pages and even the JSON/XML API responses themselves.

The only way to actually browse the site or call the API from this environment is via
the `claude-in-chrome` tools, using the user's already-logged-in Chrome session (user
runs `/chrome` to enable it for a session). There is no way to verify site behavior,
DOM structure, or API responses without that — don't assume WebFetch will work, and
don't re-attempt it after it fails once in a session.

Everything in the "API Reference" section below was captured this way on 2026-09-18
and should be re-verified via `claude-in-chrome` if it's been a while, since the game
is under active development.

## Changelog

- **2026-09-18** — NPC roster feature complete: OAuth connect (popup + Test Token
  paste fallback), and a "NPC Roster" panel section that fetches the character's
  NPCs and droids (name, HP/hull, current location, role, level) via the Inventory
  API and shows them with a manual Refresh button. See "Registered app" and
  "Confirmed Inventory API shape" sections below for the full trail.
- **2026-09-18** — Initial release: `swc-system-bookmarks.user.js`. Floating overlay
  panel (bottom-right, collapsible) that detects the current system page via URL
  (`Galaxy_Map` + `systemID` query params) and tab title
  (`::System: <Name> - Star Wars Combine::`), lets you save it with a note, and lists
  saved systems as real links back to their system page. Storage via
  `GM_setValue`/`GM_getValue`, shared across all swcombine.com subdomains.
- **2026-09-18** — Fixed missing `@grant GM_addStyle` (script threw
  `GM_addStyle is not defined` on load — grant was omitted from the header while the
  code used it). Added `@updateURL`/`@downloadURL` pointing at the raw GitHub file so
  Tampermonkey auto-updates the script on future pushes to `master`.

## Todo / ideas

Roughly ordered by effort. None of these are started yet.

### Tier 1 — public API, no auth needed, can build without any OAuth setup
- [ ] Add a Galactic Time readout to the existing overlay (or a tiny standalone widget)
      using `GET /ws/v2.0/api/time/`.
- [ ] Enrich the bookmarks panel: fetch `GET /ws/v2.0/galaxy/systems/{uid}/` for each
      saved system and show population / controlling faction / sector inline, so you
      don't have to visit the page to see current status.
- [ ] Real galaxy map tool: `Galaxy/Systems` returns x/y coordinates, controlling
      faction, population, and sector per system. Enough to build a proper 2D map
      (color-coded by faction, searchable, straight-line distance calculator between
      two systems) — something the game itself doesn't provide. Note: this is about
      a *visual* map, not hyperlane routing — see "Prior art" below, that's solved.
- [ ] Faction lookup card — hover/click any faction name in-game to pop up a card
      pulled from `GET /ws/v2.0/faction/{uid}/` (description, leader, colors, roster).
- [ ] Galactic News (GNS) reader/ticker, or a Discord bot posting new items — endpoint
      supports date range, search text, author, faction, and faction-type filters.
- [ ] Public market/vendor price browser via `Market/Vendors` + `Market/Vendor`.

### Tier 2 — needs one-time OAuth2 login (read-only scopes)
- [ ] Personal character dashboard: HP/XP, skills, credits, Force stats, location,
      recent events in one view (`character_stats`, `character_skills`,
      `character_credits`, `character_force`, `character_location`,
      `character_events` scopes).
- [ ] Mail notifier — poll `Character/Messages` and surface new in-game mail
      (desktop notification or Discord ping) (`messages_read` scope).
- [x] NPC/droid roster (2026-09-18) — see Changelog. Not yet extended to
      ships/vehicles/items/etc., or to the entity-tagging support
      (`*_tags_read`/`*_tags_write`) for a custom organization scheme — that
      remains open if wanted later.

### Tier 3 — bigger lift (write scopes, faction leadership, or a standalone service)
- [ ] Faction treasury/budget dashboard (`faction_budgets_*`, `faction_credits_*`).
- [ ] Faction member roster tools / exports (`faction_members`).
- [ ] Discord bridge service (not just a userscript) posting GNS news, character
      events, or faction budget alerts — there's real precedent for this pattern:
      a community "T3M3.Bot" already does something similar on the older `.NET` SDK.

OAuth for a browser-only tool means the client-side/implicit flow (no client secret),
which needs an app registered on swcombine.com and a hosted redirect page. Bigger lift
than anything in Tier 1 — scope that out properly before starting Tier 2.

**Confirmed empirically (2026-09-18): the website's login session cookie does NOT
authenticate API calls.** Hit `/ws/v2.0/api/helloauth/` and `/ws/v2.0/character/`
directly from the user's logged-in browser with no `access_token` — both returned
`403 Access Token Not Provided`. The API and the website session are separate auth
domains by design; there is no shortcut through "already being logged in."

**App registration** is self-service, no approval wait observed: start at
`https://www.swcombine.com/ws/registration/` (Step 1 is just an App Name — linked
account is auto-filled from whoever registers it). Authorized apps and their live
tokens are manageable/revocable at
`https://www.swcombine.com/members/actsettings/index.php?mode=ws` ("Web Services" tab
under Account Settings) — this page is also how to inspect exactly what scopes an
app actually holds.

**Important architecture finding**: `client_id` is not secret — safe to hardcode
directly in the userscript source (checked into this repo), so it ships to every
device automatically via the existing `@updateURL` mechanism, no per-device setup.
But the *token lifecycle* has a real fork, confirmed by inspecting the user's own
token list on the Web Services settings page:

- **The Forge holds both an Access Token AND a Refresh Token** for this user. Per
  SWC's own OAuth docs, refresh tokens are only issued via the **authorization-code**
  flow (server-side) — the **client-side/implicit** flow (`response_type=token`,
  the only flow a pure browser userscript can do without exposing a secret) has no
  refresh token in its response at all. This means The Forge runs its own backend
  that holds a `client_secret` and refreshes tokens silently forever, without ever
  re-prompting the user.
- A pure Tampermonkey userscript **cannot replicate that** — implicit-flow access
  tokens expire (lifetime returned as `expires_in` on issuance, actual value for
  this API not yet confirmed) and there is no secret-free way to mint a new one
  without redirecting the user through `/ws/oauth2/auth/` again. SWC's docs mention
  a `renew_previously_granted=yes` param that may allow a silent-ish re-grant if the
  site session is still active and the same scopes were already approved — untested,
  worth verifying empirically before relying on it.
- **Decision point for whoever builds Tier 2**: accept periodic "reconnect" friction
  (pure client-side implicit flow, no new infrastructure, consistent with this repo
  being "just a userscript" so far) vs. build a small hosted backend to hold a
  `client_secret` and do silent refresh like The Forge (meaningfully bigger lift —
  closer to Tier 3 in scope, needs somewhere to run and to store the refresh token
  server-side, never in client JS).
- **Decided (2026-09-18)**: going with the pure client-side/implicit flow, occasional
  reconnect prompts accepted. No backend.

### OAuth redirect page (GitHub Pages)

`oauth-callback.html` at the repo root is the OAuth app's `redirect_uri` target,
served via GitHub Pages: **https://xythol.github.io/swc-tool/oauth-callback.html**
(Pages enabled 2026-09-18 via `gh api repos/Xythol/swc-tool/pages`, source =
`master` branch root — takes a minute to start serving after first enabling).

It's a plain static page with **no Tampermonkey dependency** — it doesn't need to be
in the userscript's `@match` list. Mechanism: the "Connect" button in the overlay
opens the SWC auth URL in a `window.open()` popup (not a full-page redirect) and
keeps a reference to it; SWC redirects that popup to this page with
`#access_token=...&expires_in=...` in the fragment; the page parses the fragment
client-side (fragments never hit a server) and calls
`window.opener.postMessage({ source: 'swc-tool-oauth', access_token, expires_in }, '*')`
before closing itself. The main content script listens for that `message` event on
the game tab, verifies `event.source` is the popup it opened, and stores the token
(+ computed expiry) via `GM_setValue`. Handles the `error=access_denied` case too.

When registering the app at `https://www.swcombine.com/ws/registration/`, use the
Pages URL above as the redirect URI.

### Registered app: "SWC Tool" — blocked on "Active: No"

Registered 2026-09-18, id 281. `Client ID` = `fccda0a63979711c8d1138da34ac30b38576be36`
(this is the value embedded as `OAUTH_CLIENT_ID` in the userscript — confirmed
against the account settings page, not a guess). `Client Secret` exists but is
intentionally unused/never embedded anywhere, per the "no backend" decision above.

**The real popup-based OAuth flow does not work yet.** Hitting
`/ws/oauth2/auth/` with this client_id returns `<error>access_denied_inactive_client</error>`.
The app's edit page (`/members/actsettings/clients_edit.php?id=281`) shows
`Active: No` as a plain read-only label — no self-service toggle found anywhere in
the UI. Likely needs manual/staff-side approval (unconfirmed — the
`www.swcombine.com/ws/developers/` hub 403'd when checked for an FAQ on this, and
`#swc-dev` on IRC was the only dev-contact channel found via the `swc-core` repo
README). **Next time this comes up: check if it's since flipped to Active, and if
not, consider asking in the game/Discord/IRC what activates a client.**

**Workaround that works today: Test Tokens.** Account Settings → Web Services →
the app's "Test Token" action
(`/members/actsettings/index.php?mode=wstesttoken&id=281`) lets the account owner
self-generate a scoped access token directly, no "Active" requirement, via a
checkbox list of the same 173 permissions. Constraint: **expires in 1 hour, no
refresh** — must be manually regenerated and re-entered each time. Useful for
developing/testing the Inventory API calls right now regardless of activation
status, and may end up being the permanent mechanism if activation turns out to be
gated behind something out of reach (e.g. requires being a known/trusted developer).

Minimal scope set for the NPC roster feature (tick only these on the Test Token
page — everything else, especially any `*_write`/`*_rename`/`*_assign` box, is
unnecessary for a read-only dashboard): `personal_inv_overview`,
`personal_inv_npcs_read`, `personal_inv_droids_read`. Matches `OAUTH_SCOPES` in the
userscript exactly.

**Implemented (2026-09-18)**: the overlay's "NPC Roster" section has two ways to
get a token — the popup Connect button (non-functional until the app is Active),
and a plain paste-a-token input next to it that accepts a Test Token and stores it
via `saveOAuthToken(value, 3600)` (hardcoded 1-hour TTL, since that's fixed for
Test Tokens).

**Generating a Test Token via Chrome, if needed again**: the checkboxes on
`/members/actsettings/index.php?mode=wstesttoken&id=281` are plain
`<input type="checkbox" name="scope[]" value="...">` elements, but this page is
Vue-heavy and coordinate/ref-based clicks were unreliable (silently didn't toggle
the box). Set `.checked = true` and dispatch `change`+`input` events via
`javascript_tool` instead, then find the "Create Test Token" button by text and
call `.click()` on it directly (also via JS) rather than a coordinate click. On
success it does a real form POST that redirects to `mode=ws` with a flash message
"Created test access token: XXXX" at the top — that flash is the only place the
raw token is ever shown, so read the page immediately after.

Also: **never navigate to a URL with a raw token in the query string** — Claude
Code's own auto-mode classifier blocks this ("Credential Materialization"), and
rightly so, since it'd land in browser history. Use `fetch()` with an
`Authorization: OAuth <token>` header via `javascript_tool` instead — same
result, doesn't materialize the secret anywhere.

### Confirmed Inventory API shape (2026-09-18, via a self-issued Test Token)

`GET /ws/v2.0/inventory/{characterHandle}/` (needs `personal_inv_overview`) returns
one `<inventory type="...">` block per category (`ship`, `vehicle`, `station`,
`facility`, `city`, `planet`, `item`, `npc`, `droid`, `creature`, `material`), each
with `owner`/`commander`/`pilot` role sub-elements carrying an `href` to that
role's actual entity collection, e.g.:
`/ws/v2.0/inventory/{characterUid}/npcs/owner/` (characterUid is the `type:id`
form like `1:1479537`, from the `uid` attribute on any role element).

`GET` that role href (needs `personal_inv_npcs_read` / `personal_inv_droids_read`)
returns the full entity list **with everything needed for a roster view in one
call — no per-entity follow-up request required**:

```xml
<entities count="10" start="1" total="10">
  <entity href=".../inventory/npcs/10%3A21304262/">
    <uid>10:21304262</uid>
    <entitytype>NPC</entitytype>
    <name>Nayva Ran-shok</name>
    <owner uid="1:1479537" type="character" href="...">Zythol Kho</owner>
    <!-- commander, pilot: same shape as owner -->
    <images><small>...</small><large>...</large></images>
    <protected>no</protected>
    <hp max="61">61</hp>
    <location>
      <container uid="2:3809211" type="ship" href="...">[AL] Hunter</container>
      <sector .../><system .../><planet .../><city .../>
      <coordinates><galaxy x="-73" y="-443"/><system x="8" y="9"/>...</coordinates>
    </location>
    <type uid="10:23" href=".../types/npcs/rifleman/">Rifleman</type>
    <race uid="22:27" href="...">Qiraash</race>
    <gender gender="F">Female</gender>
    <level>1</level>
    <tags count="1"><tag>Shotgun</tag></tags>
  </entity>
  <!-- ... -->
</entities>
```

**Droids use a different health model** — no `hp`, instead:
`<wrecked>no</wrecked><hull max="55">55</hull><shield max="0">0</shield><ionic max="55">55</ionic>`
(no `race`/`gender` either, otherwise same shape: `uid`, `entitytype`, `name`,
owner/commander/pilot, `images`, `location`, `type`).

This means the NPC roster feature needs exactly one authenticated GET per category
(`npcs/owner/` and `droids/owner/`) — cheap, no pagination needed at this
character's scale (10 NPCs, 1 droid; `count`/`start`/`total` attributes are there
if it ever needs paging past 50).

### Prior art — check before building anything new

**The Forge** (https://swc-forge.com) is a third-party community tool platform the
user already has an account on, with a companion Tampermonkey script already
installed (its console logs show as "Forge" — "Inventory Module", "Equipment
Module", etc.). Confirmed features as of 2026-09-18:

- **Hyper Routes** (`/hl/routes`) — exactly the "fastest route via hyperlanes"
  problem: multi-jump pathfinding between two systems, using ship presets or manual
  Pilot Skill/Hyper/Sublight stats, with per-leg and total time, a direct-route
  comparison (% time saved), system exclusions, and a map visualization. Backed by
  its own API at `api.swc-forge.com/api/hyper/v2/routes` (third-party, not the
  official SWC web service — the official API has no Hyperlane resource, so this
  connectivity data is something The Forge scrapes/maintains itself).
- Also has: Galaxy Map, ship comparison, cargo/fitout calculators, vendor listings,
  bounty hunting tools (contract tracking, target heatmap), asteroid fields, Discord
  timestamp helper. Full nav is visible at `swc-forge.com` when logged in.

**Decision (2026-09-18): don't rebuild hyperlane routing** — The Forge already does
it well and the user already uses it. Before starting any new Tier 1/2/3 idea above,
check whether The Forge already covers it; if so, default to "use what exists"
unless the user specifically wants a tighter integration with our own bookmarks tool
or has an explicit reason to build our own.

## API Reference — SWCombine Web Service v2.0

Confirmed live via Chrome on 2026-09-18, logged in as the user's character. The
official developer portal (browsable, but Anubis-blocked to automated tools):

    https://www.swcombine.com/ws/v2.0/developers/index.php

Per-resource docs follow the pattern
`https://www.swcombine.com/ws/v2.0/documentation/<category>/<resource-path>/`
where `<category>` is lowercase (`api`, `character`, `faction`, `galaxy`, `inventory`,
`market`, `news`, `datacard`, `events`, `location`, `types`, `index`) — click through
from the portal rather than guessing; not every path follows the obvious slug (e.g.
the singular `Character` resource's doc page is `/documentation/character/uid/`, and
`Galaxy/System`'s is `/documentation/galaxy/systems/uid/`).

### Format & conventions

- All responses are XML, wrapped in a `<swcapi xmlns="https://www.swcombine.com/ws/swcapi-ns/" version="2.0" timestamp="..." resource="..." request="...">` envelope. JSON via `Accept: application/json` is untested — worth trying with `GM_xmlhttpRequest` (bypasses CORS) before assuming XML-only.
- List endpoints paginate via `start_index` (1-based) and `item_count` (max 50) query params.
- Auth is OAuth2: authorization-code (server apps), implicit/client-side (browser apps, no secret), and refresh-token flows. Scopes are requested by name (below).
- Rate limiting is per-endpoint, not global. Check your own status: `GET /ws/v2.0/api/ratelimits/` (itself not rate limited).

### Confirmed public endpoints (no auth required)

| Resource | URL | Notes |
|---|---|---|
| Time | `GET/POST /ws/v2.0/api/time/` | GET returns current CGT (`years/days/hours/mins/secs`). POST converts between real timestamp and CGT (`cgt` or `time` param). |
| HandleCheck | `GET /ws/v2.0/character/handlecheck/{handle}/` | Resolves a character handle to a UID. 404 if it doesn't exist. |
| Faction | `GET /ws/v2.0/faction/[{uid}/]` | `uid` optional (name or numeric UID) — defaults to your own faction. Returns description, leader/2IC, colors, founding date, full datacard (ship/item/droid) roster, subfactions, modules. |
| Factions | `GET /ws/v2.0/factions/` | List all factions. |
| Galaxy/System | `GET /ws/v2.0/galaxy/systems/{uid}/` | `uid` = name or numeric UID. Returns controlling faction, population, sector, and galaxy x/y coordinates. |
| Galaxy/Systems | `GET /ws/v2.0/galaxy/systems/` | Paginated list of all ~1017 known systems, same fields as above per system. |
| Galaxy/Sector(s), Planet(s), City/Cities, Station(s) | under `/ws/v2.0/galaxy/...` | Not yet individually verified in detail — same category, follow the doc portal. |
| Market/Vendor | `GET /ws/v2.0/market/vendor/{uid}/` | Single public vendor. |
| Market/Vendors | `GET /ws/v2.0/market/vendors/` | Paginated list of all public vendors. |
| GNS | `GET /ws/v2.0/news/gns/[{category}/]` | `category` one of `auto\|economy\|military\|political\|social`. Query params: `start_date`, `end_date`, `search`, `author`, `faction`, `faction_type`, `item_count`, `start_index`. |
| GNS/Item, SimNews, SimNews/Item | under `/ws/v2.0/news/...` | Not yet individually verified. |
| Permissions | `GET /ws/v2.0/api/permissions/` | Full list of all 173 permission scopes with descriptions and `inherits` chains — the authoritative source, re-fetch this rather than trusting a stale copy. |
| HelloWorld | `GET /ws/v2.0/api/helloworld/` | Unauthenticated ping. |
| RateLimits | `GET /ws/v2.0/api/ratelimits/` | Your current rate-limit status. |

### Confirmed auth-required endpoints (OAuth2 scopes)

| Resource | URL | Key scopes |
|---|---|---|
| HelloAuth | `GET /ws/v2.0/api/helloauth/` | `character_read` — authenticated ping, echoes what that scope reveals. |
| Character | `GET /ws/v2.0/character/[{uid}/]` | `character_read` (+ `character_stats`, `character_privileges`, `character_skills`, `character_credits`, `character_force`, `character_location`, `character_events`, or `character_all` for everything). Rate limited. |
| Character/Messages(/Id) | `GET,PUT /ws/v2.0/character/{uid}/messages/{mode}/`, `GET,DELETE .../messages/{msguid}/` | `messages_read` / `messages_send` / `messages_delete` / `messages_all`. |
| Character/Credits | `GET,POST /ws/v2.0/character/{uid}/credits/` | `character_credits` (read), `character_credits_write` (transfer). |
| Inventory | `GET /ws/v2.0/inventory/{uid}/` | `personal_inv_overview` or `faction_inv_overview`. Rate limited. Per-category scopes (`personal_inv_ships_read`, `..._tags_write`, etc.) for ships/vehicles/stations/cities/facilities/planets/items/npcs/droids/materials/creatures — see full list via the live `Permissions` endpoint. |
| Faction/Members, Budgets, Credits, Stockholders, Creditlog | under `/ws/v2.0/faction/{uid}/...` | `faction_members`, `faction_budgets_read/write`, `faction_credits_read/write`, `faction_stocks`, `faction_all`. |
| Datacard(s) | under `/ws/v2.0/datacard/...` | `faction_datacards_read/write`. |
| Events(/Id) | `GET /ws/v2.0/events/...` | `character_events` (and faction equivalent). |
| Types/* | under `/ws/v2.0/types/...` | Generic entity-type metadata (classes, entity types) — referenced heavily as `href` links from other resources (e.g. ship type links in a faction's datacards). Auth requirements not yet individually verified. |

### Sample response shapes (captured live)

`GET /ws/v2.0/api/time/`:
```xml
<swcapi version="2.0" resource="time">
  <years>27</years><days>297</days><hours>4</hours><mins>45</mins><secs>2</secs>
</swcapi>
```

`GET /ws/v2.0/galaxy/systems/?item_count=1` (one system, trimmed):
```xml
<systems count="1" start="1" total="1017">
  <system uid="9:1" name="Averam" href=".../galaxy/systems/averam/">
    <controlledby uid="20:736" href=".../faction/total%20outer%20rim/">Total Outer Rim</controlledby>
    <population>1549202599</population>
    <location>
      <sector uid="25:160" href=".../galaxy/sectors/seswenna/">Seswenna</sector>
      <coordinates><galaxy x="50" y="-339"/></coordinates>
    </location>
  </system>
</systems>
```

### How to re-verify or extend this reference

1. Ask the user to run `/chrome` (they must already be logged in to swcombine.com).
2. Load the browser tools: `ToolSearch` with
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__find,mcp__claude-in-chrome__browser_batch`.
3. Navigate to `https://www.swcombine.com/ws/v2.0/developers/index.php` and use
   `get_page_text` for the full resource index, or `find`/`read_page` on a specific
   link to get its exact doc URL (slugs are not always the obvious lowercase of the
   resource name — confirm via the actual `href`, don't guess).
4. For live response shapes, navigate directly to the `/ws/v2.0/api/...` URL (not
   `/documentation/...`) and read the XML via `get_page_text`.
5. Close any tabs you opened (`tabs_close_mcp`) when done.
