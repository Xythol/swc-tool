# SWC Tool

Tampermonkey userscripts and tools for Star Wars Combine (swcombine.com), a persistent
text-based browser MMO. Built because the game has no native way to bookmark systems,
and because it exposes a real (if undocumented-to-search-engines) web API worth building
more tools against.

Repo: https://github.com/Xythol/swc-tool (public, so raw.githubusercontent.com URLs work
directly as Tampermonkey install/update URLs).

## Environment notes

**swcombine.com is fully behind Anubis bot-protection.** WebFetch/curl/any automated
tool gets served a challenge page instead of real content, on every subdomain and even
on the API's own JSON/XML responses. The only way to browse the site or call the API
from this environment is via the `claude-in-chrome` tools, using the user's
already-logged-in Chrome session (`/chrome` to enable). Don't assume WebFetch will work,
and don't re-attempt it after it fails once in a session.

**Inside the userscript, use plain `fetch()` (with `credentials: 'include'`), never
`GM_xmlhttpRequest`, for any call to swcombine.com.** `GM_xmlhttpRequest` gets served the
Anubis challenge page (HTTP 200, HTML, not the real response) because Tampermonkey routes
it through the extension background context, which Anubis fingerprints as non-browser.
Plain in-page `fetch()` passes fine, but is then subject to normal CORS/same-origin rules
— reliable only for calls made while actually browsing `www.swcombine.com`. This does NOT
apply to third-party APIs like api.github.com (not behind Anubis) — the Gist sync feature
below uses `GM_xmlhttpRequest` for that, on purpose.

The API Reference section below was captured via Chrome on 2026-09-18 and should be
re-verified the same way if it's been a while, since the game is under active development.

## Features — `swc-system-bookmarks.user.js`

A floating, collapsible overlay panel (bottom-right) injected on every swcombine.com page.

### Location bookmarks
Bookmark any space location — a system, planet, station, asteroid field, or empty deep
space coordinate, down to a specific city or ground spot. Every bookmark is stored as a
coordinate (`galX/galY`, optionally `sysX/sysY/surfX/surfY/groundX/groundY`) plus an
optional resolved name and note, and always links to the directed-travel planner
(`/members/cockpit/travel/directed.php`) — the only page that resolves any of these
uniformly, since only named systems have their own info page.

- Detected on a system's own page (scrapes the static "Coordinates:" text) and on the
  travel planner itself (reads the live form inputs, not the URL — the planner never
  navigates via query string, so URL-based detection goes stale the moment coordinates
  are hand-edited). Depth is read via `.offsetParent` on the deeper fields rather than
  hardcoding what each `#travelClass` value means.
- A resolved name (from `#systemSelector`/`#planetSelector`/the page's `<h2>` heading) is
  only trusted while the form still matches what the page loaded with — none of those
  elements reactively update on hand-edited coordinates, so an edited-but-unverified
  location falls back to a plain coordinate label instead of a stale name.
- Storage: `GM_setValue('swc_system_bookmarks', ...)`. Identity is derived from
  coordinates (`bookmarkKey()`), with a fallback for bookmarks saved by the original
  systemID-only version, so no migration was ever needed.

### Cross-device sync (GitHub Gist)
Manual **Pull** (overwrite local from the Gist) and **Push** (overwrite the Gist from
local) buttons, each behind an inline confirm step — deliberately not auto-resolved, so
sync direction is always the user's explicit choice rather than a timestamp-based guess
that could silently discard changes.

- One shared Gist (ID hardcoded in the script — not a secret, just an address) holds
  every device's bookmarks. The GitHub token is the only actual secret: entered once per
  device through the panel, stored via `GM_setValue` only, never in source (this script
  ships from a public repo, so anything in source is effectively public).
- Uses `GM_xmlhttpRequest` for api.github.com (see Environment notes above for why that's
  fine here but not for swcombine.com itself).

### Travel timer
Shows remaining hyperspace travel time, ticking down every second, without needing to
revisit the cockpit.

- The countdown can only ever be captured while the character is physically in the
  cockpit room — `/members/cockpit/` and the travel planner both redirect to
  `/members/position/` ("You are not in the cockpit.") otherwise, and the countdown
  widget is entirely absent from every page's DOM when away, not just hidden. So
  `detectLiveTravelCountdown()` reads the current page's live DOM directly (no
  background fetch — there's no page to poll once you've left), capturing a fresh
  snapshot whenever it happens to be visible, then ticks it down locally everywhere else.
