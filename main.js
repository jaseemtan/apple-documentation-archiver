import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import fs from "fs-extra";
import path from "path";
import mime from "mime-types";
import { URL } from "url";

const START_URL = "https://developer.apple.com/library/archive/documentation/GraphicsImaging/Conceptual/drawingwithquartz2d/Introduction/Introduction.html";
const OUTPUT_DIR = "./offline";
const ALLOWED_ORIGIN = "https://developer.apple.com";
const ALLOWED_PATH_PREFIX = "/library/archive/documentation";
const STATE_FILE = path.join(OUTPUT_DIR, ".crawl-state.json");
var visitedPages = new Set();
const downloadedAssets = new Map();

if (await fs.pathExists(STATE_FILE)) {
    const saved = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    visitedPages = new Set(saved.visitedPages);
}

function sanitizePath(p) {
    return p.replace(/[^a-zA-Z0-9._/-]/g, "_");
}

function localPathForUrl(url) {
    const u = new URL(url);
    let p = u.pathname;
    if (p.endsWith("/")) p += "index.html";
    if (!path.extname(p)) p += ".html";
    return sanitizePath(path.join(u.hostname, p));
}

async function downloadAsset(url) {
    if (downloadedAssets.has(url)) return downloadedAssets.get(url);

    const res = await fetch(url);
    if (!res.ok) return null;

    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const type = res.headers.get("content-type");
    const ext = mime.extension(type) || "bin";
    const u = new URL(url);
    const filename = sanitizePath(path.join(u.hostname, u.pathname)) +
        (path.extname(u.pathname) ? "" : "." + ext);
    const fullPath = path.join(OUTPUT_DIR, filename);
    if (!(await fs.pathExists(fullPath))) {
        await fs.ensureDir(path.dirname(fullPath));
        await fs.writeFile(fullPath, buffer);
        console.log(url);
    } else {
        console.log("Skipping " + url);
    }
    downloadedAssets.set(url, filename);
    return filename;
}

async function processPage(url) {
    // if (visitedPages.has(url)) return;
    
    visitedPages.add(url);
    const res = await fetch(url);
    if (!res.ok) return;

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;
    const baseUrl = new URL(url);

    async function rewriteAttr(el, attr) {
        const value = el.getAttribute(attr);
        if (!value) return;

        try {
            const absolute = new URL(value, baseUrl).href;
            const local = await downloadAsset(absolute);
            if (local) el.setAttribute(attr, local);
        } catch { }
    }

    for (const el of document.querySelectorAll("img[src], script[src], link[href]")) {
        const attr = el.tagName === "LINK" ? "href" : "src";
        await rewriteAttr(el, attr);
    }
    for (const a of document.querySelectorAll("a[href]")) {
        try {
            const absolute = new URL(a.getAttribute("href"), baseUrl);
            const isAllowed = absolute.origin === ALLOWED_ORIGIN &&
                absolute.pathname.startsWith(ALLOWED_PATH_PREFIX);
            if (!isAllowed) {
                continue;
            }
            const local = localPathForUrl(absolute.href);
            a.setAttribute("href", local);
            await processPage(absolute.href);
        } catch { }
    }
    const localPath = path.join(OUTPUT_DIR, localPathForUrl(url));
    if (!(await fs.pathExists(localPath))) {
        await fs.ensureDir(path.dirname(localPath));
        await fs.writeFile(
            localPath,
            "<!DOCTYPE html>\n" + document.documentElement.outerHTML
        );
        console.log(url);
    } else {
        console.log("Skipping " + url);
    }
    await fs.writeJson(STATE_FILE, {
        visitedPages: [...visitedPages]
    });
}

(async () => {
    await fs.ensureDir(OUTPUT_DIR);
    await processPage(START_URL);
    console.log("Offline site saved to", OUTPUT_DIR);
})();
