// ==UserScript==
// @name         SWC Space System Bookmarks
// @namespace    https://github.com/swc-tool
// @version      1.3.0
// @description  Bookmark space systems in Star Wars Combine and track XP/hour + time to next level.
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

    // ---------- current system detection ----------

    function detectCurrentSystem() {
        var params = new URLSearchParams(location.search);
        if (!params.has('Galaxy_Map')) return null;

        var id = params.get('systemID');
        if (!id || !/^\d+$/.test(id)) return null;

        var match = document.title.match(/^::System:\s*(.+?)\s*-\s*Star Wars Combine::$/);
        if (!match) return null;

        return { id: id, name: match[1] };
    }

    function systemUrl(id) {
        return location.origin + '/rules/?Galaxy_Map=&systemID=' + encodeURIComponent(id);
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
        var current = detectCurrentSystem();

        if (!current) {
            var hint = document.createElement('div');
            hint.className = 'swc-bm-hint';
            hint.textContent = 'Not viewing a system page.';
            currentBox.appendChild(hint);
            return;
        }

        var nameEl = document.createElement('span');
        nameEl.className = 'swc-bm-name';
        nameEl.textContent = current.name;
        currentBox.appendChild(nameEl);

        var bookmarks = getBookmarks();
        var already = bookmarks.some(function (b) { return b.id === current.id; });

        var btn = document.createElement('button');
        btn.className = 'swc-bm-btn';
        if (already) {
            btn.textContent = 'Saved ✓';
            btn.disabled = true;
        } else {
            btn.textContent = '★ Save this system';
            btn.addEventListener('click', function () {
                var list = getBookmarks();
                list.push({ id: current.id, name: current.name, note: '', addedAt: Date.now() });
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
            empty.textContent = 'No saved systems yet.';
            list.appendChild(empty);
            return;
        }

        bookmarks
            .slice()
            .sort(function (a, b) { return a.name.localeCompare(b.name); })
            .forEach(function (bm) {
                var li = document.createElement('li');

                var top = document.createElement('div');
                top.className = 'swc-bm-row-top';

                var link = document.createElement('a');
                link.className = 'swc-bm-link';
                link.href = systemUrl(bm.id);
                link.textContent = bm.name;
                top.appendChild(link);

                var remove = document.createElement('button');
                remove.className = 'swc-bm-remove';
                remove.textContent = '×';
                remove.title = 'Remove bookmark';
                remove.addEventListener('click', function () {
                    var updated = getBookmarks().filter(function (b) { return b.id !== bm.id; });
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
                    var target = updated.find(function (b) { return b.id === bm.id; });
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
        toggleBtn.textContent = '★ Systems';
        document.body.appendChild(toggleBtn);

        panel = document.createElement('div');
        panel.id = 'swc-bm-panel';

        var header = document.createElement('div');
        header.id = 'swc-bm-header';
        header.innerHTML = '<span>★ My Systems</span>';
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
    }

    buildPanel();
})();
