/* importers/chatgpt.js — ChatGPT data export → normalized conversations.
 *
 * ChatGPT's conversations.json is an array; each conversation stores its
 * tree as `mapping`: { nodeId: { id, message, parent, children } }.
 * Edits create sibling branches, same idea as Claude. We keep only
 * human/assistant messages with visible text, and re-parent each kept
 * message to its nearest KEPT ancestor so the tree stays connected after
 * dropping system/tool nodes.
 */
window.ARImporters = window.ARImporters || {};

window.ARImporters.chatgpt = (function () {

    function detect(data) {
        const arr = Array.isArray(data) ? data : [data];
        return arr.some(c => c && typeof c.mapping === 'object' && c.mapping !== null);
    }

    function extractText(content) {
        if (!content) return '';
        const type = content.content_type;
        if (type === 'text' || type === 'multimodal_text') {
            return (content.parts || [])
                .map(p => {
                    if (typeof p === 'string') return p;
                    if (p && p.content_type === 'audio_transcription') return p.text || '';
                    return ''; // images / audio pointers — surfaced as attachments below
                })
                .filter(Boolean).join('\n');
        }
        if (type === 'code') return '```\n' + (content.text || '') + '\n```';
        if (typeof content.text === 'string') return content.text;
        return '';
    }

    function nonTextParts(content) {
        if (!content || !Array.isArray(content.parts)) return [];
        return content.parts
            .filter(p => p && typeof p === 'object' && p.content_type &&
                         p.content_type !== 'audio_transcription')
            .map(p => p.content_type.replace(/_/g, ' '));
    }

    function normalize(data) {
        const arr = Array.isArray(data) ? data : [data];
        return arr.map((conv, ci) => {
            const mapping = conv.mapping || {};
            const keep = new Map();
            let ord = 0;

            for (const [id, node] of Object.entries(mapping)) {
                const m = node && node.message;
                if (!m) continue;
                const role = m.author && m.author.role;
                if (role !== 'user' && role !== 'assistant') continue;
                if (m.metadata && m.metadata.is_visually_hidden_from_conversation) continue;
                const text = extractText(m.content);
                const extras = nonTextParts(m.content);
                if (!text.trim() && !extras.length) continue;
                keep.set(id, {
                    id,
                    parent_id: null, // filled in below
                    role: role === 'user' ? 'human' : 'assistant',
                    text,
                    blocks: null,
                    attachments: extras.length ? extras : null,
                    created_at: m.create_time ? Math.round(m.create_time * 1000) : null,
                    ord: ord++
                });
            }

            // Re-parent to the nearest kept ancestor.
            for (const [id, msg] of keep) {
                let p = mapping[id] && mapping[id].parent;
                const seen = new Set();
                while (p && !keep.has(p) && !seen.has(p)) {
                    seen.add(p);
                    p = mapping[p] && mapping[p].parent;
                }
                msg.parent_id = keep.has(p) ? p : null;
            }

            const toMs = t => (typeof t === 'number' ? Math.round(t * 1000) : null);
            return {
                id: conv.conversation_id || conv.id || ('chatgpt-conv-' + ci),
                provider: 'chatgpt',
                title: conv.title || 'Untitled Chat',
                created_at: toMs(conv.create_time),
                updated_at: toMs(conv.update_time || conv.create_time),
                messages: [...keep.values()]
            };
        });
    }

    return { detect, normalize };
})();