- The countdown span's `data-years/days/hours/minutes/seconds` attributes are a static
  page-load snapshot — SWC's own JS only updates the *displayed text* every second, never
  the attributes. `refreshTravelState()` guards against re-reading this stale snapshot
  (comparing it to what the running clock already predicts) so it doesn't keep resetting
  the countdown to the same value every tick while sitting on the same page.
- Detection matches any element whose text is exactly `"<word> Travel"` with a
  `.countdown_clock` span as its next sibling's descendant — not hardcoded to
  "Hyperspace Travel" (untested for Atmosphere/Ground travel, but should generalize), and
  the structural sibling check is required to rule out unrelated matches (an
  achievements-list entry literally titled "Hyperspace Travel", a "Room Travel" nav link).
- Cleared automatically on cancellation via `hasQueuedDestination()`: the sidebar's
  "Travel Planner" row reads "Destination Set" whenever a trip is queued, and — unlike
  the countdown — this is visible on every `/members/*` page regardless of room. Anything
  else in that row clears the stored countdown instead of leaving a stale one ticking down.
- Inherently a last-known-good estimate once away from the cockpit (nothing re-confirms
  it from the server in between) — the panel shows "Last confirmed Xm ago" alongside the
  countdown, and "Should have arrived by now - open the cockpit to confirm" once it hits
  zero, rather than asserting arrival outright.
- Storage: `GM_setValue('swc_travel_state', {label, remainingSeconds, fetchedAt})`, or
  `null`.

### Removed / not built
- **XP/hour + time-to-level tracker** — built, then removed to make room for the travel
  timer. Full detail in git history if ever revisited. Don't rebuild without asking.
- **OAuth-based NPC/droid roster** — built fully working end-to-end, then scrapped: the
  user prefers this tool auth-free over OAuth's token-expiry/reconnect friction. Full
  build detail (app registration, Test Token flow, Inventory API shape) is in git history
  (commits `15918cc` through `69c15f5`) if OAuth is ever revisited. Don't rebuild without
  asking.
- **Hyperlane routing** — deliberately not built. See Decisions below.

## Decisions / standing constraints

- **Auth-free by design.** No OAuth flow currently exists in this tool, even though it
  would unlock the Tier 2/3 ideas below. Don't add one without asking first — the user
  has twice preferred to avoid OAuth's friction (see Removed/not built above).
- **Don't rebuild hyperlane routing.** [The Forge](https://swc-forge.com) — a third-party
  tool platform the user already has an account and companion Tampermonkey script for —
  already solves multi-jump pathfinding well (`/hl/routes`, its own API). It also has a
  galaxy map, ship/cargo calculators, vendor listings, and bounty-hunting tools. Before
  building any Tier 1/2/3 idea below, check whether The Forge already covers it and
  default to "use what exists" unless there's a specific reason to integrate with our
  own bookmarks instead.
- **The website login session does NOT authenticate API calls.** Confirmed by hitting
  authenticated endpoints from a logged-in browser with no `access_token` and getting
  `403 Access Token Not Provided`. API auth (OAuth2) and the site session are fully
  separate domains — relevant if Tier 2/3 OAuth work ever starts.

## Todo / future ideas

Roughly ordered by effort.

**Tier 1 — public API, no auth needed:**
- Galactic Time readout using `GET /ws/v2.0/api/time/`.
- Enrich the bookmarks panel with live per-system data (population, controlling faction,
  sector) via `GET /ws/v2.0/galaxy/systems/{uid}/`.
