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
      two systems) — something the game itself doesn't provide.
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
- [ ] Unified inventory dashboard across ships/vehicles/items/droids/etc., using the
      API's own entity-tagging support for a custom organization scheme
      (`personal_inv_*_read` + `*_tags_read`/`*_tags_write` scopes).

### Tier 3 — bigger lift (write scopes, faction leadership, or a standalone service)
- [ ] Faction treasury/budget dashboard (`faction_budgets_*`, `faction_credits_*`).
- [ ] Faction member roster tools / exports (`faction_members`).
- [ ] Discord bridge service (not just a userscript) posting GNS news, character
      events, or faction budget alerts — there's real precedent for this pattern:
      a community "T3M3.Bot" already does something similar on the older `.NET` SDK.

OAuth for a browser-only tool means the client-side/implicit flow (no client secret),
which needs an app registered on swcombine.com and a hosted redirect page. Bigger lift
than anything in Tier 1 — scope that out properly before starting Tier 2.

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
