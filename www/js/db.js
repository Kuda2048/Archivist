/* db.js — storage layer with two interchangeable backends:
 *
 *   • Device (Capacitor):  SQLite with FTS5 full-text search. Parsed once,
 *     searched instantly, survives restarts. Handles huge archives.
 *   • Browser preview:     simple in-memory store, so you can open
 *     www/index.html on your laptop and test without Android Studio.
 *     (Data is lost on refresh in this mode — that's expected.)
 *
 * The rest of the app only talks to window.ARDB and never knows which
 * backend is underneath.
 *
 * Interface:
 *   await ARDB.init()                          → { native: bool }
 *   await ARDB.importConversations(convs)      → { added }
 *   await ARDB.listConversations()             → [{id, provider, title, updated_at, msg_count, edit_count}]
 *   await ARDB.searchConversations(q, deep)    → same shape + optional .snippet
 *   await ARDB.getMessages(conversationId)     → normalized messages
 *   await ARDB.clearAll()
 */
window.ARDB = (function () {
    const DB_NAME = 'archive_reader';

    /* ------------------------------------------------------------------ *
     *  SQLite backend (device)                                            *
     * ------------------------------------------------------------------ */
    function sqliteBackend() {
        const plugin = window.Capacitor.Plugins.CapacitorSQLite;
        const db = { database: DB_NAME };

        async function query(statement, values) {
            const r = await plugin.query({ ...db, statement, values: values || [] });
            return r.values || [];
        }

        async function init() {
            try {
                await plugin.createConnection({
                    ...db, version: 1, encrypted: false, mode: 'no-encryption', readonly: false
                });
            } catch (err) {
                // Native connections outlive webview reloads (app resume, dev
                // reload); reuse the existing one instead of failing to boot.
                if (!/already exists/i.test(String(err && err.message || err))) throw err;
            }
            await plugin.open(db);
            await plugin.execute({
                ...db, transaction: false, statements: `
                CREATE TABLE IF NOT EXISTS conversations (
                    id TEXT PRIMARY KEY, provider TEXT, title TEXT,
                    created_at INTEGER, updated_at INTEGER,
                    msg_count INTEGER, edit_count INTEGER );
                CREATE TABLE IF NOT EXISTS messages (
                    id TEXT PRIMARY KEY, conversation_id TEXT, parent_id TEXT,
                    role TEXT, text TEXT, blocks TEXT, attachments TEXT,
                    created_at INTEGER, ord INTEGER );
                CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id);
                CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts
                    USING fts5(text, conversation_id UNINDEXED);`
            });
        }

        // Keep each bridge payload small: one giant executeSet for a big
        // conversation can OOM the WebView and take the whole app down.
        const CHUNK = 200;

        async function importConversations(convs, onProgress) {
            let added = 0;
            for (const c of convs) {
                const { editCount } = window.ARTree.buildThread(c.messages);

                // Deletes go first and the conversation row LAST: if the
                // import dies partway, no half-imported conversation is
                // visible, and orphan message rows are swept by the deletes
                // on the next import of the same conversation.
                // Re-importing the same export is common — replace cleanly.
                const stmts = [
                    { statement: 'DELETE FROM messages WHERE conversation_id = ?',
                      values: [c.id] },
                    { statement: 'DELETE FROM messages_fts WHERE conversation_id = ?',
                      values: [c.id] }
                ];
                for (const m of c.messages) {
                    stmts.push({
                        statement: `INSERT OR REPLACE INTO messages
                            (id, conversation_id, parent_id, role, text, blocks, attachments, created_at, ord)
                            VALUES (?,?,?,?,?,?,?,?,?)`,
                        values: [m.id, c.id, m.parent_id, m.role, m.text || '',
                                 m.blocks ? JSON.stringify(m.blocks) : null,
                                 m.attachments ? JSON.stringify(m.attachments) : null,
                                 m.created_at, m.ord]
                    });
                    if (m.text) {
                        stmts.push({
                            statement: 'INSERT INTO messages_fts (text, conversation_id) VALUES (?,?)',
                            values: [m.text, c.id]
                        });
                    }
                }
                stmts.push({
                    statement: `INSERT OR REPLACE INTO conversations
                         (id, provider, title, created_at, updated_at, msg_count, edit_count)
                         VALUES (?,?,?,?,?,?,?)`,
                    values: [c.id, c.provider, c.title, c.created_at, c.updated_at,
                             c.messages.length, editCount]
                });

                for (let i = 0; i < stmts.length; i += CHUNK) {
                    await plugin.executeSet({
                        ...db, set: stmts.slice(i, i + CHUNK), transaction: true
                    });
                }
                added++;
                if (onProgress) onProgress(added, convs.length);
            }
            return { added };
        }

        async function listConversations() {
            return query(
                `SELECT id, provider, title, updated_at, msg_count, edit_count
                 FROM conversations ORDER BY updated_at DESC`);
        }

        // Turn free text into a safe FTS5 prefix query: each word → "word"*
        function ftsQuery(q) {
            return q.trim().split(/\s+/).filter(Boolean)
                .map(t => '"' + t.replace(/"/g, '""') + '"*').join(' AND ');
        }

        async function searchConversations(q, deep) {
            // Escape the escape char itself as well as the LIKE wildcards.
            const like = '%' + q.replace(/[\\%_]/g, ch => '\\' + ch) + '%';
            if (!deep) {
                return query(
                    `SELECT id, provider, title, updated_at, msg_count, edit_count
                     FROM conversations WHERE title LIKE ? ESCAPE '\\'
                     ORDER BY updated_at DESC`, [like]);
            }
            const fq = ftsQuery(q);
            if (!fq) return listConversations();
            // snippet() can't run inside an aggregate query (SQLite rejects
            // FTS aux functions there), so compute per-row snippets in a
            // MATERIALIZED CTE — the keyword stops the flattener from
            // merging it back into the aggregate — then pick each
            // conversation's first match via the min/max bare-column rule.
            // The second branch adds title-only matches; its NOT IN keeps
            // body matches from appearing twice in the result.
            return query(
                `WITH hits AS MATERIALIZED (
                    SELECT conversation_id, rowid AS rid,
                           snippet(messages_fts, 0, '\u0001', '\u0002', '…', 12) AS snippet
                    FROM messages_fts WHERE messages_fts MATCH ?)
                 SELECT c.id, c.provider, c.title, c.updated_at, c.msg_count, c.edit_count,
                        snip.snippet AS snippet
                 FROM conversations c
                 JOIN (SELECT conversation_id, snippet, MIN(rid) FROM hits
                       GROUP BY conversation_id) snip
                   ON snip.conversation_id = c.id
                 UNION ALL
                 SELECT id, provider, title, updated_at, msg_count, edit_count, NULL
                 FROM conversations WHERE title LIKE ? ESCAPE '\\'
                   AND id NOT IN (SELECT conversation_id FROM messages_fts
                                  WHERE messages_fts MATCH ?)
                 ORDER BY updated_at DESC`, [fq, like, fq]);
        }

        async function getMessages(conversationId) {
            const rows = await query(
                'SELECT * FROM messages WHERE conversation_id = ? ORDER BY ord', [conversationId]);
            return rows.map(r => ({
                ...r,
                blocks: r.blocks ? JSON.parse(r.blocks) : null,
                attachments: r.attachments ? JSON.parse(r.attachments) : null
            }));
        }

        async function clearAll() {
            await plugin.execute({
                ...db, transaction: false,
                statements: 'DELETE FROM messages; DELETE FROM messages_fts; DELETE FROM conversations;'
            });
        }

        return { init, importConversations, listConversations, searchConversations, getMessages, clearAll, native: true };
    }

    /* ------------------------------------------------------------------ *
     *  In-memory backend (browser preview)                                *
     * ------------------------------------------------------------------ */
    function memoryBackend() {
        let convs = new Map();     // id → conv meta
        let msgs = new Map();      // conv id → messages
        let haystack = new Map();  // conv id → lowercased all-text

        async function init() {}

        async function importConversations(list, onProgress) {
            let added = 0;
            for (const c of list) {
                const { editCount } = window.ARTree.buildThread(c.messages);
                convs.set(c.id, {
                    id: c.id, provider: c.provider, title: c.title,
                    updated_at: c.updated_at, msg_count: c.messages.length,
                    edit_count: editCount
                });
                msgs.set(c.id, c.messages);
                haystack.set(c.id,
                    (c.title + ' ' + c.messages.map(m => m.text || '').join(' ')).toLowerCase());
                added++;
                if (onProgress) onProgress(added, list.length);
            }
            return { added: list.length };
        }

        async function listConversations() {
            return [...convs.values()].sort((a, b) => (b.updated_at || 0) - (a.updated_at || 0));
        }

        async function searchConversations(q, deep) {
            const needle = q.toLowerCase();
            return (await listConversations()).filter(c =>
                deep ? haystack.get(c.id).includes(needle)
                     : c.title.toLowerCase().includes(needle));
        }

        async function getMessages(id) { return msgs.get(id) || []; }
        async function clearAll() { convs.clear(); msgs.clear(); haystack.clear(); }

        return { init, importConversations, listConversations, searchConversations, getMessages, clearAll, native: false };
    }

    /* ------------------------------------------------------------------ */
    let backend = null;

    async function init() {
        const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                            window.Capacitor.isNativePlatform() &&
                            window.Capacitor.Plugins && window.Capacitor.Plugins.CapacitorSQLite);
        backend = isNative ? sqliteBackend() : memoryBackend();
        await backend.init();
        return { native: backend.native };
    }

    const call = name => (...args) => backend[name](...args);
    return {
        init,
        importConversations: call('importConversations'),
        listConversations: call('listConversations'),
        searchConversations: call('searchConversations'),
        getMessages: call('getMessages'),
        clearAll: call('clearAll'),
        isNative: () => backend && backend.native
    };
})();
