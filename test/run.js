/* test/run.js — plain `node test/run.js`, no deps beyond Node itself.
 *
 * Covers the provider importers, tree reconstruction, and the SQLite storage
 * layer (migration, per-message search, filters, FTS-syntax safety). The DB
 * tests run the real www/js/db.js against a mock CapacitorSQLite plugin
 * backed by node:sqlite, so the actual on-device SQL is exercised — including
 * the FTS5 snippet()/rank paths. If node:sqlite is unavailable (Node < 22),
 * the DB block is skipped rather than failing the run.
 */
'use strict';
const path = require('path');

let passed = 0, failed = 0;
const fails = [];
function ok(cond, msg) {
    if (cond) { passed++; }
    else { failed++; fails.push(msg); console.error('  ✗ ' + msg); }
}
function eq(a, b, msg) { ok(a === b, msg + ' (got ' + JSON.stringify(a) + ')'); }
function section(name) { console.log('\n' + name); }

const SRC = path.join(__dirname, '..', 'www', 'js');

/* Load a browser-style script that attaches to window, into a fresh global. */
function loadInto(win, rel) {
    const p = require.resolve(path.join(SRC, rel));
    delete require.cache[p];
    global.window = win;
    require(p);
}
function freshApp() {
    const win = {};
    loadInto(win, 'tree.js');
    loadInto(win, 'importers/claude.js');
    loadInto(win, 'importers/chatgpt.js');
    loadInto(win, 'importers/index.js');
    return win;
}

/* ------------------------------------------------------------------ *
 *  tree.js                                                            *
 * ------------------------------------------------------------------ */
section('tree.js');
{
    const { ARTree } = freshApp();

    // Edit branch: two siblings off the same parent, newest wins the main path.
    let r = ARTree.buildThread([
        { id: 'a', parent_id: null, role: 'human', text: 'v1', created_at: 1000, ord: 0 },
        { id: 'b', parent_id: 'a', role: 'assistant', text: 'r1', created_at: 2000, ord: 1 },
        { id: 'a2', parent_id: null, role: 'human', text: 'v2', created_at: 3000, ord: 2 },
        { id: 'c', parent_id: 'a2', role: 'assistant', text: 'r2', created_at: 4000, ord: 3 }
    ]);
    eq(r.mainNodes.map(n => n.msg.id).join(), 'a2,c', 'edit branch: newest sibling is main path');
    eq(r.editCount, 1, 'edit branch: one past edit counted');

    // Two-level comparator: a timestamp-less newer edit (higher ord) still wins.
    r = ARTree.buildThread([
        { id: 'x', parent_id: null, role: 'human', text: 'old', created_at: 5000, ord: 0 },
        { id: 'y', parent_id: null, role: 'human', text: 'new', created_at: null, ord: 1 }
    ]);
    eq(r.mainNodes[0].msg.id, 'y', 'sibling order: ord breaks tie when a timestamp is missing');

    // Cycle in bad data must not hang.
    r = ARTree.buildThread([
        { id: 'p', parent_id: 'q', role: 'human', text: '1', created_at: 1, ord: 0 },
        { id: 'q', parent_id: 'p', role: 'human', text: '2', created_at: 2, ord: 1 }
    ]);
    ok(r.mainNodes.length >= 1, 'cycle: terminates and returns something');

    // Linear fallback when nothing has a resolvable root.
    r = ARTree.buildThread([
        { id: 'm1', parent_id: null, role: 'human', text: 'hi', created_at: 1, ord: 0 },
        { id: 'm2', parent_id: 'm1', role: 'assistant', text: 'yo', created_at: 2, ord: 1 }
    ]);
    eq(r.mainNodes.length, 2, 'linear thread: both messages on main path');
    eq(r.editCount, 0, 'linear thread: no edits');
}

/* ------------------------------------------------------------------ *
 *  importers                                                          *
 * ------------------------------------------------------------------ */