- Visual galaxy map — color-coded by faction, searchable, distance calculator — using
  `Galaxy/Systems`. (A visual map, not hyperlane routing — see Decisions above.)
- Faction lookup card (hover/click a faction name in-game) via `GET /ws/v2.0/faction/{uid}/`.
- GNS news reader/ticker, or a Discord bot posting new items.
- Public market/vendor price browser via `Market/Vendors` + `Market/Vendor`.

**Tier 2 — needs one-time OAuth2 login (read-only scopes):**
- Personal character dashboard: HP/XP, skills, credits, Force stats, location, recent
  events (`character_stats`/`character_skills`/`character_credits`/`character_force`/
  `character_location`/`character_events` scopes).
- Mail notifier — poll `Character/Messages` (`messages_read` scope).

**Tier 3 — bigger lift (write scopes, faction leadership, or a standalone service):**
- Faction treasury/budget dashboard (`faction_budgets_*`, `faction_credits_*`).
- Faction member roster tools / exports (`faction_members`).
- Discord bridge service (not just a userscript) posting GNS news, character events, or
  faction budget alerts — precedent: a community "T3M3.Bot" does similarly on the older
  `.NET` SDK.
- Android app wrapping the site + this userscript in a WebView (`evaluateJavascript`/
  `addJavascriptInterface`), since Tampermonkey has no Android build. Orthogonal to the
  tiers above (delivery mechanism, not a feature); a much bigger lift than anything else
  here — real Android dev, its own APK/repo.

OAuth for a browser-only tool means the client-side/implicit flow (no client secret),
needing an app registered on swcombine.com and a hosted redirect page — scope that out
properly before starting Tier 2.

## API Reference — SWCombine Web Service v2.0

Confirmed live via Chrome on 2026-09-18. Developer portal (browsable, but
Anubis-blocked to automated tools): `https://www.swcombine.com/ws/v2.0/developers/index.php`

