// Runs inside the page (serialized by page.evaluate: nothing from outside its body). The page as one
// standalone HTML file anyone can open and edit: its markup as rendered (form values included, scripts
// out), every stylesheet it could read inlined, same-origin images inlined as data URLs, other URLs
// made absolute. It shows the page as it was, without running the app.
export async function freeze() {
    const abs = u => { try { return new URL(u, document.baseURI).href; } catch { return u; } };
    const fixUrls = (css, base) => css.replace(/url\(\s*(['"]?)(?!data:|#)([^'")]+)\1\s*\)/g, (m, q, u) => { try { return `url("${new URL(u, base).href}")`; } catch { return m; } });

    const css = [], links = [];
    const sheetText = sheet => {
        try { return fixUrls([...sheet.cssRules].map(r => r.cssText).join('\n'), sheet.href || document.baseURI); } catch { return null; }
    };
    for (const sheet of document.styleSheets) {
        const text = sheetText(sheet);
        if (text !== null) css.push(text);
        else if (sheet.href) links.push(sheet.href); // cross-origin: not readable, linked instead
    }
    for (const sheet of document.adoptedStyleSheets || []) { const text = sheetText(sheet); if (text) css.push(text); }

    // Data URLs for same-origin images, so the file opens without the app's server.
    const inline = new Map();
    await Promise.all([...document.images].map(async img => {
        const src = img.currentSrc || img.src;
        if (!src || src.startsWith('data:') || inline.has(src) || new URL(src).origin !== location.origin) return;
        try {
            const blob = await (await fetch(src)).blob();
            if (blob.size > 2e6) return;
            inline.set(src, await new Promise(r => { const f = new FileReader(); f.onload = () => r(f.result); f.readAsDataURL(blob); }));
        } catch {}
    }));

    const clone = document.body.cloneNode(true);
    // What lives in properties, not attributes: typed values, ticks, choices, scroll offsets are lost.
    const live = [...document.body.querySelectorAll('input, textarea, select')];
    const copies = [...clone.querySelectorAll('input, textarea, select')];
    live.forEach((el, i) => {
        const c = copies[i];
        if (!c) return;
        if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) c.setAttribute('checked', ''); else c.removeAttribute('checked'); }
        else if (el.tagName === 'TEXTAREA') c.textContent = el.value;
        else if (el.tagName === 'SELECT') [...c.options].forEach((o, j) => (el.options[j]?.selected ? o.setAttribute('selected', '') : o.removeAttribute('selected')));
        else if (el.value) c.setAttribute('value', el.value);
    });
    // Canvases draw from script: their picture as an image.
    const canvases = [...document.body.querySelectorAll('canvas')];
    [...clone.querySelectorAll('canvas')].forEach((c, i) => {
        try {
            const img = document.createElement('img');
            img.src = canvases[i].toDataURL();
            for (const a of ['class', 'style', 'width', 'height']) if (c.hasAttribute(a)) img.setAttribute(a, c.getAttribute(a));
            c.replaceWith(img);
        } catch {}
    });
    clone.querySelectorAll('script, noscript, template, iframe').forEach(n => n.remove());
    clone.querySelectorAll('*').forEach(n => {
        for (const a of [...n.attributes]) if (/^on/i.test(a.name)) n.removeAttribute(a.name);
        if (n.hasAttribute('src')) { const s = abs(n.getAttribute('src')); n.setAttribute('src', inline.get(s) ?? s); }
        if (n.hasAttribute('srcset')) n.removeAttribute('srcset');
        if (n.tagName === 'A' && n.hasAttribute('href') && !n.getAttribute('href').startsWith('#')) n.setAttribute('href', abs(n.getAttribute('href')));
        if (n.hasAttribute('style')) n.setAttribute('style', fixUrls(n.getAttribute('style'), document.baseURI));
    });

    const attrs = el => [...el.attributes].filter(a => !/^on/i.test(a.name)).map(a => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`).join('');
    const esc = s => s.replace(/<\/style/gi, '<\\/style');
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
