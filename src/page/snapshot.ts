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
// (The types are src/types.ts: PageTree, TreeElement, TreeText.)
import type { Box, PageTree, TreeElement, TreeNode } from '../types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- React's fibers are its internals, read as they are. */
type Fiber = any;

export function snapshot(opts: { styleKeys?: string[]; ignore?: string | null } = {}): PageTree {
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
    const ignored = new Set<Element>(opts.ignore ? Array.from(document.querySelectorAll(opts.ignore)) : []);
    const sx = window.scrollX, sy = window.scrollY;
    const boxOf = (r: DOMRect): Box => [Math.round(r.left + sx), Math.round(r.top + sy), Math.round(r.width), Math.round(r.height)];

    // A class a person can read (card, MuiButton-root, nav__item), not a build's hash (css-1x2y3z, _a8f3k).
    const readable = (c: string) => c.length <= 48 && /^[A-Za-z][A-Za-z-_]*[A-Za-z]$/.test(c) && /[aeiou]/i.test(c) && !/^(css|sc|jsx|emotion)-/.test(c);

    // React, when the page uses it: the component whose whole output an element is.
    const fiberKey = (el: Element) => Object.keys(el).find(k => k.startsWith('__reactFiber$'));
    const current = new Set<Fiber>();
    (function collect() {
        const roots: Element[] = [document.body, ...Array.from(document.body.querySelectorAll(':scope > *, :scope > * > *'))];
        for (const el of roots) {
            const k = Object.keys(el).find(x => x.startsWith('__reactContainer$'));
            const container = k ? (el as any)[k] : null;
            const root = container && container.stateNode && container.stateNode.current;
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
    const live = (f: Fiber): Fiber => (f && !current.has(f) && f.alternate && current.has(f.alternate) ? f.alternate : f);
    const nameOfType = (t: any): string | null => {
        if (!t || typeof t === 'string') return null;
        return t.displayName || t.name || (t.render && (t.render.displayName || t.render.name)) || (t.type && nameOfType(t.type)) || null;
    };
    // A production build renames components to two or three characters (Sa, Jye, NEe), differently
    // from one build to the next: such a name says nothing and would make every build look changed.
    // Short names that are words a component is called stay.
    const SHORT = new Set(['Box', 'Tag', 'App', 'Nav', 'Row', 'Col', 'Tab', 'Map', 'Bar', 'Pin', 'Dot', 'Fab', 'Img', 'Svg', 'Key']);
    const goodName = (n: string | null): n is string =>
        !!n && /^[A-Z][A-Za-z0-9]+$/.test(n) && (n.length > 3 || SHORT.has(n)) && !/(Provider|Consumer|Context|Boundary|Suspense|Fragment|Router|Route|Switch|Portal)$/.test(n);
    const hostRoots = (f: Fiber, acc: Fiber[]): Fiber[] => {
        for (let c = f.child; c; c = c.sibling) {
            if (c.tag === 5 || c.tag === 6) acc.push(c);
            else if (c.tag !== 4) hostRoots(c, acc);
            if (acc.length > 1) break;
        }
        return acc;
    };
    const plainProps = (props: Record<string, unknown> | null) => {
        const out: Record<string, string | number | boolean> = {};
        let n = 0;
        const all = props ?? {};
        for (const k of Object.keys(all)) {
            const v = all[k];
            if (k === 'children' || k === 'key' || k === 'ref' || k === 'className' || k === 'style' || k === 'id' || /^(on[A-Z]|data-|aria-)/.test(k)) continue;
            // An id React makes up on each render (useId: ":r1a:", ":R6dr6mim:", "«r1»"): different every load, nothing a person sees.
            if (typeof v === 'string' && /:[rR][0-9a-zA-Z]*:|«r[0-9a-z]+»/.test(v)) continue;
            if (typeof v === 'string' ? v.length <= 80 : typeof v === 'number' || typeof v === 'boolean') {
                out[k] = v as string | number | boolean;
                if (++n >= 8) break;
            }
        }
        return out;
    };
    const componentOf = (el: Element): TreeElement['component'] | null => {
        const k = fiberKey(el);
        const f = k && live((el as any)[k]);
        if (!f) return null;
        let best: TreeElement['component'] | null = null;
        for (let p = live(f.return); p && p.tag !== 5 && p.tag !== 3 && p.tag !== 4; p = live(p.return)) {
            const roots = hostRoots(p, []);
            if (roots.length !== 1 || roots[0] !== f) break;
            const name = nameOfType(p.elementType || p.type);
            if (goodName(name)) best = { name, props: plainProps(p.memoizedProps) };
        }
        return best;
    };

    const unseen = (cs: CSSStyleDeclaration, r: DOMRect) =>
        cs.visibility !== 'visible' || cs.opacity === '0' ||
        ((cs.position === 'absolute' || cs.position === 'fixed') && (r.width * r.height <= 1 || cs.clip !== 'auto' || r.right <= 0 || r.bottom <= 0));

    const walk = (n: Node): TreeNode | null => {
        if (n.nodeType === 3) {
            const text = (n.nodeValue ?? '').replace(/\s+/g, ' ').trim();
            if (!text) return null;
            const range = document.createRange();
            range.selectNodeContents(n);
            const r = range.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) return null;
            return { text, box: boxOf(r) };
        }
        if (n.nodeType !== 1) return null;
        const e = n as HTMLElement;
        if (SKIP.test(e.tagName) || ignored.has(e)) return null;
        const cs = getComputedStyle(e);
        if (cs.display === 'none') return null;
        const r = e.getBoundingClientRect();
        if (unseen(cs, r) && !e.querySelector('[style*="visibility: visible"]')) return null;
        const tag = e.tagName.toLowerCase();
        const node: TreeElement = { tag, style: {}, box: [0, 0, 0, 0] };
        const component = componentOf(e);
        if (component) node.component = component;
        const classes = Array.from(e.classList).filter(readable);
        if (classes.length) node.classes = classes;
        const attrs: Record<string, string> = {};
        for (const a of ATTRS) {
            if (a === 'value' && (tag === 'input' || tag === 'textarea' || tag === 'select')) { const v = (e as HTMLInputElement).value; if (v) attrs.value = String(v); continue; }
            if (a === 'checked' && tag === 'input') { if ((e as HTMLInputElement).checked) attrs.checked = 'true'; continue; }
            const v = e.getAttribute(a);
            if (v != null) attrs[a] = a === 'src' && v.startsWith('data:') ? `data:${v.length}:${v.slice(-24)}` : v;
        }
        if (Object.keys(attrs).length) node.attrs = attrs;
        const name = attrs['aria-label'] || (component && component.name) || (classes[0] && classes.find(c => !/--/.test(c))) || (LANDMARK.test(tag) ? tag : null);
        if (name) node.name = name;
        node.style = {};
        for (const k of STYLE) node.style[k] = cs.getPropertyValue(k);
        node.box = boxOf(r);
        const kids: TreeNode[] = [];
        const childNodes = e.shadowRoot ? [...Array.from(e.shadowRoot.childNodes), ...Array.from(e.childNodes)] : Array.from(e.childNodes);
        for (const c of childNodes) {
            const k = walk(c);
            if (k) kids.push(k);
        }
        if (kids.length) node.children = kids;
        return node;
    };

    const root = (walk(document.body) as TreeElement | null) ?? { tag: 'body', style: {}, box: [0, 0, 0, 0] };
    return {
        version: 1,
        url: location.href,
        title: document.title,
        viewport: { width: innerWidth, height: innerHeight },
        size: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
        root,
    };
}
