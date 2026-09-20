// ==UserScript==
// @name         SWC Space System Bookmarks
// @namespace    https://github.com/swc-tool
// @version      1.4.1
// @description  Bookmark any space location in Star Wars Combine - systems, planets, asteroid fields, deep space - and track XP/hour + time to next level.
// @author       you
// @match        *://*.swcombine.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-end
// @noframes
// @updateURL    https://raw.githubusercontent.com/Xythol/swc-tool/master/swc-system-bookmarks.user.js
// @downloadURL  https://raw.githubusercontent.com/Xythol/swc-tool/master/swc-system-bookmarks.user.js
// ==/UserScript==

(function () {
    'use strict';

    var STORAGE_KEY = 'swc_system_bookmarks';
    var PANEL_OPEN_KEY = 'swc_panel_open';

    var XP_SAMPLES_KEY = 'swc_xp_samples';
    var XP_NEXT_KEY = 'swc_xp_next';
    var XP_LAST_FETCH_KEY = 'swc_xp_last_fetch';
    var XP_SAMPLE_INTERVAL_MS = 2 * 60 * 1000; // don't background-sample more often than this
    var XP_WINDOW_MS = 4 * 60 * 60 * 1000; // rate is computed over the last 4 hours of samples
    var XP_MAX_SAMPLES = 200;

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

    function saveBookmarks(list) {
        GM_setValue(STORAGE_KEY, JSON.stringify(list));
    }

    function isPanelOpen() {
        return GM_getValue(PANEL_OPEN_KEY, true);
    }

    function setPanelOpen(open) {
        GM_setValue(PANEL_OPEN_KEY, open);
    }

    // ---------- XP tracking ----------

    // The XP figure only appears in the #menu_CurXP widget on /members/* pages,
    // not on system pages where this panel actually lives - so instead of
    // scraping the current page, we fetch /members/ in the background
    // (same-origin fetch(), which passes Anubis fine - GM_xmlhttpRequest does not,
    // see CLAUDE.md) and parse the XP out of that response.
    function fetchCurrentXP(onDone) {
        fetch(location.origin + '/members/', { credentials: 'include' })
            .then(function (res) { return res.text(); })
            .then(function (html) {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var curEl = doc.getElementById('menu_CurXP');
                if (!curEl) {
                    onDone(null);
                    return;
                }
                var current = parseInt(curEl.textContent.replace(/,/g, ''), 10);
                if (isNaN(current)) {
                    onDone(null);
                    return;
                }
                // The "Next: N" figure is rendered client-side by a Vue component and
                // isn't in the static DOM, but it IS present as a static attribute on
                // that component's tag before Vue hydrates it - so pull it from the
                // raw HTML rather than the parsed document.
                var next = null;
                var bars = html.match(/<coloured-status-bar2\b[^>]*>/gi) || [];
                var xpBar = bars.filter(function (tag) { return /unit="XP"/i.test(tag); })[0];
                if (xpBar) {
                    var m = xpBar.match(/title="Next:\s*([\d,]+)"/i);
                    if (m) next = parseInt(m[1].replace(/,/g, ''), 10);
                }
                onDone({ current: current, next: next });
            })
            .catch(function () { onDone(null); });
    }

    function getXPSamples() {
        var raw = GM_getValue(XP_SAMPLES_KEY, '[]');
        try {
            var list = JSON.parse(raw);
            return Array.isArray(list) ? list : [];
        } catch (e) {
            return [];
        }
    }

    function addXPSample(xp) {
        var samples = getXPSamples();
        samples.push({ t: Date.now(), xp: xp });
        var cutoff = Date.now() - XP_WINDOW_MS;
        samples = samples.filter(function (s) { return s.t >= cutoff; });
        if (samples.length > XP_MAX_SAMPLES) samples = samples.slice(samples.length - XP_MAX_SAMPLES);
        GM_setValue(XP_SAMPLES_KEY, JSON.stringify(samples));
    }

    function recordXPReading(info) {
        addXPSample(info.current);
        GM_setValue(XP_NEXT_KEY, info.next == null ? '' : String(info.next));
    }

    function maybeSampleXP(onDone) {
        var lastFetch = GM_getValue(XP_LAST_FETCH_KEY, 0);
        if (Date.now() - lastFetch < XP_SAMPLE_INTERVAL_MS) {
            if (onDone) onDone(false);
            return;
        }
        GM_setValue(XP_LAST_FETCH_KEY, Date.now());
        fetchCurrentXP(function (info) {
            if (info) recordXPReading(info);
            if (onDone) onDone(!!info);
        });
    }

    function formatDuration(hours) {
        var totalMinutes = Math.round(hours * 60);
        var days = Math.floor(totalMinutes / 1440);
        var hrs = Math.floor((totalMinutes % 1440) / 60);
        var mins = totalMinutes % 60;
        var parts = [];
        if (days > 0) parts.push(days + 'd');
        if (hrs > 0) parts.push(hrs + 'h');
        if (days === 0 && mins > 0) parts.push(mins + 'm');
        return parts.length ? parts.join(' ') : '0m';
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
    // source of truth is the live form state: the #galX/#galY/#sysX/#sysY
    // number inputs, which hold the current plan OR whatever the user is
    // mid-typing, regardless of how they got to the page. Reading the URL (the
    // original approach) only worked for the one case of landing via a "Plan
    // Travel" link and went stale the moment the user edited coordinates by
    // hand without the URL changing to match.
    // Captured once, the first time the travel planner is detected on a given
    // page load - i.e. before any hand-editing - so we can tell whether the
    // coordinate boxes still match what the page loaded with (see below).
    var travelPlannerInitialCoords = null;

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

        if (travelPlannerInitialCoords === null) {
            travelPlannerInitialCoords = { galX: galX, galY: galY, sysX: sysX, sysY: sysY };
        }
        var unedited = travelPlannerInitialCoords.galX === galX && travelPlannerInitialCoords.galY === galY &&
            travelPlannerInitialCoords.sysX === sysX && travelPlannerInitialCoords.sysY === sysY;

        // #systemSelector / #planetSelector are resolved by the page once,
        // server-side, to match whatever plan it loaded with - confirmed live
        // that they do NOT reactively re-resolve when the coordinate boxes are
        // hand-edited, they just keep showing the previous plan's name. So the
        // resolved name is only trustworthy while unedited; the moment the
        // boxes differ from what the page loaded with, treat the name as
        // unknown rather than show a stale, wrong one.
        var name = null;
        if (unedited) {
            var systemSel = document.getElementById('systemSelector');
            var planetSel = document.getElementById('planetSelector');
            var systemName = systemSel && systemSel.selectedIndex >= 0 ? systemSel.options[systemSel.selectedIndex].text : '';
            var planetName = planetSel && planetSel.selectedIndex >= 0 ? planetSel.options[planetSel.selectedIndex].text : '';
            if (systemName && systemName.indexOf('--') === -1) {
                name = (planetName && planetName.indexOf('--') === -1) ? (systemName + ' – ' + planetName) : systemName;
            }
        }

        return { galX: galX, galY: galY, sysX: sysX, sysY: sysY, name: name };
    }

    function detectCurrent() {
        return detectSystemPageLocation() || detectTravelPlannerLocation();
    }

    // Derived rather than stored, so bookmarks saved by earlier versions (plain
    // {id, name, ...}, no coordinates) still get a stable identity and keep
    // working - they just fall back to linking their old system-page URL.
    function bookmarkKey(bm) {
        if (bm.galX != null) return 'c:' + bm.galX + ',' + bm.galY + ',' + (bm.sysX || '0') + ',' + (bm.sysY || '0');
        return 'sys:' + bm.id;
    }

    function bookmarkLabel(bm) {
        // No name doesn't always mean deep space - it can also mean the
        // coordinates were hand-edited and never re-verified (see
        // detectTravelPlannerLocation), so this stays a neutral coordinate
        // label rather than asserting "Deep Space" for something we're not
        // actually sure about.
        if (bm.galX != null) return bm.name || '(' + bm.galX + ', ' + bm.galY + ')';
        return bm.name;
    }

    function bookmarkUrl(bm) {
        if (bm.galX != null) {
            return location.origin + '/members/cockpit/travel/directed.php?travelClass=2&supplied=1&galX=' +
                encodeURIComponent(bm.galX) + '&galY=' + encodeURIComponent(bm.galY) +
                '&sysX=' + encodeURIComponent(bm.sysX || '0') + '&sysY=' + encodeURIComponent(bm.sysY || '0');
        }
        return location.origin + '/rules/?Galaxy_Map=&systemID=' + encodeURIComponent(bm.id);
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
        '#swc-bm-xp { padding: 10px 12px; border-top: 1px solid #3a3f4b; display: flex; flex-direction: column; gap: 4px; }',
        '.swc-bm-row { display: flex; align-items: center; gap: 6px; }',
        '.swc-bm-row .swc-bm-hint { flex: 1; }',
        '.swc-bm-xp-header { font-weight: bold; color: #f2c94c; }',
    ].join('\n'));

    // ---------- rendering ----------

    var panel, list, currentBox, toggleBtn, xpBox;

    function render() {
        renderCurrent();
        renderList();
        renderXP();
    }

    function renderXP() {
        xpBox.innerHTML = '';

        var headerRow = document.createElement('div');
        headerRow.className = 'swc-bm-row';

        var header = document.createElement('div');
        header.className = 'swc-bm-xp-header';
        header.textContent = 'XP Tracker';
        headerRow.appendChild(header);

        var sampleBtn = document.createElement('button');
        sampleBtn.className = 'swc-bm-btn';
        sampleBtn.textContent = 'Sample now';
        sampleBtn.addEventListener('click', function () {
            sampleBtn.disabled = true;
            fetchCurrentXP(function (info) {
                sampleBtn.disabled = false;
                if (info) {
                    recordXPReading(info);
                    GM_setValue(XP_LAST_FETCH_KEY, Date.now());
                }
                renderXP();
            });
        });
        headerRow.appendChild(sampleBtn);
        xpBox.appendChild(headerRow);

        var samples = getXPSamples();
        if (samples.length === 0) {
            var hint = document.createElement('div');
            hint.className = 'swc-bm-hint';
            hint.textContent = 'No data yet — click Sample now, or just keep playing.';
            xpBox.appendChild(hint);
            return;
        }

        var latest = samples[samples.length - 1];
        var nextRaw = GM_getValue(XP_NEXT_KEY, '');
        var next = nextRaw ? parseInt(nextRaw, 10) : null;

        var curLine = document.createElement('div');
        curLine.className = 'swc-bm-hint';
        curLine.textContent = 'XP: ' + latest.xp.toLocaleString() + (next != null ? ' / ' + next.toLocaleString() : '');
        xpBox.appendChild(curLine);

        if (samples.length < 2) {
            var hint2 = document.createElement('div');
            hint2.className = 'swc-bm-hint';
            hint2.textContent = 'Rate: gathering data…';
            xpBox.appendChild(hint2);
            return;
        }

        var oldest = samples[0];
        var hours = (latest.t - oldest.t) / 3600000;
        var rate = hours > 0 ? (latest.xp - oldest.xp) / hours : 0;

        var rateLine = document.createElement('div');
        rateLine.className = 'swc-bm-hint';
        rateLine.textContent = 'XP/hour: ~' + Math.round(rate).toLocaleString();
        xpBox.appendChild(rateLine);

        if (next != null) {
            var remaining = next - latest.xp;
            var etaLine = document.createElement('div');
            etaLine.className = 'swc-bm-hint';
            if (remaining <= 0) {
                etaLine.textContent = 'Ready to level up!';
            } else if (rate <= 0) {
                etaLine.textContent = 'Time to next level: unknown (no recent XP gain)';
            } else {
                etaLine.textContent = 'Time to next level: ~' + formatDuration(remaining / rate);
            }
            xpBox.appendChild(etaLine);
        }
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
                list.push({
                    galX: current.galX,
                    galY: current.galY,
                    sysX: current.sysX,
                    sysY: current.sysY,
                    name: current.name || null,
                    note: '',
                    addedAt: Date.now()
                });
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

        xpBox = document.createElement('div');
        xpBox.id = 'swc-bm-xp';
        panel.appendChild(xpBox);

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

        render();
        maybeSampleXP(function (sampled) {
            if (sampled) render();
        });

        // The travel planner's coordinate inputs/dropdowns change without any
        // navigation (same-page form, no URL update - see
        // detectTravelPlannerLocation), so the panel needs its own listeners to
        // stay in sync as the user edits them, rather than only detecting state
        // once at page load.
        var TRAVEL_PLANNER_FIELD_IDS = ['galX', 'galY', 'sysX', 'sysY', 'systemSelector', 'planetSelector'];
        document.addEventListener('input', function (e) {
            if (e.target && TRAVEL_PLANNER_FIELD_IDS.indexOf(e.target.id) !== -1) renderCurrent();
        });
        document.addEventListener('change', function (e) {
            if (e.target && TRAVEL_PLANNER_FIELD_IDS.indexOf(e.target.id) !== -1) renderCurrent();
        });
    }

    buildPanel();
})();
