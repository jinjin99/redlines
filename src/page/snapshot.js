// Runs inside the page (Playwright's page.evaluate serializes this function, so it must not use
// anything from outside its own body). Walks the rendered DOM and returns the page tree: what is on
// screen, element by element, with what a person would call it (a component's name, a readable
// class, an aria-label), how it looks (a fixed set of computed styles) and where it is (its box in
// page pixels). What is drawn but not seen (screen-reader text, measuring copies) is left out.
//
// Tree format (version 1):
//   page:  { version: 1, url, title, viewport: { width, height }, size: { width, height }, root }
//   element: { tag, name?, component?: { name, props }, classes?, attrs?, style, box: [x, y, w, h], children }
//   text:  { text, box }
export function snapshot(opts = {}) {
    const STYLE = opts.styleKeys || [
        'display', 'color', 'background-color', 'background-image', 'font-family', 'font-size', 'font-weight', 'font-style',
        'line-height', 'letter-spacing', 'text-align', 'text-decoration-line', 'text-transform',
        'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
        'border-top-style', 'border-top-color', 'border-radius', 'box-shadow', 'opacity',
        'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
        'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
        'gap', 'flex-direction', 'justify-content', 'align-items', 'grid-template-columns',
    ];
    const ATTRS = ['href', 'src', 'alt', 'title', 'placeholder', 'role', 'aria-label', 'type', 'name', 'value', 'checked', 'disabled'];
    const SKIP = /^(script|style|link|meta|noscript|template|head)$/i;
    const LANDMARK = /^(nav|header|footer|main|aside|form|table|dialog|section|article)$/;
    const ignore = opts.ignore ? document.querySelectorAll(opts.ignore) : [];
    const ignored = new Set(ignore);
    const sx = window.scrollX, sy = window.scrollY;
    const boxOf = r => [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];

    // A class a person can read (card, MuiButton-root, nav__item), not a build's hash (css-1x2y3z, _a8f3k).
    const readable = c => c.length <= 48 && /^[A-Za-z][A-Za-z-_]*[A-Za-z]$/.test(c) && /[aeiou]/i.test(c) && !/^(css|sc|jsx|emotion)-/.test(c);

    // React, when the page uses it: the component whose whole output an element is.
    const fiberKey = el => Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    const current = new Set();
    (function collect() {
        const roots = [document.body, ...document.body.querySelectorAll(':scope > *, :scope > * > *')];
        for (const el of roots) {
            const k = Object.keys(el).find(x => x.startsWith('__reactContainer$'));
            const root = k && el[k] && el[k].stateNode && el[k].stateNode.current;
            if (!root) continue;
            const stack = [root];
            while (stack.length) {
                const f = stack.pop();
                current.add(f);
                if (f.sibling) stack.push(f.sibling);
                if (f.child) stack.push(f.child);
            }
        }
    })();
    // React keeps two copies of each fiber; the one on screen is in the tree under the root's `current`.
    const live = f => (f && !current.has(f) && f.alternate && current.has(f.alternate) ? f.alternate : f);
    const nameOfType = t => {
        if (!t || typeof t === 'string') return null;
        return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && nameOfType(t.type)) || null;
    };
    const goodName = n => n && /^[A-Z][A-Za-z0-9]+$/.test(n) && !/(Provider|Consumer|Context|Boundary|Suspense|Fragment|Router|Route|Switch|Portal)$/.test(n);
    const hostRoots = (f, acc) => {
        for (let c = f.child; c; c = c.sibling) {
            if (c.tag === 5 || c.tag === 6) acc.push(c);
            else if (c.tag !== 4) hostRoots(c, acc);
            if (acc.length > 1) break;
        }
        return acc;
    };
    const plainProps = props => {
        const out = {};
        let n = 0;
        for (const k of Object.keys(props || {})) {
            const v = props[k];
            if (k === 'children' || k === 'key' || k === 'ref' || k === 'className' || k === 'style' || k === 'id' || /^(on[A-Z]|data-|aria-)/.test(k)) continue;
            if (typeof v === 'string' ? v.length <= 80 : typeof v === 'number' || typeof v === 'boolean') {
                out[k] = v;
                if (++n >= 8) break;
            }
        }
        return out;
    };
    const componentOf = el => {
        const k = fiberKey(el);
        const f = k && live(el[k]);
        if (!f) return null;
        let best = null;
        for (let p = live(f.return); p && p.tag !== 5 && p.tag !== 3 && p.tag !== 4; p = live(p.return)) {
            const roots = hostRoots(p, []);
            if (roots.length !== 1 || roots[0] !== f) break;
            const name = nameOfType(p.elementType || p.type);
            if (goodName(name)) best = { name, props: plainProps(p.memoizedProps) };
        }
        return best;
    };

    const unseen = (el, cs, r) =>
        cs.visibility !== 'visible' || cs.opacity === '0' ||
        ((cs.position === 'absolute' || cs.position === 'fixed') && (r.width * r.height <= 1 || cs.clip !== 'auto' || r.right <= 0 || r.bottom <= 0));

    const walk = n => {
        if (n.nodeType === 3) {
            const text = n.nodeValue.replace(/\s+/g, ' ').trim();
            if (!text) return null;
            const range = document.createRange();
            range.selectNodeContents(n);
            const r = range.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return null;
            return { text, box: boxOf(r) };
        }
        if (n.nodeType !== 1 || SKIP.test(n.tagName) || ignored.has(n)) return null;
        const cs = getComputedStyle(n);
        if (cs.display === 'none') return null;
        const r = n.getBoundingClientRect();
        if (unseen(n, cs, r) && !n.querySelector('[style*="visibility: visible"]')) return null;
        const tag = n.tagName.toLowerCase();
        const node = { tag };
        const component = componentOf(n);
        if (component) node.component = component;
        const classes = [...n.classList].filter(readable);
        if (classes.length) node.classes = classes;
        const attrs = {};
        for (const a of ATTRS) {
            if (a === 'value' && 'value' in n && (tag === 'input' || tag === 'textarea' || tag === 'select')) { if (n.value) attrs.value = String(n.value); continue; }
            if (a === 'checked' && tag === 'input') { if (n.checked) attrs.checked = 'true'; continue; }
            const v = n.getAttribute(a);
            if (v != null) attrs[a] = a === 'src' && v.startsWith('data:') ? `data:${v.length}:${v.slice(-24)}` : v;
        }
        if (Object.keys(attrs).length) node.attrs = attrs;
        const name = attrs['aria-label'] || (component && component.name) || (classes[0] && classes.find(c => !/--/.test(c))) || (LANDMARK.test(tag) ? tag : null);
        if (name) node.name = name;
        node.style = {};
        for (const k of STYLE) node.style[k] = cs.getPropertyValue(k);
        node.box = boxOf(r);
        const kids = [];
        const childNodes = n.shadowRoot ? [...n.shadowRoot.childNodes, ...n.childNodes] : n.childNodes;
        for (const c of childNodes) {
            const k = walk(c);
            if (k) kids.push(k);
        }
        if (kids.length) node.children = kids;
        return node;
    };

    const root = walk(document.body) || { tag: 'body', style: {}, box: [0, 0, 0, 0] };
    return {
        version: 1,
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        root,
    };
}
