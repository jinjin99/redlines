// Runs inside the page (serialized by page.evaluate: nothing from outside its body). The page as one
// standalone HTML file anyone can open and edit: its markup as rendered (form values included, scripts
// out), every stylesheet it could read inlined, same-origin images inlined as data URLs, other URLs
// made absolute. It shows the page as it was, without running the app.
export async function freeze(): Promise<string> {
    const abs = (u: string) => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
    const fixUrls = (css: string, base: string) => css.replace(/url\(\s*(['"]?)(?!data:|#)([^'")]+)\1\s*\)/g, (m: string, _q: string, u: string) => { try { return `url("${new URL(u, base).href}")`; } catch { return m; } });

    const css: string[] = [], links: string[] = [];
    const sheetText = (sheet: CSSStyleSheet) => {
        try { return fixUrls(Array.from(sheet.cssRules).map(r => r.cssText).join('\n'), sheet.href || document.baseURI); } catch { return null; }
    };
    for (const sheet of Array.from(document.styleSheets)) {
        const text = sheetText(sheet);
        if (text !== null) css.push(text);
        else if (sheet.href) links.push(sheet.href); // cross-origin: not readable, linked instead
    }
    for (const sheet of document.adoptedStyleSheets || []) { const text = sheetText(sheet); if (text) css.push(text); }

    // Data URLs for same-origin images, so the file opens without the app's server.
    const inline = new Map<string, string>();
    await Promise.all(Array.from(document.images).map(async img => {
        const src = img.currentSrc || img.src;
        if (!src || src.startsWith('data:') || inline.has(src) || new URL(src).origin !== location.origin) return;
        try {
            const blob = await (await fetch(src)).blob();
            if (blob.size > 2e6) return;
            inline.set(src, await new Promise<string>(r => { const f = new FileReader(); f.onload = () => r(String(f.result)); f.readAsDataURL(blob); }));
        } catch {}
    }));

    const clone = document.body.cloneNode(true) as HTMLElement;
    // What lives in properties, not attributes: typed values, ticks, choices, scroll offsets are lost.
    const live = Array.from(document.body.querySelectorAll<HTMLInputElement>('input, textarea, select'));
    const copies = Array.from(clone.querySelectorAll<HTMLElement>('input, textarea, select'));
    live.forEach((el, i) => {
        const c = copies[i];
        if (!c) return;
        if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
        else if (el.tagName === 'TEXTAREA') c.textContent = el.value;
        else if (el.tagName === 'SELECT') Array.from((c as HTMLSelectElement).options).forEach((o, j) => ((el as unknown as HTMLSelectElement).options[j]?.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected')));
        else if (el.value) c.setAttribute('value', el.value);
    });
    // Canvases draw from script: their picture as an image.
    const canvases = Array.from(document.body.querySelectorAll('canvas'));
    Array.from(clone.querySelectorAll('canvas')).forEach((c, i) => {
        try {
            const img = document.createElement('img');
            img.src = canvases[i].toDataURL();
            for (const a of ['class', 'style', 'width', 'height']) { const v = c.getAttribute(a); if (v !== null) img.setAttribute(a, v); }
            c.replaceWith(img);
        } catch {}
    });
    clone.querySelectorAll('script, noscript, template, iframe').forEach(n => n.remove());
    clone.querySelectorAll('*').forEach(n => {
        for (const a of Array.from(n.attributes)) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        if (n.hasAttribute('src')) { const s = abs(n.getAttribute('src') ?? ''); n.setAttribute('src', inline.get(s) ?? s); }
        if (n.hasAttribute('srcset')) n.removeAttribute('srcset');
        const href = n.getAttribute('href');
        if (n.tagName === 'A' && href && !href.startsWith('#')) n.setAttribute('href', abs(href));
        const style = n.getAttribute('style');
        if (style) n.setAttribute('style', fixUrls(style, document.baseURI));
    });

    const attrs = (el: Element) => Array.from(el.attributes).filter(a => !/^on/i.test(a.name)).map(a => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    const esc = (s: string) => s.replace(/<\/style/gi, '<\\/style');
    return `<!doctype html>
<html${attrs(document.documentElement)}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${(document.title || 'Page').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</title>
${links.map(h => `<link rel="stylesheet" href="${h.replace(/"/g, '&quot;')}">`).join('\n')}
<style>
${esc(css.join('\n'))}
</style>
</head>
<body${attrs(document.body)}>
${clone.innerHTML}
</body>
</html>
`;
}
