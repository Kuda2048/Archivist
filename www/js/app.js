/* app.js — UI. Ported from the original single-file reader, now reading
 * everything through ARDB (SQLite on device, in-memory in the browser). */
(function () {
    const $ = id => document.getElementById(id);
    let convList = [];        // what the list view currently shows
    let currentThread = null; // { conv, mainNodes } for the open reader

    /* ---------------- boot ---------------- */
    window.addEventListener('DOMContentLoaded', async () => {
        const { native } = await ARDB.init();
        if (!native) {
            $('file-status').innerText =
                'Browser preview mode: imports live in memory and vanish on refresh. ' +
                'On the Android app they persist in a local database.';
        }
        await refreshList();
        if (convList.length) showLibraryUi();
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
        await refreshList();
        if (convList.length) showLibraryUi();
    });

    function showLibraryUi() {
        $('search').style.display = 'block';
        $('toolbar').style.display = 'flex';
    }

    $('clearBtn').addEventListener('click', async () => {
        if (!confirm('Delete every imported conversation from this device?')) return;
        await ARDB.clearAll();
        $('search').value = '';
        await refreshList();
    });

    /* ---------------- list + search ---------------- */
    async function refreshList() {
        const q = ($('search').value || '').trim();
        const deep = $('searchBodies').checked;
        convList = q ? await ARDB.searchConversations(q, deep)
                     : await ARDB.listConversations();
        renderList(q);
    }

    let searchTimer = null;
    const queueSearch = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refreshList, 200); // debounce keystrokes
    };
    $('search').addEventListener('input', queueSearch);
    $('searchBodies').addEventListener('change', refreshList);

    const PROVIDER_LABEL = { claude: '🤖 Claude', chatgpt: '💬 ChatGPT' };

    function renderList(q) {
        $('readerView').style.display = 'none';
        const list = $('listView');
        list.style.display = 'block';
        list.innerHTML = '';

        convList.forEach((c, i) => {
            const item = document.createElement('div');
            item.className = 'chat-item';
            item.onclick = () => openReader(i);
            item.innerHTML =
                '<h3>' + escapeHtml(c.title) + '</h3>' +
                '<div class="chat-meta">' +
                    '<span class="badge provider-' + escapeHtml(c.provider) + '">' +
                        (PROVIDER_LABEL[c.provider] || escapeHtml(c.provider)) + '</span>' +
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

    // FTS snippets arrive with \u0001…\u0002 sentinel markers (set in db.js);
    // escape the text first, then swap the sentinels for <b> tags.
    function snippetHtml(s) {
        return escapeHtml(s).replace(/\u0001/g, '<b>').replace(/\u0002/g, '</b>');
    }

    /* ---------------- reader ---------------- */
    async function openReader(i) {
        const conv = convList[i];
        const messages = await ARDB.getMessages(conv.id);
        const { mainNodes } = ARTree.buildThread(messages);
        currentThread = { conv, mainNodes };

        $('listView').style.display = 'none';
        const view = $('readerView');
        view.style.display = 'block';

        let html =
            '<div class="reader-bar">' +
                '<button class="sm-btn" id="backBtn">← Back</button>' +
                '<h3>' + escapeHtml(conv.title) + '</h3>' +
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
        $('backBtn').onclick = () => { renderList(($('search').value || '').trim()); };
        $('mdBtn').onclick = downloadMd;
        window.scrollTo(0, 0);
    }

    function renderMsg(msg) {
        const user = msg.role === 'human';
        const ts = msg.created_at ? new Date(msg.created_at).toLocaleString() : '';
        let html = '<div class="msg ' + (user ? 'user' : 'assistant') + '">' +
            '<div class="sender">' + (user ? '👤 Human' : '🤖 Assistant') +
            (ts ? '<span class="ts">' + ts + '</span>' : '') + '</div>' +
            '<div class="content-body">' + contentToHtml(msg) + '</div>';
        if (msg.attachments && msg.attachments.length) {
            html += '<div class="attach">📎 ' +
                msg.attachments.map(escapeHtml).join(', ') + '</div>';
        }
        return html + '</div>';
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
