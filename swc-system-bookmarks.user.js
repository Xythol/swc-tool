// ==UserScript==
// @name         SWC Space System Bookmarks
// @namespace    https://github.com/swc-tool
// @version      1.1.0
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
        '#swc-bm-oauth {',
        '  padding: 10px 12px; border-bottom: 1px solid #3a3f4b;',
        '  display: flex; align-items: center; justify-content: space-between; gap: 8px;',
        '}',
        '#swc-bm-oauth .swc-bm-hint { flex: 1; }',
    ].join('\n'));

    // ---------- rendering ----------

    var panel, list, currentBox, toggleBtn, oauthBox;

    function render() {
        renderCurrent();
        renderList();
        renderOAuth();
    }

    function renderOAuth() {
        oauthBox.innerHTML = '';

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

        oauthBox.appendChild(hint);
        oauthBox.appendChild(btn);
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
