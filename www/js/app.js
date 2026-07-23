/* app.js — UI. Ported from the original single-file reader, now reading
 * everything through ARDB (SQLite on device, in-memory in the browser). */
(function () {
    const $ = id => document.getElementById(id);

    // View state. `metaById` caches {title, provider} for every conversation
    // currently on screen so the reader can render its header without an extra
    // round-trip, regardless of whether we came from the list or from results.
    let metaById = new Map();
    let currentThread = null;   // { conv, mainNodes } for the open reader
    let backTo = null;          // re-render the view the reader was opened from

    /* ---------------- boot ---------------- */
    window.addEventListener('DOMContentLoaded', async () => {
        // The very first launch after the message_id upgrade reindexes the FTS
        // table; surface that instead of a frozen splash on a big library.
        const { native } = await ARDB.init((done, total) => {
            if (total) $('file-status').innerText =
                'Upgrading search index… ' + done + ' / ' + total;
        });
        if (!native) {
            $('file-status').innerText =
                'Browser preview mode: imports live in memory and vanish on refresh. ' +
                'On the Android app they persist in a local database.';
        }
        await refresh();
        if (metaById.size) showLibraryUi();
    });

    /* ---------------- import ---------------- */
    $('fileInput').addEventListener('change', async e => {
        const files = [...e.target.files];
        if (!files.length) return;
        let totalConvs = 0, failed = [];

        for (const file of files) {
            $('file-status').innerText = 'Reading ' + file.name + '…';
            try {
                const json = JSON.parse(await file.text());
                const result = ARImportRegistry.detectAndNormalize(json);
                if (!result) { failed.push(file.name + ' (format not recognized)'); continue; }
                const { added } = await ARDB.importConversations(
                    result.conversations,
                    (done, total) => {
                        $('file-status').innerText =
                            'Importing ' + file.name + '… ' + done + ' / ' + total;
                    });
                totalConvs += added;
            } catch (err) {
                console.error(err);
                const why = err && err.message ? String(err.message).slice(0, 120) : 'unknown error';
                failed.push(file.name + ' (' + why + ')');
            }
        }

        let status = totalConvs
            ? 'Imported ' + totalConvs + ' conversation' + (totalConvs === 1 ? '' : 's') + '.'
            : '';
        if (failed.length) {
            status += ' ⚠️ Could not read: ' + failed.join(', ') +
                      '. Expected conversations.json from a Claude or ChatGPT export.';
        }
        $('file-status').innerText = status.trim() || 'Nothing imported.';
        e.target.value = ''; // allow re-selecting the same file
        await refresh();
        if (metaById.size) showLibraryUi();
    });

    function showLibraryUi() {
        $('search').style.display = 'block';
        $('toolbar').style.display = 'flex';
        $('filterBar').style.display = 'flex';
    }

    $('clearBtn').addEventListener('click', async () => {
        if (!confirm('Delete every imported conversation from this device?')) return;
        await ARDB.clearAll();
        $('search').value = '';
        await refresh();
    });

    /* ---------------- search dispatch ---------------- */
    // Three modes:
    //   • empty query            → browse the conversation list
    //   • query, bodies off      → title-only search (conversation rows)
    //   • query, bodies on       → per-message search, grouped by conversation
    async function refresh() {
        const q = ($('search').value || '').trim();
        const deep = $('searchBodies').checked;
        if (q && deep) {
            const hits = await ARDB.searchMessages(q, currentFilters());
            renderResults(hits, q);
        } else {
            const convs = q ? await ARDB.searchConversations(q, false)
                            : await ARDB.listConversations();
            renderList(convs, q);
        }
    }

    function currentFilters() {
        const f = {};
        const p = $('filterProvider').value; if (p) f.provider = p;
        const s = $('filterSender').value;   if (s) f.sender = s;
        const d = $('filterDate').value;
        if (d === 'month') f.since = Date.now() - 30 * 864e5;
        else if (d === 'year') f.since = Date.now() - 365 * 864e5;
        return f;
    }

    let searchTimer = null;
    const queueSearch = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refresh, 200); // debounce keystrokes
    };
    $('search').addEventListener('input', queueSearch);
    $('searchBodies').addEventListener('change', refresh);
    ['filterProvider', 'filterSender', 'filterDate'].forEach(id =>
        $(id).addEventListener('change', refresh));

    const PROVIDER_LABEL = { claude: '🤖 Claude', chatgpt: '💬 ChatGPT' };
    const providerBadge = p =>
        '<span class="badge provider-' + escapeHtml(p) + '">' +
        (PROVIDER_LABEL[p] || escapeHtml(p)) + '</span>';

    /* ---------------- conversation list ---------------- */
    function renderList(convList, q) {
        metaById = new Map(convList.map(c => [c.id, c]));
        $('readerView').style.display = 'none';
        const list = $('listView');
        list.style.display = 'block';
        list.innerHTML = '';

        convList.forEach(c => {
            const item = document.createElement('div');
            item.className = 'chat-item';
            item.onclick = () => { backTo = () => renderList(convList, q); openReader(c.id); };
            item.innerHTML =
                '<h3>' + escapeHtml(c.title) + '</h3>' +
                '<div class="chat-meta">' +
                    providerBadge(c.provider) +
                    (c.updated_at ? '<span>🗓 ' + new Date(c.updated_at).toLocaleDateString() + '</span>' : '') +
                    '<span>💬 ' + c.msg_count + ' messages</span>' +
                    (c.edit_count ? '<span class="badge">📜 ' + c.edit_count + ' past edit' +
                        (c.edit_count === 1 ? '' : 's') + '</span>' : '') +
                '</div>' +
                (c.snippet ? '<div class="snippet">' + snippetHtml(c.snippet) + '</div>' : '');
            list.appendChild(item);
        });

        $('countLabel').innerText = q
            ? convList.length + ' match' + (convList.length === 1 ? '' : 'es')
            : convList.length + ' conversation' + (convList.length === 1 ? '' : 's');
    }

    /* ---------------- message search results ---------------- */
    // hits arrive ordered by conversation recency then FTS rank, so a simple
    // sequential group-by keeps each conversation's hits contiguous.
    function renderResults(hits, q) {
        metaById = new Map(hits.map(h => [h.conversation_id, { title: h.title, provider: h.provider }]));
        $('readerView').style.display = 'none';
        const list = $('listView');
        list.style.display = 'block';
        list.innerHTML = '';

        const groups = [];
        const byId = new Map();
        hits.forEach(h => {
            let g = byId.get(h.conversation_id);
            if (!g) { g = { id: h.conversation_id, title: h.title, provider: h.provider, hits: [] };
                      byId.set(h.conversation_id, g); groups.push(g); }
            g.hits.push(h);
        });

        if (!groups.length) {
            list.innerHTML = '<p class="empty">No messages match.</p>';
            $('countLabel').innerText = '0 matches';
            return;
        }

        const SHOWN = 3;
        groups.forEach(g => {
            const card = document.createElement('div');
            card.className = 'result-group';
            let html = '<div class="result-header">' + escapeHtml(g.title) + ' ' +
                       providerBadge(g.provider) +
                       '<span class="count">' + g.hits.length + ' hit' +
                       (g.hits.length === 1 ? '' : 's') + '</span></div>';
            html += g.hits.slice(0, SHOWN).map(h =>
                '<div class="result-line" data-msg="' + escapeHtml(h.message_id) + '">' +
                    '<span class="result-meta">' +
                        (h.role === 'human' ? '👤' : '🤖') +
                        (h.created_at ? ' ' + new Date(h.created_at).toLocaleDateString() : '') +
                    '</span> ' +
                    '<span class="result-snip">' + snippetHtml(h.snippet) + '</span>' +
                '</div>').join('');
            if (g.hits.length > SHOWN)
                html += '<div class="result-more" data-msg="' + escapeHtml(g.hits[SHOWN].message_id) + '">' +
                        '+ ' + (g.hits.length - SHOWN) + ' more…</div>';
            card.innerHTML = html;

            card.querySelectorAll('[data-msg]').forEach(el => {
                el.onclick = () => {
                    backTo = () => renderResults(hits, q);
                    openReader(g.id, el.getAttribute('data-msg'), q);
                };
            });
            list.appendChild(card);
        });

        const total = hits.length;
        $('countLabel').innerText = total + ' match' + (total === 1 ? '' : 'es') +
            ' in ' + groups.length + ' conversation' + (groups.length === 1 ? '' : 's');
    }

    // FTS / memory snippets arrive with … sentinel markers;
    // escape the text first, then swap the sentinels for <b> tags.
    function snippetHtml(s) {
        const B = String.fromCharCode(1), E = String.fromCharCode(2);
        return escapeHtml(s)
            .replace(new RegExp(B, 'g'), '<b>').replace(new RegExp(E, 'g'), '</b>');
    }

    /* ---------------- reader ---------------- */
    // targetMsgId / query are optional: set when opening from a search hit so
    // we can jump to and highlight the match.
    async function openReader(convId, targetMsgId, query) {
        const conv = Object.assign({ id: convId }, metaById.get(convId) || {});
        const messages = await ARDB.getMessages(convId);
        const { mainNodes } = ARTree.buildThread(messages);
        currentThread = { conv, mainNodes };

        $('listView').style.display = 'none';
        const view = $('readerView');
        view.style.display = 'block';

        let html =
            '<div class="reader-bar">' +
                '<button class="sm-btn" id="backBtn">← Back</button>' +
                '<h3>' + escapeHtml(conv.title || 'Conversation') + '</h3>' +
                '<span class="match-nav" id="matchNav" style="display:none;">' +
                    '<button class="sm-btn" id="prevMatch">↑</button>' +
                    '<span class="match-count" id="matchCount"></span>' +
                    '<button class="sm-btn" id="nextMatch">↓</button>' +
                '</span>' +
                '<button class="sm-btn" id="mdBtn">📥 .md</button>' +
            '</div>';

        mainNodes.forEach(node => {
            if (node.pastEdits.length) {
                html += '<details class="edits"><summary>📜 ' + node.pastEdits.length +
                        ' past version' + (node.pastEdits.length === 1 ? '' : 's') +
                        ' of the next message</summary>';
                node.pastEdits.forEach((branch, v) => {
                    html += '<div style="margin-top:0.6rem;"><div class="ts">Version ' + (v + 1) + '</div>';
                    branch.forEach(m => { html += renderMsg(m); });
                    html += '</div>';
                });
                html += '</details>';
            }
            html += renderMsg(node.msg);
        });

        view.innerHTML = html;
        $('backBtn').onclick = () => { if (backTo) backTo(); else refresh(); };
        $('mdBtn').onclick = downloadMd;

        const terms = queryTerms(query);
        const matches = terms.length ? highlightMatches(view, terms) : [];
        setupMatchNav(matches, targetMsgId, view);
    }

    function renderMsg(msg) {
        const user = msg.role === 'human';
        const ts = msg.created_at ? new Date(msg.created_at).toLocaleString() : '';
        let html = '<div class="msg ' + (user ? 'user' : 'assistant') +
            '" data-msg-id="' + escapeHtml(msg.id) + '">' +
            '<div class="sender">' + (user ? '👤 Human' : '🤖 Assistant') +
            (ts ? '<span class="ts">' + ts + '</span>' : '') + '</div>' +
            '<div class="content-body">' + contentToHtml(msg) + '</div>';
        if (msg.attachments && msg.attachments.length) {
            html += '<div class="attach">📎 ' +
                msg.attachments.map(escapeHtml).join(', ') + '</div>';
        }
        return html + '</div>';
    }

    /* ---------------- search-hit highlighting ---------------- */
    // Split the raw query into lowercased terms for substring highlighting.
    function queryTerms(query) {
        return (query || '').toLowerCase().split(/\s+/).filter(Boolean);
    }
    const escapeRegex = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Wrap every occurrence of any term in <mark>, operating on the already
    // rendered DOM text nodes — never on HTML strings — so this can NEVER
    // reintroduce markup from user text. Returns the marks in document order.
    function highlightMatches(root, terms) {
        const re = new RegExp('(' + terms.map(escapeRegex).join('|') + ')', 'gi');
        const marks = [];
        root.querySelectorAll('.content-body').forEach(body => {
            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
            const textNodes = [];
            for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                if (n.nodeValue && n.nodeValue.trim()) textNodes.push(n);
            }
            textNodes.forEach(node => {
                const text = node.nodeValue;
                re.lastIndex = 0;
                if (!re.test(text)) return;
                re.lastIndex = 0;
                const frag = document.createDocumentFragment();
                let last = 0, m;
                while ((m = re.exec(text))) {
                    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
                    const mark = document.createElement('mark');
                    mark.className = 'hit';
                    mark.textContent = m[0];
                    frag.appendChild(mark);
                    marks.push(mark);
                    last = m.index + m[0].length;
                    if (m[0].length === 0) re.lastIndex++; // guard against zero-width
                }
                if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
                node.parentNode.replaceChild(frag, node);
            });
        });
        return marks;
    }

    function setupMatchNav(matches, targetMsgId, view) {
        // Locate the message we were asked to land on; if it sits inside a
        // collapsed edit branch, open it and explain why the hit wasn't in
        // the main thread.
        let targetEl = null;
        if (targetMsgId) {
            targetEl = [...view.querySelectorAll('.msg')].find(el => el.dataset.msgId === targetMsgId);
            if (targetEl) {
                const details = targetEl.closest('details.edits');
                if (details) {
                    details.open = true;
                    targetEl.insertAdjacentHTML('afterbegin',
                        '<div class="edit-note">🔀 found in an earlier version of this message</div>');
                }
            }
        }

        const nav = $('matchNav');
        if (!matches.length) {
            // Nothing to highlight (e.g. opened from the list). Still honor a
            // scroll target if we have one.
            if (targetEl) targetEl.scrollIntoView({ block: 'center' });
            else window.scrollTo(0, 0);
            return;
        }

        // Start on the first match inside the target message, else the first
        // match overall.
        let cur = 0;
        if (targetEl) {
            const idx = matches.findIndex(mk => targetEl.contains(mk));
            if (idx >= 0) cur = idx;
        }

        const count = $('matchCount');
        const setCurrent = i => {
            matches.forEach(mk => mk.classList.remove('current'));
            cur = (i + matches.length) % matches.length;
            const mk = matches[cur];
            mk.classList.add('current');
            count.innerText = (cur + 1) + ' of ' + matches.length;
            mk.scrollIntoView({ block: 'center' });
        };
        $('prevMatch').onclick = () => setCurrent(cur - 1);
        $('nextMatch').onclick = () => setCurrent(cur + 1);
        nav.style.display = 'inline-flex';
        setCurrent(cur);
    }

    function contentToHtml(msg) {
        if (msg.blocks) {
            const parts = msg.blocks.map(b => {
                if (b.type === 'thinking')
                    return '<details><summary>🧠 Thinking</summary><pre>' +
                           escapeHtml(b.thinking || '') + '</pre></details>';
                if (b.type === 'text') return textToHtml(b.text || '');
                if (b.type === 'tool_use' || b.type === 'tool_result')
                    return '<details><summary>🔧 ' + escapeHtml(b.name || b.type) + '</summary><pre>' +
                           escapeHtml(JSON.stringify(b.input || b.content || b, null, 2)) + '</pre></details>';
                return '<details><summary>📦 ' + escapeHtml(b.type || 'block') + '</summary><pre>' +
                       escapeHtml(JSON.stringify(b, null, 2)) + '</pre></details>';
            }).filter(Boolean);
            if (parts.length) return parts.join('');
        }
        return msg.text && msg.text.trim()
            ? textToHtml(msg.text)
            : '<span class="empty">(empty message)</span>';
    }

    // Escapes everything, then renders ``` fences as <pre> and newlines as <br>.
    function textToHtml(str) {
        const esc = escapeHtml(str || '');
        const withCode = esc.replace(/```([\s\S]*?)```/g, (m, code) =>
            '<pre>' + code.replace(/^\w*\n/, '') + '</pre>');
        return withCode.split(/(<pre>[\s\S]*?<\/pre>)/).map(seg =>
            seg.startsWith('<pre>') ? seg : seg.replace(/\n/g, '<br>')).join('');
    }

    function escapeHtml(str) {
        return str ? String(str)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;') : '';
    }

    /* ---------------- markdown export ---------------- */
    function downloadMd() {
        const { conv, mainNodes } = currentThread;

        // Escape raw HTML outside code fences so a malicious message can't
        // execute in an HTML-rendering markdown viewer.
        const escapeOutsideFences = s => (s || '').split(/(```[\s\S]*?```)/).map(seg =>
            seg.startsWith('```') ? seg : seg.replace(/&/g, '&amp;').replace(/</g, '&lt;')).join('');

        // Fence longer than any backtick run in the content, so content can
        // never close the fence early.
        const fenceFor = s => '`'.repeat(
            ((s || '').match(/`+/g) || []).reduce((n, r) => Math.max(n, r.length), 2) + 1);

        const msgToMd = m => {
            let text = '';
            if (m.blocks) {
                text = m.blocks.map(b => {
                    if (b.type === 'thinking') {
                        const t = b.thinking || '';
                        const f = fenceFor(t);
                        return '<details>\n<summary>🧠 Thinking</summary>\n\n' +
                               f + 'text\n' + t + '\n' + f + '\n\n</details>';
                    }
                    if (b.type === 'text') return escapeOutsideFences(b.text || '');
                    return '';
                }).filter(Boolean).join('\n\n');
            } else {
                text = escapeOutsideFences(m.text);
            }
            return (m.role === 'human' ? '### 👤 Human' : '### 🤖 Assistant') +
                   '\n\n' + text + '\n\n';
        };

        let md = '# ' + escapeOutsideFences(conv.title) + '\n\n---\n\n';
        mainNodes.forEach(node => {
            node.pastEdits.forEach((branch, v) => {
                md += '<details>\n<summary>📜 Past version ' + (v + 1) +
                      ' of the next message</summary>\n\n' +
                      branch.map(msgToMd).join('') + '</details>\n\n';
            });
            md += msgToMd(node.msg) + '---\n\n';
        });

        const blob = new Blob([md], { type: 'text/markdown' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (conv.title.replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')
                      || 'conversation') + '.md';
        a.click();
        URL.revokeObjectURL(a.href);
    }
})();