section('importers/claude.js');
{
    const { ARImporters, ARImportRegistry } = freshApp();

    const claudeExport = [{
        uuid: 'conv-1', name: 'Claude chat',
        created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
        chat_messages: [
            { uuid: 'u1', parent_message_uuid: '00000000-0000-4000-8000-000000000000',
              sender: 'human', text: 'first', created_at: '2024-01-01T00:00:01Z' },
            { uuid: 'a1', parent_message_uuid: 'u1', sender: 'assistant',
              content: [{ type: 'text', text: 'answer one' }], created_at: '2024-01-01T00:00:02Z' },
            // edited prompt: second child of u1
            { uuid: 'u1b', parent_message_uuid: 'u1', sender: 'human',
              text: 'first edited', created_at: '2024-01-01T00:00:03Z' }
        ]
    }];
    ok(ARImporters.claude.detect(claudeExport), 'claude: detect array export');
    const cn = ARImporters.claude.normalize(claudeExport)[0];
    eq(cn.provider, 'claude', 'claude: provider tag');
    eq(cn.id, 'conv-1', 'claude: conversation id from uuid');
    eq(cn.messages.length, 3, 'claude: all messages kept');
    const u1 = cn.messages.find(m => m.id === 'u1');
    eq(u1.parent_id, null, 'claude: root parent normalized to null');
    eq(cn.messages.find(m => m.id === 'a1').role, 'assistant', 'claude: role mapped');
    // Auto-detect through the registry, then reconstruct: edit branch present.
    const det = ARImportRegistry.detectAndNormalize(claudeExport);
    eq(det.provider, 'claude', 'registry: routes to claude');
    const tree = window.ARTree.buildThread(det.conversations[0].messages);
    eq(tree.editCount, 1, 'claude: edited prompt becomes one past edit');

    // Old-format export (no uuid tree) chains linearly.
    const old = [{ uuid: 'c2', name: 'old', chat_messages: [
        { sender: 'human', text: 'a' }, { sender: 'assistant', text: 'b' },
        { sender: 'human', text: 'c' } ] }];
    const on = ARImporters.claude.normalize(old)[0];
    eq(on.messages[1].parent_id, on.messages[0].id, 'claude old-format: linear chaining');
    eq(window.ARTree.buildThread(on.messages).editCount, 0, 'claude old-format: no false edits');
}

section('importers/chatgpt.js');
{
    const { ARImporters, ARImportRegistry } = freshApp();

    const gptExport = [{
        conversation_id: 'g1', title: 'GPT chat',
        create_time: 1700000000, update_time: 1700000100,
        mapping: {
            root: { id: 'root', message: null, parent: null, children: ['sys'] },
            sys: { id: 'sys', parent: 'root', children: ['n1'],
                   message: { author: { role: 'system' }, content: { content_type: 'text', parts: [''] } } },
            n1: { id: 'n1', parent: 'sys', children: ['n2'],
                  message: { author: { role: 'user' }, create_time: 1700000001,
                             content: { content_type: 'text', parts: ['hello gpt'] } } },
            n2: { id: 'n2', parent: 'n1', children: [],
                  message: { author: { role: 'assistant' }, create_time: 1700000002,
                             content: { content_type: 'text', parts: ['hi there'] } } }
        }
    }];
    ok(ARImporters.chatgpt.detect(gptExport), 'chatgpt: detect mapping export');
    const gn = ARImporters.chatgpt.normalize(gptExport)[0];
    eq(gn.provider, 'chatgpt', 'chatgpt: provider tag');
    eq(gn.messages.length, 2, 'chatgpt: system/empty nodes dropped');
    const n1 = gn.messages.find(m => m.id === 'n1');
    eq(n1.role, 'human', 'chatgpt: user role mapped to human');
    // n1's real parent in the mapping is the system node, which was dropped;
    // it must re-parent to the nearest kept ancestor (none → null).
    eq(n1.parent_id, null, 'chatgpt: re-parent past dropped system node');
    eq(gn.messages.find(m => m.id === 'n2').parent_id, 'n1', 'chatgpt: kept-ancestor link');
    eq(ARImportRegistry.detectAndNormalize(gptExport).provider, 'chatgpt', 'registry: routes to chatgpt');
}

/* ------------------------------------------------------------------ *
 *  db.js (SQLite backend against node:sqlite)                          *
 * ------------------------------------------------------------------ */
section('db.js (SQLite backend)');
let DatabaseSync = null;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (_) { console.log('  … node:sqlite unavailable, skipping DB tests'); }

function mockPlugin(sql) {
    const norm = v => v === undefined ? null : v;
    return {
        async createConnection() {},
        async open() {},
        async execute({ statements }) { sql.exec(statements); },
        async run({ statement, values }) { sql.prepare(statement).run(...(values || []).map(norm)); },
        async query({ statement, values }) {
            return { values: sql.prepare(statement).all(...(values || []).map(norm)) };
        },
        async executeSet({ set, transaction }) {
            if (transaction) sql.exec('BEGIN');
            try {
                for (const s of set) sql.prepare(s.statement).run(...(s.values || []).map(norm));
                if (transaction) sql.exec('COMMIT');
            } catch (e) { if (transaction) sql.exec('ROLLBACK'); throw e; }
        }
    };
}
function loadDbBackedBy(sql) {
    const win = { Capacitor: { isNativePlatform: () => true,
        Plugins: { CapacitorSQLite: mockPlugin(sql) } } };
    loadInto(win, 'tree.js');
    loadInto(win, 'db.js');
    return win.ARDB;
}

