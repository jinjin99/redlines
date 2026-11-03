// A Chromium to drive: playwright-core's own browser when it is installed, else the newest one in
// Playwright's cache, else REDLINES_CHROME (any Chrome or Chromium executable).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function launch() {
    let chromium;
    try {
        ({ chromium } = await import('playwright-core'));
    } catch {
        throw new Error('redlines needs playwright-core: npm install playwright-core');
    }
    if (process.env.REDLINES_CHROME) return chromium.launch({ executablePath: process.env.REDLINES_CHROME });
    try {
        return await chromium.launch();
    } catch (error) {
        const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || (process.platform === 'darwin' ? path.join(os.homedir(), 'Library/Caches/ms-playwright') : process.platform === 'win32' ? path.join(os.homedir(), 'AppData/Local/ms-playwright') : path.join(os.homedir(), '.cache/ms-playwright'));
        const builds = fs.existsSync(cache) ? fs.readdirSync(cache).filter(d => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9))) : [];
        const apps = [
            'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
            'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
            'chrome-linux64/chrome',
            'chrome-linux/chrome',
            'chrome-win64/chrome.exe',
            'chrome-win/chrome.exe',
        ];
        for (const b of builds) for (const a of apps) if (fs.existsSync(path.join(cache, b, a))) return chromium.launch({ executablePath: path.join(cache, b, a) });
        throw new Error(`No Chromium to run (${error.message.split('\n')[0]}).\nInstall one: npx playwright-core install chromium, or set REDLINES_CHROME to a Chrome executable.`);
    }
}
