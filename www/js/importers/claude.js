/* importers/claude.js — Claude data export → normalized conversations.
 *
 * Claude's conversations.json is an array of conversations; each has
 * chat_messages with uuid / parent_message_uuid forming a tree (edited
 * prompts create sibling branches). We keep the tree intact — the main
 * path and past-edit branches are reconstructed at read time by ARTree.
 */
window.ARImporters = window.ARImporters || {};

window.ARImporters.claude = (function () {
    const ROOT_UUIDS = new Set(['00000000-0000-4000-8000-000000000000', '', null, undefined]);

    function plainText(content, msg) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content))
            return content.map(b => b.text || b.thinking || '').filter(Boolean).join('\n');
        if (msg && msg.text) return msg.text;
        return '';
    }

    function toMs(s) { const t = Date.parse(s || ''); return isNaN(t) ? null : t; }

    function detect(data) {
        const arr = Array.isArray(data) ? data : (data && data.conversations) || [];
        return arr.some(c => c && (c.chat_messages || (c.uuid && c.name !== undefined)));
    }

    function normalize(data) {
        const arr = Array.isArray(data) ? data : (data.conversations || [data]);
        return arr.map((conv, ci) => {
            const raw = conv.chat_messages || conv.messages || [];
            const known = new Set(raw.map(m => m.uuid).filter(Boolean));
            // Old-format exports have no uuid/parent tree: chain messages
            // linearly so siblings aren't mistaken for edit branches.
            const hasTree = raw.some(m => m.uuid && m.parent_message_uuid !== undefined);

            let prevId = null;
            const messages = raw.map((m, i) => {
                const myId = m.uuid || ('claude-msg-' + ci + '-' + i);
                let parent;
                if (hasTree) {
                    parent = m.parent_message_uuid;
                    if (ROOT_UUIDS.has(parent) || !known.has(parent)) parent = null;
                } else {
                    parent = prevId;
                }
                prevId = myId;
                const sender = (m.sender || m.role || '').toLowerCase();
                const files = [].concat(m.attachments || [], m.files || [])
                    .map(f => f.file_name || f.name || 'file');
                return {
                    id: myId,
                    parent_id: parent,
                    role: (sender === 'human' || sender === 'user') ? 'human' : 'assistant',
                    text: plainText(m.content, m),
                    // Keep the raw block array so thinking / tool_use render nicely.
                    blocks: Array.isArray(m.content) ? m.content : null,
                    attachments: files.length ? files : null,
                    created_at: toMs(m.created_at),
                    ord: i
                };
            });

            return {
                id: conv.uuid || ('claude-conv-' + ci),
                provider: 'claude',
                title: conv.name || conv.title || 'Untitled Chat',
                created_at: toMs(conv.created_at),
                updated_at: toMs(conv.updated_at || conv.created_at),
                messages
            };
        });
    }

    return { detect, normalize };
})();