async function dbTests() {
    if (!DatabaseSync) return;

    // ---- migration: 2-column FTS install → 3-column, no re-import ----
    {
        const sql = new DatabaseSync(':memory:');
        // Simulate an OLD install: tables + a 2-column messages_fts already
        // populated, user_version still 0.
        sql.exec(`
            CREATE TABLE conversations (id TEXT PRIMARY KEY, provider TEXT, title TEXT,
                created_at INTEGER, updated_at INTEGER, msg_count INTEGER, edit_count INTEGER);
            CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, parent_id TEXT,
                role TEXT, text TEXT, blocks TEXT, attachments TEXT, created_at INTEGER, ord INTEGER);
            CREATE VIRTUAL TABLE messages_fts USING fts5(text, conversation_id UNINDEXED);
            INSERT INTO conversations VALUES ('c1','claude','Old chat',1,100,2,0);
            INSERT INTO messages VALUES ('m1','c1',NULL,'human','apple pie recipe',NULL,NULL,10,0);
            INSERT INTO messages VALUES ('m2','c1','m1','assistant','here is the banana bread',NULL,NULL,20,1);
            INSERT INTO messages_fts (text, conversation_id) VALUES ('apple pie recipe','c1');
            INSERT INTO messages_fts (text, conversation_id) VALUES ('here is the banana bread','c1');
            PRAGMA user_version = 0;`);

        const ARDB = loadDbBackedBy(sql);
        let reindexed = 0;
        await ARDB.init((done, total) => { reindexed = total; });

        eq(sql.prepare('PRAGMA user_version').all()[0].user_version, 1, 'migration: user_version bumped to 1');
        const cols = sql.prepare('SELECT COUNT(*) AS n FROM messages_fts').all()[0].n;
        eq(cols, 2, 'migration: every message reindexed (2 rows)');
        // message_id now populated for all rows.
        const withId = sql.prepare(
            "SELECT COUNT(*) AS n FROM messages_fts WHERE message_id IS NOT NULL AND message_id != ''").all()[0].n;
        eq(withId, 2, 'migration: message_id populated on every FTS row');
        // Search works with NO re-import, and points at the right message.
        const hits = await ARDB.searchMessages('banana', {});
        eq(hits.length, 1, 'migration: term searchable offline after reindex');
        eq(hits[0].message_id, 'm2', 'migration: hit carries the correct message_id');
    }

    // ---- self-heal: messages_fts missing entirely (the on-device failure) ----
    // A half-finished v1 migration could leave the FTS table dropped but never
    // recreated, so the next import hit "no such table: messages_fts". init()
    // must recreate and repopulate it, and import must then succeed.
    {
        const sql = new DatabaseSync(':memory:');
        sql.exec(`
            CREATE TABLE conversations (id TEXT PRIMARY KEY, provider TEXT, title TEXT,
                created_at INTEGER, updated_at INTEGER, msg_count INTEGER, edit_count INTEGER);
            CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, parent_id TEXT,
                role TEXT, text TEXT, blocks TEXT, attachments TEXT, created_at INTEGER, ord INTEGER);
            INSERT INTO conversations VALUES ('c1','claude','Recovered',1,100,1,0);
            INSERT INTO messages VALUES ('m1','c1',NULL,'human','strawberry fields',NULL,NULL,10,0);
            PRAGMA user_version = 0;`); // note: NO messages_fts table at all

        const ARDB = loadDbBackedBy(sql);
        await ARDB.init();
        ok(sql.prepare("SELECT 1 FROM sqlite_master WHERE name='messages_fts'").all().length === 1,
            'self-heal: messages_fts recreated when missing');
        eq((await ARDB.searchMessages('strawberry', {})).length, 1,
            'self-heal: existing message reindexed without re-import');
        // The exact failing operation — import DELETE FROM messages_fts — works.
        let importThrew = false;
        try {
            await ARDB.importConversations([{
                id: 'c1', provider: 'claude', title: 'Recovered', created_at: 1, updated_at: 100,
                messages: [{ id: 'm1', parent_id: null, role: 'human', text: 'strawberry fields', created_at: 10, ord: 0 }]
            }]);
        } catch (_) { importThrew = true; }
        ok(!importThrew, 'self-heal: re-import no longer throws on messages_fts');
    }

    // ---- idempotent: a second init() must not re-index or duplicate rows ----
    {
        const sql = new DatabaseSync(':memory:');
        const ARDB = loadDbBackedBy(sql);
        await ARDB.init();
        await ARDB.importConversations([{
            id: 'c1', provider: 'claude', title: 'Once', created_at: 1, updated_at: 1,
            messages: [{ id: 'm1', parent_id: null, role: 'human', text: 'kiwi kiwi', created_at: 1, ord: 0 }]
        }]);
        let reran = false;
        await ARDB.init((d, t) => { if (t) reran = true; }); // second boot
        ok(!reran, 'idempotent: migration does not run again on a v1 database');
        eq((await ARDB.searchMessages('kiwi', {})).length, 1, 'idempotent: no duplicate FTS rows');
    }

    // ---- fresh install: import, per-message search, edit-branch hit ----
    {
        const sql = new DatabaseSync(':memory:');
        const ARDB = loadDbBackedBy(sql);
        await ARDB.init();

        // Conversation whose ONLY occurrence of "pineapple" is in an abandoned
        // edit branch (a1 is superseded by a1b as the answer to u1).
        await ARDB.importConversations([{
            id: 'c1', provider: 'claude', title: 'Fruit chat', created_at: 1, updated_at: 100,
            messages: [
                { id: 'u1', parent_id: null, role: 'human', text: 'tell me about fruit', created_at: 10, ord: 0 },
                { id: 'a1', parent_id: 'u1', role: 'assistant', text: 'pineapple is a fruit', created_at: 20, ord: 1 },
                { id: 'a1b', parent_id: 'u1', role: 'assistant', text: 'mango is a fruit', created_at: 30, ord: 2 }
            ]
        }]);
        const branchHit = await ARDB.searchMessages('pineapple', {});
        eq(branchHit.length, 1, 'edit-branch term returns a hit');
        eq(branchHit[0].message_id, 'a1', 'edit-branch hit points at the branch message');
        ok(branchHit[0].snippet.includes(String.fromCharCode(1)), 'hit snippet carries highlight sentinels');

        // ---- filters compose: provider + sender + date ----
        await ARDB.importConversations([{
            id: 'c2', provider: 'chatgpt', title: 'GPT fruit', created_at: 1, updated_at: 200,
            messages: [
                { id: 'g1', parent_id: null, role: 'human', text: 'mango season', created_at: 1000, ord: 0 },
                { id: 'g2', parent_id: 'g1', role: 'assistant', text: 'mango is sweet', created_at: 2000, ord: 1 }
            ]
        }]);
        eq((await ARDB.searchMessages('mango', {})).length, 3, 'no filter: all mango hits');
        eq((await ARDB.searchMessages('mango', { provider: 'chatgpt' })).length, 2, 'filter: provider');
        eq((await ARDB.searchMessages('mango', { provider: 'chatgpt', sender: 'assistant' })).length, 1,
            'filter: provider + sender compose');
        eq((await ARDB.searchMessages('mango', { since: 1500 })).length, 1, 'filter: date since');
        eq((await ARDB.searchMessages('mango', { provider: 'chatgpt', sender: 'human', since: 500 })).length, 1,
            'filter: all three compose');

        // ---- FTS syntax characters must not throw ----
        for (const q of ['"quote', 'star*', '-minus', 'NEAR foo', 'a AND', '((']) {
            let threw = false;
            try { await ARDB.searchMessages(q, {}); } catch (_) { threw = true; }
            ok(!threw, 'FTS-syntax query does not throw: ' + JSON.stringify(q));
        }

        // searchConversations (list) still works and dedupes title+body match.
        const conv = await ARDB.searchConversations('fruit', true);
        eq(conv.filter(c => c.id === 'c1').length, 1, 'searchConversations: no duplicate row');
    }
}

