// ==UserScript==
// @name         SWC Space System Bookmarks
// @namespace    https://github.com/swc-tool
// @version      1.2.2
// @description  Bookmark space systems in Star Wars Combine and jump back to them with one click.
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
    var OAUTH_TOKEN_KEY = 'swc_oauth_token';

    var OAUTH_CLIENT_ID = 'fccda0a63979711c8d1138da34ac30b38576be36';
    var OAUTH_REDIRECT_URI = 'https://xythol.github.io/swc-tool/oauth-callback.html';
    var OAUTH_SCOPES = ['personal_inv_overview', 'personal_inv_npcs_read', 'personal_inv_droids_read'];

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

    // ---------- OAuth ----------

    function getOAuthToken() {
        var raw = GM_getValue(OAUTH_TOKEN_KEY, '');
        if (!raw) return null;
        try {
            var token = JSON.parse(raw);
            if (!token || !token.access_token || !token.expires_at) return null;
            if (Date.now() >= token.expires_at) return null;
            return token;
        } catch (e) {
            return null;
        }
    }

    function saveOAuthToken(accessToken, expiresIn) {
        var ttlMs = (expiresIn ? expiresIn * 1000 : 60 * 60 * 1000) - 30000;
        var token = { access_token: accessToken, expires_at: Date.now() + Math.max(ttlMs, 0) };
        GM_setValue(OAUTH_TOKEN_KEY, JSON.stringify(token));
    }

    function clearOAuthToken() {
        GM_setValue(OAUTH_TOKEN_KEY, '');
    }

    function connectOAuth(onDone) {
        var authUrl = 'https://www.swcombine.com/ws/oauth2/auth/?' +
            'response_type=token' +
            '&client_id=' + encodeURIComponent(OAUTH_CLIENT_ID) +
            '&redirect_uri=' + encodeURIComponent(OAUTH_REDIRECT_URI) +
            '&scope=' + encodeURIComponent(OAUTH_SCOPES.join(' '));

        var popup = window.open(authUrl, 'swc_oauth_popup', 'width=600,height=700');
        if (!popup) {
            onDone(false, 'popup_blocked');
            return;
        }

        var settled = false;

        function finish(success, error) {
            if (settled) return;
            settled = true;
            window.removeEventListener('message', onMessage);
            clearInterval(closeCheck);
            onDone(success, error || null);
        }

        function onMessage(event) {
            if (event.source !== popup) return;
            var data = event.data;
            if (!data || data.source !== 'swc-tool-oauth') return;
            if (data.error) {
                finish(false, data.error);
                return;
            }
            saveOAuthToken(data.access_token, data.expires_in);
            finish(true, null);
        }
        window.addEventListener('message', onMessage);

        var closeCheck = setInterval(function () {
            if (popup.closed) finish(false, 'closed');
        }, 500);
    }

    // ---------- NPC roster ----------

    var ROSTER_KEY = 'swc_npc_roster';

    function getCharacterHandle() {
        var el = document.getElementById('alertbarhandle');
        return el ? el.textContent.trim() : null;
    }

    function saveRoster(entities) {
        GM_setValue(ROSTER_KEY, JSON.stringify({ fetchedAt: Date.now(), entities: entities }));
    }

    function getRoster() {
        var raw = GM_getValue(ROSTER_KEY, '');
        if (!raw) return null;
        try {
            return JSON.parse(raw);
        } catch (e) {
            return null;
        }
    }

    function apiGet(url, token, onDone) {
        console.log('[SWC Tool] GET', url);
        fetch(url, {
            headers: { Authorization: 'OAuth ' + token },
            credentials: 'include'
        }).then(function (response) {
            return response.text().then(function (text) {
                console.log('[SWC Tool] response', response.status, url, '\n', text.slice(0, 500));
                if (response.status >= 200 && response.status < 300) {
                    onDone(null, text);
                } else {
                    onDone({ status: response.status }, null);
                }
            });
        }).catch(function (err) {
            console.error('[SWC Tool] fetch error', url, err);
            onDone({ status: 0 }, null);
        });
    }

    function parseEntities(xmlText, kind) {
        var doc = new DOMParser().parseFromString(xmlText, 'application/xml');
        return Array.from(doc.querySelectorAll('entity')).map(function (e) {
            function text(sel) {
                var el = e.querySelector(sel);
                return el ? el.textContent : '';
            }
            var container = e.querySelector('location > container');
            var hpEl = e.querySelector('hp');
            var hullEl = e.querySelector('hull');
            var typeEl = e.querySelector('type');
            var wreckedEl = e.querySelector('wrecked');
            return {
                kind: kind,
                uid: text('uid'),
                name: text('name'),
                roleType: typeEl ? typeEl.textContent : '',
                level: text('level'),
                location: container ? container.textContent : '',
                hpCurrent: hpEl ? hpEl.textContent : (hullEl ? hullEl.textContent : null),
                hpMax: hpEl ? hpEl.getAttribute('max') : (hullEl ? hullEl.getAttribute('max') : null),
                wrecked: wreckedEl ? wreckedEl.textContent === 'yes' : false
            };
        });
    }

    function fetchRoster(onDone) {
        var token = getOAuthToken();
        if (!token) {
            console.warn('[SWC Tool] fetchRoster: not connected');
            onDone('not_connected');
            return;
        }

        var handle = getCharacterHandle();
        if (!handle) {
            console.warn('[SWC Tool] fetchRoster: could not find #alertbarhandle on this page');
            onDone('no_handle');
            return;
        }
        console.log('[SWC Tool] fetchRoster: handle =', handle);

        var invUrl = 'https://www.swcombine.com/ws/v2.0/inventory/' + encodeURIComponent(handle) + '/';
        apiGet(invUrl, token.access_token, function (err, text) {
            if (err) {
                console.error('[SWC Tool] fetchRoster: inventory list request failed', err);
                if (err.status === 401 || err.status === 403) clearOAuthToken();
                onDone('fetch_failed');
                return;
            }

            var doc = new DOMParser().parseFromString(text, 'application/xml');
            var npcOwner = doc.querySelector('inventory[type="npc"] > owner');
            var droidOwner = doc.querySelector('inventory[type="droid"] > owner');
            console.log('[SWC Tool] fetchRoster: npcOwner href =', npcOwner && npcOwner.getAttribute('href'), 'droidOwner href =', droidOwner && droidOwner.getAttribute('href'));

            if (!npcOwner && !droidOwner) {
                console.warn('[SWC Tool] fetchRoster: no npc/droid inventory role found in response');
                onDone('no_npc_or_droid');
                return;
            }

            var results = [];
            var pending = 0;
            var hadError = false;

            function maybeFinish() {
                pending--;
                if (pending > 0) return;
                if (hadError) {
                    onDone('fetch_failed');
                    return;
                }
                saveRoster(results);
                onDone(null, results);
            }

            if (npcOwner) {
                pending++;
                apiGet(npcOwner.getAttribute('href'), token.access_token, function (err2, text2) {
                    if (err2) {
                        hadError = true;
                    } else {
                        results = results.concat(parseEntities(text2, 'npc'));
                    }
                    maybeFinish();
                });
            }
            if (droidOwner) {
                pending++;
                apiGet(droidOwner.getAttribute('href'), token.access_token, function (err2, text2) {
                    if (err2) {
                        hadError = true;
                    } else {
                        results = results.concat(parseEntities(text2, 'droid'));
                    }
                    maybeFinish();
                });
            }
        });
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
        '#swc-bm-list, #swc-bm-roster-list { list-style: none; margin: 0; padding: 0; }',
        '#swc-bm-list li, #swc-bm-roster-list li {',
        '  padding: 8px 12px; border-bottom: 1px solid #2a2e37; display: flex; flex-direction: column; gap: 4px;',
        '}',
        '#swc-bm-list li:last-child, #swc-bm-roster-list li:last-child { border-bottom: none; }',
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
        '#swc-bm-oauth {',
        '  padding: 10px 12px; border-bottom: 1px solid #3a3f4b;',
        '  display: flex; flex-direction: column; gap: 6px;',
        '}',
        '.swc-bm-oauth-row {',
        '  display: flex; align-items: center; gap: 6px;',
        '}',
        '.swc-bm-oauth-row .swc-bm-hint { flex: 1; }',
        '#swc-bm-roster { padding-bottom: 4px; }',
        '#swc-bm-roster .swc-bm-oauth-row { padding: 10px 12px 6px; }',
        '.swc-bm-roster-name { font-weight: bold; }',
        '.swc-bm-oauth-row input.swc-bm-note { flex: 1; }',
    ].join('\n'));

    // ---------- rendering ----------

    var panel, list, currentBox, toggleBtn, oauthBox, rosterBox;

    function render() {
        renderCurrent();
        renderList();
        renderOAuth();
        renderRoster();
    }

    function renderRoster() {
        rosterBox.innerHTML = '';

        var token = getOAuthToken();
        var cached = getRoster();

        var header = document.createElement('div');
        header.className = 'swc-bm-oauth-row';

        var title = document.createElement('div');
        title.className = 'swc-bm-hint';
        title.textContent = 'NPC Roster' + (cached ? ' (' + cached.entities.length + ')' : '');
        header.appendChild(title);

        if (token) {
            var refreshBtn = document.createElement('button');
            refreshBtn.className = 'swc-bm-btn';
            refreshBtn.textContent = 'Refresh';
            refreshBtn.addEventListener('click', function () {
                refreshBtn.disabled = true;
                refreshBtn.textContent = 'Loading…';
                fetchRoster(function (err) {
                    if (err) {
                        title.textContent = 'NPC Roster: error (' + err + ')';
                        refreshBtn.disabled = false;
                        refreshBtn.textContent = 'Refresh';
                        return;
                    }
                    renderRoster();
                });
            });
            header.appendChild(refreshBtn);
        }

        rosterBox.appendChild(header);

        if (!token) {
            var hint = document.createElement('div');
            hint.className = 'swc-bm-empty';
            hint.textContent = 'Connect above to load your NPCs and droids.';
            rosterBox.appendChild(hint);
            return;
        }

        if (!cached || cached.entities.length === 0) {
            var empty = document.createElement('div');
            empty.className = 'swc-bm-empty';
            empty.textContent = 'No data yet — click Refresh.';
            rosterBox.appendChild(empty);
            return;
        }

        var ul = document.createElement('ul');
        ul.id = 'swc-bm-roster-list';
        cached.entities.forEach(function (ent) {
            var li = document.createElement('li');

            var top = document.createElement('div');
            top.className = 'swc-bm-row-top';

            var name = document.createElement('span');
            name.className = 'swc-bm-roster-name';
            name.textContent = (ent.kind === 'droid' ? '⚙ ' : '') + ent.name;
            top.appendChild(name);

            var hp = document.createElement('span');
            hp.className = 'swc-bm-hint';
            hp.textContent = ent.wrecked ? 'wrecked' : (ent.hpCurrent + '/' + ent.hpMax + ' HP');
            top.appendChild(hp);

            li.appendChild(top);

            var sub = document.createElement('div');
            sub.className = 'swc-bm-hint';
            sub.textContent = (ent.roleType ? ent.roleType + ' · ' : '') + (ent.location || 'unknown location');
            li.appendChild(sub);

            ul.appendChild(li);
        });
        rosterBox.appendChild(ul);
    }

    function renderOAuth() {
        oauthBox.innerHTML = '';

        var statusRow = document.createElement('div');
        statusRow.className = 'swc-bm-oauth-row';

        var hint = document.createElement('div');
        hint.className = 'swc-bm-hint';

        var btn = document.createElement('button');
        btn.className = 'swc-bm-btn';

        var token = getOAuthToken();
        if (token) {
            var minsLeft = Math.max(0, Math.round((token.expires_at - Date.now()) / 60000));
            hint.textContent = 'NPC Roster: connected (~' + minsLeft + 'm left)';
            btn.textContent = 'Disconnect';
            btn.addEventListener('click', function () {
                clearOAuthToken();
                renderOAuth();
            });
        } else {
            hint.textContent = 'NPC Roster: not connected';
            btn.textContent = 'Connect';
            btn.addEventListener('click', function () {
                btn.disabled = true;
                btn.textContent = 'Waiting…';
                connectOAuth(function (success, error) {
                    if (!success && error && error !== 'closed') {
                        hint.textContent = 'NPC Roster: connection failed (' + error + ')';
                    }
                    renderOAuth();
                });
            });
        }

        statusRow.appendChild(hint);
        statusRow.appendChild(btn);
        oauthBox.appendChild(statusRow);

        var pasteRow = document.createElement('div');
        pasteRow.className = 'swc-bm-oauth-row';

        var pasteInput = document.createElement('input');
        pasteInput.type = 'text';
        pasteInput.className = 'swc-bm-note';
        pasteInput.placeholder = 'Or paste a Test Token…';

        var useBtn = document.createElement('button');
        useBtn.className = 'swc-bm-btn';
        useBtn.textContent = 'Use';
        useBtn.addEventListener('click', function () {
            var value = pasteInput.value.trim();
            if (!value) return;
            saveOAuthToken(value, 60 * 60); // Test Tokens always last 1 hour
            renderOAuth();
        });

        pasteRow.appendChild(pasteInput);
        pasteRow.appendChild(useBtn);
        oauthBox.appendChild(pasteRow);
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

        oauthBox = document.createElement('div');
        oauthBox.id = 'swc-bm-oauth';
        panel.appendChild(oauthBox);

        rosterBox = document.createElement('div');
        rosterBox.id = 'swc-bm-roster';
        panel.appendChild(rosterBox);

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
    }

    buildPanel();
})();
