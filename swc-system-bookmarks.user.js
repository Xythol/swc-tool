// ==UserScript==
// @name         SWC Space System Bookmarks
// @namespace    https://github.com/swc-tool
// @version      1.11.0
// @description  Bookmark any space location in Star Wars Combine - systems, planets, asteroid fields, deep space - track remaining hyperspace travel time (captured while in the cockpit, ticking locally elsewhere), and manually pull/push bookmarks across devices via a GitHub Gist.
// @author       you
// @match        *://*.swcombine.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @grant        GM_xmlhttpRequest
// @connect      api.github.com
// @run-at       document-end
// @noframes
// @updateURL    https://raw.githubusercontent.com/Xythol/swc-tool/master/swc-system-bookmarks.user.js
// @downloadURL  https://raw.githubusercontent.com/Xythol/swc-tool/master/swc-system-bookmarks.user.js
// ==/UserScript==

(function () {
    'use strict';

    var STORAGE_KEY = 'swc_system_bookmarks';
    var PANEL_OPEN_KEY = 'swc_panel_open';

    var TRAVEL_STATE_KEY = 'swc_travel_state';

    // A single shared Gist holds every device's bookmarks - see "Bookmark sync
    // implementation notes" in CLAUDE.md for why the ID is safe to hardcode
    // here (it's not a secret) while the token below never is.
    var GIST_ID = '158b588abf4c589ce6d42ea831b4a539';
    var GIST_FILENAME = 'swc-bookmarks.json';
    var GIST_TOKEN_KEY = 'swc_gist_token';
    var BOOKMARKS_UPDATED_KEY = 'swc_bookmarks_updated_at';
    var GIST_LAST_SYNC_KEY = 'swc_gist_last_sync'; // timestamp of the last successful pull or push, for display only

    // ---------- storage ----------

    function getBookmarks() {
        var raw = GM_getValue(STORAGE_KEY, '[]');
        try {
            var list = JSON.parse(raw);
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    // Every local edit (add/remove/note change) bumps this - it's what sync
    // compares against the Gist's own updatedAt to decide push vs pull. See
    // applyRemoteBookmarks() for the pull side, which sets this to the
    // remote's timestamp instead of "now".
    function saveBookmarks(list) {
        GM_setValue(STORAGE_KEY, JSON.stringify(list));
        GM_setValue(BOOKMARKS_UPDATED_KEY, Date.now());
    }

    function getBookmarksUpdatedAt() {
        return GM_getValue(BOOKMARKS_UPDATED_KEY, 0);
    }

    function isPanelOpen() {
        return GM_getValue(PANEL_OPEN_KEY, true);
    }

    function setPanelOpen(open) {
        GM_setValue(PANEL_OPEN_KEY, open);
    }

    // ---------- travel timer ----------
    //
    // The cockpit's hyperspace-travel countdown is gated to physically being
    // in the cockpit room, not just to a URL - confirmed live that visiting
    // /members/cockpit/ (or the travel planner) while elsewhere on the ship
    // just redirects to /members/position/ with "You are not in the cockpit.",
    // and the countdown widget is completely absent from the DOM on every
    // other page, including /members/ itself. So there is no page to poll
    // this from once you've left - the only thing available is to capture the
    // countdown whenever the panel happens to render on a page where it's
    // actually present, which happens naturally: you have to be in the
    // cockpit to set travel in the first place. Everywhere else, the panel
    // just ticks that last captured reading down locally.
    //
    // Also confirmed live: the countdown span's data-years/days/hours/
    // minutes/seconds attributes are a STATIC page-load snapshot - SWC's own
    // JS only updates the span's displayed text every second, never the
    // attributes themselves. So re-reading them from an already-loaded page
    // (e.g. on every tick of the setInterval below) would keep re-capturing
    // the same stale snapshot with a fresh "now" timestamp, freezing the
    // display instead of counting down - see the guard in
    // refreshTravelState() below.
    //
    // Detection looks for an element whose full text is exactly "<word>
    // Travel" with the countdown span (class `countdown_clock`, a generic
    // countdown widget SWC reuses in several places) as its next sibling's
    // descendant - rather than hardcoding "Hyperspace Travel", so this should
    // also pick up Atmosphere/Ground travel if SWC ever shows those the same
    // way (unverified - see CLAUDE.md). The structural check (next sibling
    // has the actual span) is load-bearing: an achievements-list entry
    // literally titled "Hyperspace Travel" and a "Room Travel" nav link both
    // match the text alone but have no adjacent countdown.
    function detectLiveTravelCountdown() {
        if (!document.querySelector('span.countdown_clock[data-hours]')) return null;
        var candidates = document.querySelectorAll('body *');
        for (var i = 0; i < candidates.length; i++) {
            var label = candidates[i];
            var text = (label.textContent || '').trim().replace(/\s+/g, ' ');
            if (!/^\w+\s+travel$/i.test(text)) continue;
            var valueRow = label.nextElementSibling;
            var span = valueRow ? valueRow.querySelector('span.countdown_clock[data-hours]') : null;
            if (!span) continue;
            var seconds =
                (parseInt(span.getAttribute('data-years'), 10) || 0) * 365 * 86400 +
                (parseInt(span.getAttribute('data-days'), 10) || 0) * 86400 +
                (parseInt(span.getAttribute('data-hours'), 10) || 0) * 3600 +
                (parseInt(span.getAttribute('data-minutes'), 10) || 0) * 60 +
                (parseInt(span.getAttribute('data-seconds'), 10) || 0);
            return { label: text, remainingSeconds: seconds };
        }
        return null;
    }

    // {label, remainingSeconds, fetchedAt} as of the last live capture, or
    // null if a countdown has never been seen - fetchedAt is what lets the
    // panel keep ticking the display down locally on pages that can't see
    // the countdown themselves.
    function getTravelState() {
        try {
            return JSON.parse(GM_getValue(TRAVEL_STATE_KEY, 'null'));
        } catch (e) {
            return null;
        }
    }

    // The sidebar's "Travel Planner" row reads "Destination Set" whenever a
    // trip is queued - and unlike the countdown itself, confirmed live that
    // this is visible on EVERY /members/* page regardless of which room the
    // character is in (it still read "Destination Set" from the ship
    // inventory page while away from the cockpit, mid-trip). That makes it a
    // room-independent way to notice a tracked trip was cancelled (or
    // completed) without a new one being queued - something the countdown's
    // absence alone can't tell apart from "not currently on a page that shows
    // it" (see detectLiveTravelCountdown). The exact "nothing queued" text
    // hasn't been observed live - that would need an actual cancelled trip to
    // see - so this treats anything OTHER than exactly "Destination Set" as
    // no destination queued, rather than matching a guessed off-state string.
    // Returns null (not false) when the "Travel Planner" row isn't present on
    // this page at all, so callers don't mistake "can't tell" for "no".
    function hasQueuedDestination() {
        var all = document.querySelectorAll('body *');
        for (var i = 0; i < all.length; i++) {
            var label = all[i];
            if (label.textContent.trim().replace(/\s+/g, ' ') !== 'Travel Planner') continue;
            var value = label.nextElementSibling;
            return !!value && value.textContent.trim().replace(/\s+/g, ' ') === 'Destination Set';
        }
        return null;
    }

    function refreshTravelState() {
        var info = detectLiveTravelCountdown();
        if (info) {
            var prev = getTravelState();
            if (prev && prev.label === info.label) {
                var predicted = prev.remainingSeconds - (Date.now() - prev.fetchedAt) / 1000;
                // Same trip, and this matches what we'd already predict for
                // right now - this is the frozen data-* attributes from the
                // CURRENT page's initial load being read again (see comment
                // above), not a new server reading, so leave the clock alone.
                if (Math.abs(info.remainingSeconds - predicted) < 5) return;
            }
            GM_setValue(TRAVEL_STATE_KEY, JSON.stringify({ label: info.label, remainingSeconds: info.remainingSeconds, fetchedAt: Date.now() }));
            return;
        }
        // No live countdown on this page. Only worth checking further if we
        // have something tracked that could need clearing - hasQueuedDestination()
        // scans the whole page, so skip it entirely once there's nothing to lose.
        if (getTravelState() && hasQueuedDestination() === false) {
            GM_setValue(TRAVEL_STATE_KEY, 'null');
        }
    }

    function formatCountdown(totalSeconds) {
        var s = Math.max(0, Math.floor(totalSeconds));
        var years = Math.floor(s / 31536000); s %= 31536000;
        var days = Math.floor(s / 86400); s %= 86400;
        var hours = Math.floor(s / 3600); s %= 3600;
        var minutes = Math.floor(s / 60); s %= 60;
        var parts = [];
        if (years) parts.push(years + 'y');
        if (years || days) parts.push(days + 'd');
        if (years || days || hours) parts.push(hours + 'h');
        parts.push(minutes + 'm');
        parts.push(s + 's');
        return parts.join(' ');
    }

    // ---------- bookmark sync (GitHub Gist) ----------

    function getGistToken() {
        return GM_getValue(GIST_TOKEN_KEY, '');
    }

    function setGistToken(token) {
        GM_setValue(GIST_TOKEN_KEY, token);
    }

    // Pulling from remote sets the local timestamp to the REMOTE's updatedAt
    // (not Date.now()) so this device's next sync comparison is still correct
    // - it now matches what's on GitHub, not "just edited locally".
    function applyRemoteBookmarks(list, remoteUpdatedAt) {
        GM_setValue(STORAGE_KEY, JSON.stringify(list));
        GM_setValue(BOOKMARKS_UPDATED_KEY, remoteUpdatedAt);
    }

    function gistRequest(method, body, onDone) {
        var token = getGistToken();
        if (!token) { onDone({ error: 'no-token' }); return; }
        GM_xmlhttpRequest({
            method: method,
            url: 'https://api.github.com/gists/' + GIST_ID,
            headers: {
                'Authorization': 'token ' + token,
                'Accept': 'application/vnd.github+json',
                'Content-Type': 'application/json'
            },
            data: body ? JSON.stringify(body) : undefined,
            onload: function (res) {
                if (res.status < 200 || res.status >= 300) {
                    onDone({ error: 'http-' + res.status });
                    return;
                }
                try {
                    onDone({ data: JSON.parse(res.responseText) });
                } catch (e) {
                    onDone({ error: 'parse' });
                }
            },
            onerror: function () { onDone({ error: 'network' }); },
            ontimeout: function () { onDone({ error: 'timeout' }); }
        });
    }

    function fetchGistData(onDone) {
        gistRequest('GET', null, function (res) {
            if (res.error) { onDone(res); return; }
            var file = res.data.files && res.data.files[GIST_FILENAME];
            var content = file && file.content ? file.content : '';
            var parsed;
            try {
                parsed = content ? JSON.parse(content) : {};
            } catch (e) {
                parsed = {};
            }
            onDone({
                data: {
                    updatedAt: parsed.updatedAt || 0,
                    bookmarks: Array.isArray(parsed.bookmarks) ? parsed.bookmarks : []
                }
            });
        });
    }

    function pushGistData(payload, onDone) {
        var body = { files: {} };
        body.files[GIST_FILENAME] = { content: JSON.stringify(payload, null, 2) };
        gistRequest('PATCH', body, onDone);
    }

    // No auto-resolve: the previous version compared a single updatedAt
    // timestamp and silently overwrote whichever side was older when both had
    // changed. Replaced by explicit, user-triggered pull/push (each always
    // overwrites one side, unconditionally) after the user asked for control
    // over sync direction rather than having it guessed - see CLAUDE.md.
    function pullBookmarks(onDone) {
        if (!getGistToken()) { onDone({ error: 'no-token' }); return; }
        fetchGistData(function (res) {
            if (res.error) { onDone(res); return; }
            applyRemoteBookmarks(res.data.bookmarks, res.data.updatedAt);
            GM_setValue(GIST_LAST_SYNC_KEY, Date.now());
            onDone({ result: 'pulled' });
        });
    }

    function pushBookmarks(onDone) {
        if (!getGistToken()) { onDone({ error: 'no-token' }); return; }
        var updatedAt = Date.now();
        pushGistData({ updatedAt: updatedAt, bookmarks: getBookmarks() }, function (res) {
            if (res.error) { onDone(res); return; }
            GM_setValue(BOOKMARKS_UPDATED_KEY, updatedAt);
            GM_setValue(GIST_LAST_SYNC_KEY, Date.now());
            onDone({ result: 'pushed' });
        });
    }

    function describeSyncResult(res) {
        if (!res) return '';
        if (res.error === 'no-token') return 'Set a token below to enable sync.';
        if (res.error === 'http-401' || res.error === 'http-403') return 'Sync error: token invalid or missing gist scope.';
        if (res.error === 'http-404') return 'Sync error: Gist not found.';
        if (res.error) return 'Sync error: ' + res.error;
        if (res.result === 'pulled') return 'Pulled bookmarks from GitHub.';
        if (res.result === 'pushed') return 'Pushed local bookmarks to GitHub.';
        return '';
    }

    function formatRelativeTime(ms) {
        if (!ms) return 'never';
        var diff = Date.now() - ms;
        if (diff < 60000) return 'just now';
        if (diff < 3600000) return Math.round(diff / 60000) + 'm ago';
        if (diff < 86400000) return Math.round(diff / 3600000) + 'h ago';
        return Math.round(diff / 86400000) + 'd ago';
    }


    // ---------- current location detection ----------
    //
    // Every bookmarkable place in the game - a system's center, a planet, a
    // station, an asteroid field, or an empty point in deep space - is
    // addressable the same way: the directed-travel planner at
    // /members/cockpit/travel/directed.php, pre-filled via
    // travelClass=2&supplied=1&galX=..&galY=..&sysX=..&sysY=.. query params.
    // Confirmed live: this is the exact URL the game's own per-row "Plan Travel"
    // links use for planets/stations/asteroid fields on a system page, and it's
    // also the only page a raw deep-space coordinate resolves to at all
    // (/rules/?Galaxy_Map=&x=..&y=.. just falls back to the generic galaxy map).
    // So bookmarks are always stored and linked the same way - {galX, galY,
    // sysX, sysY, name} - regardless of what's actually there. name is best-
    // effort (system/planet name when one resolves, null for empty deep space).

    // Convenience save point 1: a system's own info page, so bookmarking a
    // named system doesn't require detouring through the travel planner first.
    function detectSystemPageLocation() {
        var params = new URLSearchParams(location.search);
        if (!params.has('Galaxy_Map') || !params.has('systemID')) return null;

        var titleMatch = document.title.match(/^::System:\s*(.+?)\s*-\s*Star Wars Combine::$/);
        if (!titleMatch) return null;

        // Static text on the page, e.g. "Coordinates: (-73, -443)".
        var coordMatch = (document.body.innerText || '').match(/Coordinates:\s*\((-?\d+),\s*(-?\d+)\)/);
        if (!coordMatch) return null;

        return { galX: coordMatch[1], galY: coordMatch[2], sysX: '0', sysY: '0', name: titleMatch[1] };
    }

    // Convenience save point 2: the travel planner itself. It never navigates
    // via query string - landing on it bare shows whatever plan is currently
    // active, and "Update Plan" is a same-URL form POST - so the only reliable
    // source of truth is the live form state: the coordinate number inputs,
    // which hold the current plan OR whatever the user is mid-typing,
    // regardless of how they got to the page. Reading the URL (the original
    // approach) only worked for the one case of landing via a "Plan Travel"
    // link and went stale the moment the user edited coordinates by hand
    // without the URL changing to match.
    //
    // The form goes three levels deep, one pair of inputs each, picked via the
    // "Destination:" dropdown (#travelClass: 2=Space, 1=Atmosphere, 0=Ground):
    // galX/galY (system) -> sysX/sysY (planet/station/field within it) ->
    // surfX/surfY (surface position, i.e. roughly "which city") -> groundX/
    // groundY (a specific spot on the ground). #surfX etc. exist in the DOM at
    // every depth but are only shown (and only meaningful) once the dropdown
    // goes deep enough - .offsetParent lets us read exactly as deep as the
    // form currently is, rather than hardcoding what each travelClass value
    // means.
    //
    // Captured once, the first time the travel planner is detected on a given
    // page load - i.e. before any hand-editing - so we can tell whether the
    // form still matches what the page loaded with (see below).
    var travelPlannerInitialSnapshot = null;

    function detectTravelPlannerLocation() {
        if (location.pathname.indexOf('/members/cockpit/travel/directed.php') === -1) return null;

        var galXEl = document.getElementById('galX');
        var galYEl = document.getElementById('galY');
        if (!galXEl || !galYEl) return null;

        var galX = galXEl.value;
        var galY = galYEl.value;
        if (!/^-?\d+$/.test(galX) || !/^-?\d+$/.test(galY)) return null;

        var sysXEl = document.getElementById('sysX');
        var sysYEl = document.getElementById('sysY');
        var sysX = (sysXEl && sysXEl.value) || '0';
        var sysY = (sysYEl && sysYEl.value) || '0';

        var travelClassEl = document.getElementById('travelClass');
        var travelClass = travelClassEl ? travelClassEl.value : '2';

        var surfXEl = document.getElementById('surfX');
        var hasSurf = !!(surfXEl && surfXEl.offsetParent !== null);
        var surfX = hasSurf ? surfXEl.value : null;
        var surfY = hasSurf ? ((document.getElementById('surfY') || {}).value || '0') : null;

        var groundXEl = document.getElementById('groundX');
        var hasGround = !!(groundXEl && groundXEl.offsetParent !== null);
        var groundX = hasGround ? groundXEl.value : null;
        var groundY = hasGround ? ((document.getElementById('groundY') || {}).value || '0') : null;

        var snapshot = [galX, galY, sysX, sysY, surfX, surfY, groundX, groundY, travelClass].join('|');
        if (travelPlannerInitialSnapshot === null) travelPlannerInitialSnapshot = snapshot;
        var unedited = snapshot === travelPlannerInitialSnapshot;

        // #systemSelector / #planetSelector and the page's own <h2> heading are
        // all resolved once, server-side, to match whatever plan the page
        // loaded with - confirmed live that none of them reactively re-resolve
        // when the coordinate boxes are hand-edited, they just keep showing
        // the previous plan's values. So a resolved name is only trustworthy
        // while unedited; the moment the form differs from what the page
        // loaded with, treat the name as unknown rather than show a stale,
        // wrong one.
        var name = null;
        if (unedited) {
            var systemSel = document.getElementById('systemSelector');
            var planetSel = document.getElementById('planetSelector');
            var systemName = systemSel && systemSel.selectedIndex >= 0 ? systemSel.options[systemSel.selectedIndex].text : '';
            var planetName = planetSel && planetSel.selectedIndex >= 0 ? planetSel.options[planetSel.selectedIndex].text : '';
            if (systemName && systemName.indexOf('--') === -1) {
                name = (planetName && planetName.indexOf('--') === -1) ? (systemName + ' – ' + planetName) : systemName;
            }
            // At Ground depth the page's <h2> heading resolves to a specific
            // local descriptor ("Rock Terrain at 0, 0", or a city name when
            // the spot is actually inside one) that the selectors above don't
            // capture - worth appending since it's the only source of that.
            if (hasGround) {
                var heading = (document.querySelector('h2.fancy') || {}).textContent;
                heading = heading ? heading.trim() : '';
                if (heading) name = name ? (name + ' – ' + heading) : heading;
            }
        }

        return {
            galX: galX, galY: galY, sysX: sysX, sysY: sysY,
            surfX: surfX, surfY: surfY, groundX: groundX, groundY: groundY,
            travelClass: travelClass, name: name
        };
    }

    function detectCurrent() {
        return detectSystemPageLocation() || detectTravelPlannerLocation();
    }

    // Derived rather than stored, so bookmarks saved by earlier versions (plain
    // {id, name, ...} or {galX, galY, sysX, sysY, ...} with no surf/ground)
    // still get a stable identity and keep working, and each bookmark's key
    // only goes as deep as the fields it actually has.
    function bookmarkKey(bm) {
        if (bm.galX == null) return 'sys:' + bm.id;
        var parts = [bm.galX, bm.galY, bm.sysX || '0', bm.sysY || '0'];
        if (bm.surfX != null) parts.push(bm.surfX, bm.surfY || '0');
        if (bm.groundX != null) parts.push(bm.groundX, bm.groundY || '0');
        return 'c:' + parts.join(',');
    }

    function bookmarkLabel(bm) {
        if (bm.galX == null) return bm.name;
        if (bm.name) return bm.name;
        // No name doesn't always mean nothing's there - it can also mean the
        // coordinates were hand-edited and never re-verified (see
        // detectTravelPlannerLocation), so this stays a neutral coordinate
        // label rather than asserting e.g. "Deep Space" for something we're
        // not actually sure about. Each coordinate pair present is shown so
        // two different unresolved bookmarks in the same system don't look
        // identical.
        var parts = [bm.galX + ', ' + bm.galY];
        if (bm.surfX != null) parts.push(bm.surfX + ', ' + bm.surfY);
        if (bm.groundX != null) parts.push(bm.groundX + ', ' + bm.groundY);
        return '(' + parts.join(' / ') + ')';
    }

    function bookmarkUrl(bm) {
        if (bm.galX == null) return location.origin + '/rules/?Galaxy_Map=&systemID=' + encodeURIComponent(bm.id);
        var url = location.origin + '/members/cockpit/travel/directed.php?travelClass=' +
            encodeURIComponent(bm.travelClass != null ? bm.travelClass : '2') +
            '&supplied=1&galX=' + encodeURIComponent(bm.galX) + '&galY=' + encodeURIComponent(bm.galY) +
            '&sysX=' + encodeURIComponent(bm.sysX || '0') + '&sysY=' + encodeURIComponent(bm.sysY || '0');
        if (bm.surfX != null) url += '&surfX=' + encodeURIComponent(bm.surfX) + '&surfY=' + encodeURIComponent(bm.surfY || '0');
        if (bm.groundX != null) url += '&groundX=' + encodeURIComponent(bm.groundX) + '&groundY=' + encodeURIComponent(bm.groundY || '0');
        return url;
    }

    // ---------- styles ----------

    GM_addStyle([
        '#swc-bm-toggle {',
        '  position: fixed; bottom: 16px; right: 16px; z-index: 2147483647;',
        '  background: #1c1f26; color: #f2c94c; border: 1px solid #3a3f4b;',
        '  border-radius: 6px; padding: 8px 12px; font: 13px/1.4 sans-serif;',
        '  cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.5);',
        '}',
        '#swc-bm-panel {',
        '  position: fixed; bottom: 56px; right: 16px; z-index: 2147483647;',
        '  width: 300px; max-height: 70vh; overflow-y: auto;',
        '  background: #1c1f26; color: #e8e8e8; border: 1px solid #3a3f4b;',
        '  border-radius: 8px; box-shadow: 0 4px 16px rgba(0,0,0,0.6);',
        '  font: 13px/1.4 sans-serif;',
        '}',
        '#swc-bm-panel.swc-hidden { display: none; }',
        '#swc-bm-header {',
        '  display: flex; align-items: center; justify-content: space-between;',
        '  padding: 10px 12px; border-bottom: 1px solid #3a3f4b; font-weight: bold; color: #f2c94c;',
        '}',
        '#swc-bm-current {',
        '  padding: 10px 12px; border-bottom: 1px solid #3a3f4b;',
        '}',
        '#swc-bm-current .swc-bm-name { font-weight: bold; display: block; margin-bottom: 6px; }',
        '#swc-bm-current .swc-bm-hint { color: #999; font-style: italic; }',
        '.swc-bm-btn {',
        '  background: #2c313c; color: #f2c94c; border: 1px solid #3a3f4b;',
        '  border-radius: 4px; padding: 4px 10px; cursor: pointer; font-size: 12px;',
        '}',
        '.swc-bm-btn:hover { background: #3a3f4b; }',
        '.swc-bm-btn:disabled { opacity: 0.5; cursor: default; }',
        '#swc-bm-list { list-style: none; margin: 0; padding: 0; }',
        '#swc-bm-list li {',
        '  padding: 8px 12px; border-bottom: 1px solid #2a2e37; display: flex; flex-direction: column; gap: 4px;',
        '}',
        '#swc-bm-list li:last-child { border-bottom: none; }',
        '.swc-bm-row-top { display: flex; align-items: center; justify-content: space-between; gap: 6px; }',
        '.swc-bm-link { color: #6cb4ff; text-decoration: none; font-weight: bold; }',
        '.swc-bm-link:hover { text-decoration: underline; }',
        '.swc-bm-remove {',
        '  background: none; border: none; color: #d9534f; cursor: pointer; font-size: 14px; line-height: 1;',
        '}',
        '.swc-bm-note {',
        '  width: 100%; box-sizing: border-box; background: #12141a; color: #ccc;',
        '  border: 1px solid #3a3f4b; border-radius: 4px; padding: 3px 6px; font-size: 12px;',
        '}',
        '.swc-bm-empty { padding: 12px; color: #999; font-style: italic; }',
        '#swc-bm-travel { padding: 10px 12px; border-top: 1px solid #3a3f4b; display: flex; flex-direction: column; gap: 4px; }',
        '#swc-bm-sync { padding: 10px 12px; border-top: 1px solid #3a3f4b; display: flex; flex-direction: column; gap: 4px; }',
        '.swc-bm-row { display: flex; align-items: center; gap: 6px; }',
        '.swc-bm-row .swc-bm-hint { flex: 1; }',
        '.swc-bm-section-header { font-weight: bold; color: #f2c94c; }',
    ].join('\n'));

    // ---------- rendering ----------

    var panel, list, currentBox, toggleBtn, syncBox, travelBox;
    var gistTokenEditing = false;
    var lastSyncMessage = '';
    // 'pull' | 'push' | null - set when a direction button is clicked, cleared
    // on confirm/cancel/error. Renders an inline "are you sure" step before
    // either action runs, since each unconditionally overwrites one side.
    var pendingSyncAction = null;

    function render() {
        renderCurrent();
        renderList();
        renderTravel();
        renderSync();
    }

    function renderTravel() {
        travelBox.innerHTML = '';

        var header = document.createElement('div');
        header.className = 'swc-bm-section-header';
        header.textContent = 'Travel Timer';
        travelBox.appendChild(header);

        var state = getTravelState();
        var line = document.createElement('div');
        line.className = 'swc-bm-hint';

        if (!state) {
            line.textContent = 'No travel seen yet - open the cockpit once while traveling to start tracking.';
            travelBox.appendChild(line);
            return;
        }

        var elapsed = (Date.now() - state.fetchedAt) / 1000;
        var remaining = state.remainingSeconds - elapsed;
        line.textContent = remaining > 0
            ? state.label + ': ' + formatCountdown(remaining)
            : 'Should have arrived by now - open the cockpit to confirm.';
        travelBox.appendChild(line);

        // This is a local estimate wherever the countdown itself isn't
        // visible on the current page (see the comment above
        // detectLiveTravelCountdown) - say so, in the same spirit as the
        // "Local edited / last synced" line in Bookmark Sync.
        var asOf = document.createElement('div');
        asOf.className = 'swc-bm-hint';
        asOf.textContent = 'Last confirmed ' + formatRelativeTime(state.fetchedAt) + '.';
        travelBox.appendChild(asOf);
    }

    function renderSync() {
        syncBox.innerHTML = '';

        var headerRow = document.createElement('div');
        headerRow.className = 'swc-bm-row';

        var header = document.createElement('div');
        header.className = 'swc-bm-section-header';
        header.textContent = 'Bookmark Sync';
        headerRow.appendChild(header);
        syncBox.appendChild(headerRow);

        var token = getGistToken();

        if (!token || gistTokenEditing) {
            pendingSyncAction = null;
            var input = document.createElement('input');
            input.type = 'password';
            input.className = 'swc-bm-note';
            input.placeholder = 'GitHub token (gist scope)';
            syncBox.appendChild(input);

            var saveRow = document.createElement('div');
            saveRow.className = 'swc-bm-row';
            var saveBtn = document.createElement('button');
            saveBtn.className = 'swc-bm-btn';
            saveBtn.textContent = 'Save token';
            saveBtn.addEventListener('click', function () {
                var val = input.value.trim();
                if (!val) return;
                setGistToken(val);
                gistTokenEditing = false;
                renderSync();
            });
            saveRow.appendChild(saveBtn);
            syncBox.appendChild(saveRow);

            var hint = document.createElement('div');
            hint.className = 'swc-bm-hint';
            hint.textContent = 'Stored locally on this device only - paste the same token/gist on every device you want synced.';
            syncBox.appendChild(hint);
            return;
        }

        if (pendingSyncAction) {
            var warn = document.createElement('div');
            warn.className = 'swc-bm-hint';
            warn.textContent = pendingSyncAction === 'pull'
                ? 'This will overwrite your LOCAL bookmarks with what is on GitHub. Continue?'
                : 'This will overwrite the GitHub Gist with your LOCAL bookmarks. Continue?';
            syncBox.appendChild(warn);

            var confirmRow = document.createElement('div');
            confirmRow.className = 'swc-bm-row';

            var confirmBtn = document.createElement('button');
            confirmBtn.className = 'swc-bm-btn';
            confirmBtn.textContent = pendingSyncAction === 'pull' ? 'Confirm pull' : 'Confirm push';
            confirmBtn.addEventListener('click', function () {
                var action = pendingSyncAction;
                confirmBtn.disabled = true;
                var run = action === 'pull' ? pullBookmarks : pushBookmarks;
                run(function (res) {
                    pendingSyncAction = null;
                    lastSyncMessage = describeSyncResult(res);
                    if (action === 'pull' && res && res.result === 'pulled') render(); else renderSync();
                });
            });
            confirmRow.appendChild(confirmBtn);

            var cancelBtn = document.createElement('button');
            cancelBtn.className = 'swc-bm-btn';
            cancelBtn.textContent = 'Cancel';
            cancelBtn.addEventListener('click', function () {
                pendingSyncAction = null;
                renderSync();
            });
            confirmRow.appendChild(cancelBtn);
            syncBox.appendChild(confirmRow);
            return;
        }

        var actionRow = document.createElement('div');
        actionRow.className = 'swc-bm-row';

        var pullBtn = document.createElement('button');
        pullBtn.className = 'swc-bm-btn';
        pullBtn.textContent = 'Pull from Gist';
        pullBtn.addEventListener('click', function () {
            pendingSyncAction = 'pull';
            renderSync();
        });
        actionRow.appendChild(pullBtn);

        var pushBtn = document.createElement('button');
        pushBtn.className = 'swc-bm-btn';
        pushBtn.textContent = 'Push to Gist';
        pushBtn.addEventListener('click', function () {
            pendingSyncAction = 'push';
            renderSync();
        });
        actionRow.appendChild(pushBtn);
        syncBox.appendChild(actionRow);

        var statusLine = document.createElement('div');
        statusLine.className = 'swc-bm-hint';
        var localUpdated = getBookmarksUpdatedAt();
        var lastSync = GM_getValue(GIST_LAST_SYNC_KEY, 0);
        statusLine.textContent = lastSyncMessage ||
            ('Local edited ' + formatRelativeTime(localUpdated) + ' · last synced ' + formatRelativeTime(lastSync));
        syncBox.appendChild(statusLine);

        var changeBtn = document.createElement('button');
        changeBtn.className = 'swc-bm-btn';
        changeBtn.textContent = 'Change token';
        changeBtn.addEventListener('click', function () {
            gistTokenEditing = true;
            renderSync();
        });
        syncBox.appendChild(changeBtn);
    }

    function renderCurrent() {
        currentBox.innerHTML = '';
        var current = detectCurrent();

        if (!current) {
            var hint = document.createElement('div');
            hint.className = 'swc-bm-hint';
            hint.textContent = 'Not on a bookmarkable page.';
            currentBox.appendChild(hint);
            return;
        }

        var nameEl = document.createElement('span');
        nameEl.className = 'swc-bm-name';
        nameEl.textContent = bookmarkLabel(current);
        currentBox.appendChild(nameEl);

        var bookmarks = getBookmarks();
        var currentKey = bookmarkKey(current);
        var already = bookmarks.some(function (b) { return bookmarkKey(b) === currentKey; });

        var btn = document.createElement('button');
        btn.className = 'swc-bm-btn';
        if (already) {
            btn.textContent = 'Saved ✓';
            btn.disabled = true;
        } else {
            btn.textContent = '★ Save this location';
            btn.addEventListener('click', function () {
                var list = getBookmarks();
                var bm = {
                    galX: current.galX,
                    galY: current.galY,
                    sysX: current.sysX,
                    sysY: current.sysY,
                    name: current.name || null,
                    note: '',
                    addedAt: Date.now()
                };
                // Only carry fields as deep as detectCurrent() actually found -
                // detectSystemPageLocation() never sets these, and
                // detectTravelPlannerLocation() only sets them when the form
                // is showing that depth (see .offsetParent checks there).
                if (current.surfX != null) {
                    bm.surfX = current.surfX;
                    bm.surfY = current.surfY;
                }
                if (current.groundX != null) {
                    bm.groundX = current.groundX;
                    bm.groundY = current.groundY;
                }
                if (current.travelClass != null) bm.travelClass = current.travelClass;
                list.push(bm);
                saveBookmarks(list);
                render();
            });
        }
        currentBox.appendChild(btn);
    }

    function renderList() {
        list.innerHTML = '';
        var bookmarks = getBookmarks();

        if (bookmarks.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'swc-bm-empty';
            empty.textContent = 'No saved locations yet.';
            list.appendChild(empty);
            return;
        }

        bookmarks
            .slice()
            .sort(function (a, b) { return bookmarkLabel(a).localeCompare(bookmarkLabel(b)); })
            .forEach(function (bm) {
                var key = bookmarkKey(bm);
                var li = document.createElement('li');

                var top = document.createElement('div');
                top.className = 'swc-bm-row-top';

                var link = document.createElement('a');
                link.className = 'swc-bm-link';
                link.href = bookmarkUrl(bm);
                link.textContent = bookmarkLabel(bm);
                top.appendChild(link);

                var remove = document.createElement('button');
                remove.className = 'swc-bm-remove';
                remove.textContent = '×';
                remove.title = 'Remove bookmark';
                remove.addEventListener('click', function () {
                    var updated = getBookmarks().filter(function (b) { return bookmarkKey(b) !== key; });
                    saveBookmarks(updated);
                    render();
                });
                top.appendChild(remove);

                li.appendChild(top);

                var note = document.createElement('input');
                note.type = 'text';
                note.className = 'swc-bm-note';
                note.placeholder = 'Add a note or tag...';
                note.value = bm.note || '';
                note.addEventListener('change', function () {
                    var updated = getBookmarks();
                    var target = updated.find(function (b) { return bookmarkKey(b) === key; });
                    if (target) {
                        target.note = note.value;
                        saveBookmarks(updated);
                    }
                });
                li.appendChild(note);

                list.appendChild(li);
            });
    }

    // ---------- panel construction ----------

    function buildPanel() {
        toggleBtn = document.createElement('button');
        toggleBtn.id = 'swc-bm-toggle';
        toggleBtn.textContent = '★ Locations';
        document.body.appendChild(toggleBtn);

        panel = document.createElement('div');
        panel.id = 'swc-bm-panel';

        var header = document.createElement('div');
        header.id = 'swc-bm-header';
        header.innerHTML = '<span>★ My Locations</span>';
        panel.appendChild(header);

        currentBox = document.createElement('div');
        currentBox.id = 'swc-bm-current';
        panel.appendChild(currentBox);

        list = document.createElement('ul');
        list.id = 'swc-bm-list';
        panel.appendChild(list);

        travelBox = document.createElement('div');
        travelBox.id = 'swc-bm-travel';
        panel.appendChild(travelBox);

        syncBox = document.createElement('div');
        syncBox.id = 'swc-bm-sync';
        panel.appendChild(syncBox);

        document.body.appendChild(panel);

        function applyOpenState(open) {
            panel.classList.toggle('swc-hidden', !open);
        }

        applyOpenState(isPanelOpen());

        toggleBtn.addEventListener('click', function () {
            var open = !isPanelOpen();
            setPanelOpen(open);
            applyOpenState(open);
        });

        refreshTravelState();
        render();

        // Ticks the travel timer display down every second, and re-checks the
        // live DOM each time in case a countdown just appeared (you opened
        // the cockpit) or changed (a new plan was submitted) - refreshTravelState
        // itself no-ops when it's just re-reading the same frozen snapshot
        // from this page's initial load (see its comment), so this doesn't
        // reset the clock every tick.
        setInterval(function () {
            refreshTravelState();
            renderTravel();
        }, 1000);

        // The travel planner's coordinate inputs/dropdowns change without any
        // navigation (same-page form, no URL update - see
        // detectTravelPlannerLocation), so the panel needs its own listeners to
        // stay in sync as the user edits them, rather than only detecting state
        // once at page load.
        var TRAVEL_PLANNER_FIELD_IDS = [
            'galX', 'galY', 'sysX', 'sysY', 'surfX', 'surfY', 'groundX', 'groundY',
            'systemSelector', 'planetSelector', 'travelClass'
        ];
        document.addEventListener('input', function (e) {
            if (e.target && TRAVEL_PLANNER_FIELD_IDS.indexOf(e.target.id) !== -1) renderCurrent();
        });
        document.addEventListener('change', function (e) {
            if (e.target && TRAVEL_PLANNER_FIELD_IDS.indexOf(e.target.id) !== -1) renderCurrent();
        });
    }

    buildPanel();
})();
