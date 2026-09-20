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

**This also bit the userscript itself (2026-09-18):** `GM_xmlhttpRequest` calls
from the userscript to `/ws/v2.0/...` got served the Anubis challenge page (HTTP
200, but an HTML "Making sure you're not a bot!" page, not the API XML) — even
though the same browser, same session, browsing normally, passes fine. A plain
in-page `fetch()` to the exact same URL does NOT get challenged. Anubis is
presumably fingerprinting `GM_xmlhttpRequest`'s extension-routed network stack
(Tampermonkey proxies it through the extension background context, not the page's
own renderer) as non-browser-like. **Takeaway: any userscript code calling
swcombine.com's API must use plain `fetch()` (with `credentials: 'include'`), never
`GM_xmlhttpRequest`, or it'll silently get Anubis HTML back instead of data.** The
only downside is `fetch()` is subject to normal CORS/same-origin rules, so it only
reliably works for API calls made while browsing `www.swcombine.com` itself (which
is where the API lives) — not verified from `www2`/`dev` subdomains.

The only way to actually browse the site or call the API from this environment is via
the `claude-in-chrome` tools, using the user's already-logged-in Chrome session (user
runs `/chrome` to enable it for a session). There is no way to verify site behavior,
DOM structure, or API responses without that — don't assume WebFetch will work, and
don't re-attempt it after it fails once in a session.

Everything in the "API Reference" section below was captured this way on 2026-09-18
and should be re-verified via `claude-in-chrome` if it's been a while, since the game
is under active development.

## Changelog

- **2026-09-20** — Reworked bookmarks to a single, uniform model: every
  bookmark is a galaxy coordinate (`galX`/`galY`, plus `sysX`/`sysY` for a
  position within a system) with an optional resolved name and a note, and
  every bookmark links to the same place — the directed-travel planner
  (`/members/cockpit/travel/directed.php`). This replaced an earlier two-branch
  design (named systems linking to their own info page, deep space linking to
  the planner) after the user pointed out they just want one uniform
  "coordinate + note" bookmark, for cases like asteroid fields and deep space
  staging points that don't have their own page. See "Bookmark implementation
  notes" below.
- **2026-09-18** — XP/hour + time-to-level tracker, replacing the NPC roster (see
  below). Samples current XP via a background `fetch('/members/')` — works from
  any page, including system pages where this panel lives, since the XP figure
  only renders on `/members/*` pages — at most once every 2 minutes, and computes
  a rate over a rolling 4-hour window of samples. See "XP tracker implementation
  notes" below for the non-obvious bit (the "Next: N" threshold isn't in the
  static DOM).
- **2026-09-18** — Built, then scrapped, an OAuth-based NPC/droid roster feature
  (popup connect flow + Test Token paste fallback + Inventory API calls) — fully
  working end to end, but the user decided to keep this tool auth-free rather than
  carry OAuth's token-expiry/reconnect friction for that feature. Full detail (app
  registration, Test Token generation via Chrome, confirmed Inventory API shape,
  the GitHub Pages OAuth callback page) is in git history from `15918cc` (Add
  OAuth callback page for GitHub Pages) through `69c15f5` (Remove OAuth callback
  page) if OAuth is ever revisited — not kept here to avoid this file carrying a
  large dead section. **Don't rebuild this without checking with the user first.**
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
- [x] XP/hour + time-to-level tracker (2026-09-18) — see Changelog and "XP tracker
      implementation notes" below. No API/auth involved at all, just page scraping.
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
- [ ] ~~NPC/droid roster~~ — built working end-to-end, then scrapped 2026-09-18;
      see Changelog. Don't restart this without checking with the user.

### Tier 3 — bigger lift (write scopes, faction leadership, or a standalone service)
- [ ] Faction treasury/budget dashboard (`faction_budgets_*`, `faction_credits_*`).
- [ ] Faction member roster tools / exports (`faction_members`).
- [ ] Discord bridge service (not just a userscript) posting GNS news, character
      events, or faction budget alerts — there's real precedent for this pattern:
      a community "T3M3.Bot" already does something similar on the older `.NET` SDK.

OAuth for a browser-only tool means the client-side/implicit flow (no client secret),
which needs an app registered on swcombine.com and a hosted redirect page. Bigger lift
than anything in Tier 1 — scope that out properly before starting Tier 2. **Full
detail on how this was built (app registration, Test Token generation via Chrome,
the confirmed Inventory API shape, the `access_denied_inactive_client` dead end,
the GitHub Pages callback page) is in git history — see the Changelog entry above
for the exact commit range — since it was built and then scrapped.** The one fact
still worth keeping here because it's general API knowledge, not NPC-specific: the
**website's login session cookie does NOT authenticate API calls** — confirmed by
hitting `/ws/v2.0/api/helloauth/` and `/ws/v2.0/character/` from the logged-in
browser with no `access_token` and getting `403 Access Token Not Provided`. The API
and the website session are separate auth domains by design.

