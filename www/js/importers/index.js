/* importers/index.js — registry + auto-detection.
 *
 * Adding a new provider (Gemini, etc.) = one new file that exposes
 * { detect(json) → bool, normalize(json) → [conversation] } and one
 * line in ORDER below. Nothing else in the app changes.
 */
window.ARImportRegistry = (function () {
    const ORDER = ['chatgpt', 'claude']; // chatgpt first: `mapping` is unambiguous

    function detectAndNormalize(json) {
        for (const name of ORDER) {
            const imp = window.ARImporters[name];
            if (imp && imp.detect(json)) {
                return { provider: name, conversations: imp.normalize(json) };
            }
        }
        return null;
    }

    return { detectAndNormalize };
})();