/* ------------------------------------------------------------------ *
 *  Highlight escaping (algorithm used by app.js snippetHtml)          *
 * ------------------------------------------------------------------ */
section('highlight escaping');
{
    // Mirror of app.js: escape first, THEN turn sentinels into <b>. A hostile
    // message must stay inert even when it is the highlighted match.
    const S = String.fromCharCode(1), E = String.fromCharCode(2);
    const escapeHtml = s => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    const snippetHtml = s => escapeHtml(s)
        .replace(new RegExp(S, 'g'), '<b>').replace(new RegExp(E, 'g'), '</b>');

    const out = snippetHtml('before ' + S + '<script>alert(1)</script>' + E + ' after');
    ok(out.includes('&lt;script&gt;'), 'escaping: <script> is neutralized');
    ok(!/<script>/.test(out), 'escaping: no live <script> tag survives');
    ok(out.includes('<b>') && out.includes('</b>'), 'escaping: sentinels still become <b>');
    // Backtick runs are just text to the snippet renderer — must not error.
    ok(snippetHtml('```' + S + 'code' + E + '```').includes('<b>code</b>'), 'escaping: backticks are inert');
}

/* ------------------------------------------------------------------ */
(async () => {
    await dbTests();
    console.log('\n' + '='.repeat(40));
    console.log((failed ? '✗ FAIL' : '✓ PASS') + '  ' + passed + ' passed, ' + failed + ' failed');
    if (failed) { console.log('Failures:\n  - ' + fails.join('\n  - ')); process.exit(1); }
})();