Per-resource docs follow `https://www.swcombine.com/ws/v2.0/documentation/<category>/<resource-path>/`
where `<category>` is lowercase (`api`, `character`, `faction`, `galaxy`, `inventory`,
`market`, `news`, `datacard`, `events`, `location`, `types`, `index`) — click through from
the portal rather than guessing; not every path follows the obvious slug (e.g. the
singular `Character` resource's doc page is `/documentation/character/uid/`).

### Format & conventions

- All responses are XML in a `<swcapi xmlns="https://www.swcombine.com/ws/swcapi-ns/" version="2.0" ...>` envelope. JSON via `Accept: application/json` is untested.
- List endpoints paginate via `start_index` (1-based) and `item_count` (max 50).
- Auth is OAuth2: authorization-code, implicit/client-side, and refresh-token flows. Scopes requested by name.
- Rate limiting is per-endpoint. Check status: `GET /ws/v2.0/api/ratelimits/` (itself not rate limited).

### Confirmed public endpoints (no auth required)

| Resource | URL | Notes |
|---|---|---|
| Time | `GET/POST /ws/v2.0/api/time/` | GET returns current CGT (`years/days/hours/mins/secs`) plus a real-epoch `timestamp` attribute. POST converts between real timestamp and CGT (pass `years/days/hours/mins/secs`, or `time`) — returns the same fields plus the matching `timestamp`. |
| HandleCheck | `GET /ws/v2.0/character/handlecheck/{handle}/` | Resolves a character handle to a UID. 404 if it doesn't exist. |
| Faction | `GET /ws/v2.0/faction/[{uid}/]` | `uid` optional (name or numeric UID) — defaults to your own faction. Description, leader/2IC, colors, founding date, full datacard roster, subfactions, modules. |
| Factions | `GET /ws/v2.0/factions/` | List all factions. |
| Galaxy/System | `GET /ws/v2.0/galaxy/systems/{uid}/` | `uid` = name or numeric UID. Controlling faction, population, sector, galaxy x/y. |
| Galaxy/Systems | `GET /ws/v2.0/galaxy/systems/` | Paginated list of all ~1017 known systems, same fields. |
| Galaxy/Sector(s), Planet(s), City/Cities, Station(s) | under `/ws/v2.0/galaxy/...` | Not yet individually verified — follow the doc portal. |
| Market/Vendor(s) | `GET /ws/v2.0/market/vendor[s]/{uid}/` | Single vendor / paginated list of all public vendors. |
| GNS | `GET /ws/v2.0/news/gns/[{category}/]` | `category`: `auto\|economy\|military\|political\|social`. Filters: `start_date`, `end_date`, `search`, `author`, `faction`, `faction_type`, `item_count`, `start_index`. |
| GNS/Item, SimNews, SimNews/Item | under `/ws/v2.0/news/...` | Not yet individually verified. |
| Permissions | `GET /ws/v2.0/api/permissions/` | All 173 permission scopes with descriptions and `inherits` chains — re-fetch rather than trusting a stale copy. |
| HelloWorld | `GET /ws/v2.0/api/helloworld/` | Unauthenticated ping. |
| RateLimits | `GET /ws/v2.0/api/ratelimits/` | Current rate-limit status. |

### Confirmed auth-required endpoints (OAuth2 scopes)

| Resource | URL | Key scopes |
|---|---|---|
| HelloAuth | `GET /ws/v2.0/api/helloauth/` | `character_read` — authenticated ping. |
| Character | `GET /ws/v2.0/character/[{uid}/]` | `character_read` (+ `character_stats`, `character_privileges`, `character_skills`, `character_credits`, `character_force`, `character_location`, `character_events`, or `character_all`). Rate limited. |
| Character/Messages(/Id) | `GET,PUT .../messages/{mode}/`, `GET,DELETE .../messages/{msguid}/` | `messages_read`/`messages_send`/`messages_delete`/`messages_all`. |
| Character/Credits | `GET,POST .../credits/` | `character_credits` (read), `character_credits_write` (transfer). |
| Inventory | `GET /ws/v2.0/inventory/{uid}/` | `personal_inv_overview` or `faction_inv_overview`. Rate limited. Per-category scopes for ships/vehicles/stations/cities/facilities/planets/items/npcs/droids/materials/creatures — see `Permissions`. |
| Faction/Members, Budgets, Credits, Stockholders, Creditlog | under `/ws/v2.0/faction/{uid}/...` | `faction_members`, `faction_budgets_read/write`, `faction_credits_read/write`, `faction_stocks`, `faction_all`. |
| Datacard(s) | under `/ws/v2.0/datacard/...` | `faction_datacards_read/write`. |
| Events(/Id) | `GET /ws/v2.0/events/...` | `character_events` (and faction equivalent). |
| Types/* | under `/ws/v2.0/types/...` | Generic entity-type metadata, referenced as `href` links from other resources. Auth requirements not individually verified. |

### Sample response shapes

`GET /ws/v2.0/api/time/`:
```xml
<swcapi version="2.0" resource="time" timestamp="1790328303">
  <years>27</years><days>304</days><hours>2</hours><mins>25</mins><secs>3</secs>
</swcapi>
```

`GET /ws/v2.0/galaxy/systems/?item_count=1` (trimmed):
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
2. Load browser tools: `ToolSearch` with
   `select:mcp__claude-in-chrome__tabs_context_mcp,mcp__claude-in-chrome__navigate,mcp__claude-in-chrome__computer,mcp__claude-in-chrome__read_page,mcp__claude-in-chrome__tabs_create_mcp,mcp__claude-in-chrome__get_page_text,mcp__claude-in-chrome__find,mcp__claude-in-chrome__browser_batch`.
3. Navigate to `https://www.swcombine.com/ws/v2.0/developers/index.php` and use
   `get_page_text` for the full resource index, or `find`/`read_page` for a specific
   link's exact doc URL (slugs aren't always the obvious lowercase of the resource name).
4. For live response shapes, navigate directly to the `/ws/v2.0/api/...` URL (not
   `/documentation/...`) and read the XML via `get_page_text`.
5. Close any tabs you opened (`tabs_close_mcp`) when done.