### XP tracker implementation notes

The XP figure (`#menu_CurXP`, plain text like `6,613`) only renders on `/members/*`
pages — confirmed absent on `/rules/` and on system pages
(`/rules/?Galaxy_Map=&systemID=...`), which is where this panel is actually used.
So instead of scraping the current page, the tracker does a background
`fetch(location.origin + '/members/', { credentials: 'include' })` regardless of
what page you're on, and parses the response — same-origin, so no CORS issue, and
plain `fetch()` passes Anubis fine (see the GM_xmlhttpRequest note above).

**The "Next: N" level threshold is NOT in the static DOM** — it's rendered
client-side by a Vue component (`<coloured-status-bar2>`), so a `fetch()`+
`DOMParser` (which doesn't execute JS) can't read it from the parsed document.
It IS present as a static HTML attribute on that component's own tag before Vue
hydrates it, though:
```html
<coloured-status-bar2 width="90" height="12" :value="613" :value-max="4000"
  title="Next: 10,000" tooltip="6,613 / 10,000 XP..." unit="XP">
```
So the tracker greps the raw HTML text for `<coloured-status-bar2 ...>` tags,
picks the one with `unit="XP"` (there can be more than one status bar on the page
— HP, CP, etc.), and regexes `title="Next:\s*([\d,]+)"` out of it. This is more
fragile than a proper CSS selector (breaks if SWC renames the component or
reorders attributes) but there's no cleaner static source for this value.

Storage: `swc_xp_samples` (rolling array of `{t, xp}`, pruned to the last 4 hours
— `XP_WINDOW_MS` — capped at 200 entries), `swc_xp_next` (latest known threshold,
not time-series), `swc_xp_last_fetch` (throttle timestamp, min 2 minutes between
background samples — `XP_SAMPLE_INTERVAL_MS`). Rate is just
`(newest.xp - oldest.xp) / hoursBetween` across whatever's left in the window
after pruning — no smoothing beyond that. A manual "Sample now" button in the
panel bypasses the throttle for an on-demand reading.

### Bookmark implementation notes

Named systems have a stable info page (`/rules/?Galaxy_Map=&systemID=N`), but
nothing else does — no page exists for a planet, a station, an asteroid field,
or an empty point in deep space (confirmed live: `/rules/?Galaxy_Map=&x=..&y=..`
just falls back to the generic, unfocused galaxy map). What *does* address all
of those uniformly is the directed-travel planner,
`/members/cockpit/travel/directed.php`, via
`travelClass=2&supplied=1&galX={x}&galY={y}&sysX={x}&sysY={y}` query params —
confirmed this is the exact URL the game's own per-row "Plan Travel" links use
for every planet/station/asteroid field on a system page, and it's also what a
raw deep-space coordinate resolves to. Landing on it pre-fills the "Plan
Directed Travel" form (sector/system/position all resolved) without committing
anything — you still click "Update Plan" yourself.

So every bookmark is stored and linked the same way regardless of what's
actually there: `{galX, galY, sysX, sysY, name, note}`, always linking to that
planner URL. `name` is best-effort, filled in wherever it can be:

- On a system's own page: scraped from the static "Coordinates: (x, y)" text
  (`sysX`/`sysY` are `0,0` — the system's center) plus the page title.
- On the planner page itself: read from the selected `<option>` text of its
  `#systemSelector`/`#planetSelector` `<select>` elements, which the page
  itself pre-resolves whenever the coordinates land on a known place — no
  regex/scraping needed, just DOM element state. Their placeholder options
  (`-- System --` / `-- Planet --`) mean nothing resolved, i.e. genuine deep
  space; `name` is left `null` and the panel falls back to a coordinate label
  like `Deep Space (-71, -445)`.

Bookmark identity is derived, not stored: `bookmarkKey()` computes
`'c:' + galX,galY,sysX,sysY` from whatever fields a bookmark object has, rather
than reading a persisted `key` field. Bookmarks saved by the original
systemID-only version (plain `{id, name, note, ...}`, no coordinates) still
work — `bookmarkKey`/`bookmarkLabel`/`bookmarkUrl` all fall back to an
`'sys:' + id` identity and the old `/rules/?Galaxy_Map=&systemID=` link for
those, so there was no need for a storage migration.

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

- All responses are XML, wrapped in a `<swcapi xmlns="https://www.swcombine.com/ws/swcapi-ns/" version="2.0" timestamp="..." resource="..." request="...">` envelope. JSON via `Accept: application/json` is untested — if trying it from a userscript, use plain `fetch()`, not `GM_xmlhttpRequest` (see the Anubis note above).
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
