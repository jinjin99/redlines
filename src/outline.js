// A page tree as a short outline an AI agent (or a person) can read: components, the elements a
// person acts on, landmarks and text, indented by how they nest. Wrappers with nothing to say are
// skipped, so a deep page is a few dozen lines.
const THING = /^(button|a|input|select|textarea|img|svg|h[1-6]|label|nav|header|footer|main|aside|form|table|tr|dialog|section|li)$/;

const props = p => Object.entries(p ?? {}).map(([k, v]) => ` ${k}=${JSON.stringify(v)}`).join('');

/** The outline as text, at most `max` lines. */
export function outline(tree, { max = 200 } = {}) {
    const lines = [];
    let cut = false;
    const visit = (n, depth) => {
        if (lines.length >= max) { cut = true; return; }
        if ('text' in n) { lines.push(`${'  '.repeat(depth)}"${n.text.length > 120 ? `${n.text.slice(0, 120)}…` : n.text}"`); return; }
        const attrs = n.attrs ?? {};
        let label = null;
        if (n.component) label = `<${n.component.name}${props(n.component.props)}>`;
        else if (THING.test(n.tag) || attrs.role || attrs['aria-label']) {
            const extra = ['href', 'placeholder', 'value', 'role', 'aria-label', 'alt', 'type'].filter(k => attrs[k] && !(k === 'type' && n.tag !== 'input')).map(k => ` ${k}=${JSON.stringify(attrs[k].length > 60 ? `${attrs[k].slice(0, 60)}…` : attrs[k])}`).join('');
            label = `<${n.tag}${n.classes?.length ? `.${n.classes[0]}` : ''}${extra}${attrs.checked ? ' checked' : ''}${attrs.disabled != null ? ' disabled' : ''}>`;
        }
        // A wrapper whose only child is text: the text on the same line.
        const kids = n.children ?? [];
        if (label && kids.length === 1 && 'text' in kids[0]) { lines.push(`${'  '.repeat(depth)}${label} "${kids[0].text}"`); return; }
        if (label) lines.push(`${'  '.repeat(depth)}${label}`);
        for (const c of kids) visit(c, label ? depth + 1 : depth);
    };
    visit(tree.root, 0);
    if (cut) lines.push(`… (cut at ${max} lines)`);
    return lines.join('\n');
}
