/* tree.js — provider-agnostic conversation-tree reconstruction.
 *
 * Works on NORMALIZED messages: { id, parent_id, role, text, blocks?,
 * attachments?, created_at (ms or null), ord (import order) }.
 *
 * Both Claude and ChatGPT store every version of an edited message; the
 * old and new versions share a parent. We rebuild the tree, follow the
 * NEWEST child at each step to get the current conversation, and collect
 * older siblings (with their whole abandoned branches) as "past edits".
 */
window.ARTree = (function () {

    // Sort key: prefer real timestamps, fall back to import order.
    function sortKey(m) {
        return (m.created_at != null ? m.created_at : 0) || m.ord || 0;
    }

    /**
     * @param {Array} messages normalized messages of ONE conversation
     * @returns {{ mainNodes: Array<{msg, pastEdits: Array<Array>}>, editCount: number }}
     */
    function buildThread(messages) {
        const byId = new Map();
        messages.forEach(m => byId.set(m.id, m));

        const children = new Map();
        messages.forEach(m => {
            let p = m.parent_id;
            if (!p || !byId.has(p)) p = '__ROOT__';
            if (!children.has(p)) children.set(p, []);
            children.get(p).push(m);
        });
        children.forEach(arr => arr.sort((a, b) => sortKey(a) - sortKey(b)));

        const mainNodes = [];
        const visited = new Set(); // guards against parent cycles in bad data
        let siblings = children.get('__ROOT__') || [];
        while (siblings.length) {
            const current = siblings[siblings.length - 1];
            if (visited.has(current.id)) break;
            visited.add(current.id);
            const older = siblings.slice(0, -1).map(m => collectBranch(m, children, visited));
            mainNodes.push({ msg: current, pastEdits: older });
            siblings = children.get(current.id) || [];
        }

        // Safety net: if the walk found nothing, render linearly.
        if (!mainNodes.length) {
            messages.slice().sort((a, b) => sortKey(a) - sortKey(b))
                .forEach(m => mainNodes.push({ msg: m, pastEdits: [] }));
        }

        const editCount = mainNodes.reduce((n, node) => n + node.pastEdits.length, 0);
        return { mainNodes, editCount };
    }

    // An abandoned branch: the old message plus its newest line of descendants.
    function collectBranch(msg, children, visited) {
        const branch = [msg];
        visited.add(msg.id);
        let siblings = children.get(msg.id) || [];
        while (siblings.length) {
            const cur = siblings[siblings.length - 1];
            if (visited.has(cur.id)) break;
            visited.add(cur.id);
            branch.push(cur);
            siblings = children.get(cur.id) || [];
        }
        return branch;
    }

    return { buildThread };
})();
