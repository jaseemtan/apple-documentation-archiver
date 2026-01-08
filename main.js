// Script to download Apple Documentation Archive for offline viewing.
// Run the program using:
//   $ node main.js
// To fetching a specific page and linked resources the link can be specified
// as command line arg. It takes a single url or multiple comma separated urls.
//   $ node main.js https://url, https://url2
// If url is not specified, it takes the one in the program.
//
// Thu 08 Jan 26 - Jaseem V V

import fetch from "node-fetch";
import { JSDOM } from "jsdom";
import fs from "fs-extra";
import path from "path";
import mime from "mime-types";
import { URL } from "url";

const DEFAULT_START_URLS = JSON.parse(
    fs.readFileSync(new URL("./urls.json", import.meta.url), "utf-8")
).urls;
const START_URLS = process.argv[2] ? process.argv[2].split(",") : DEFAULT_START_URLS;
const OUTPUT_DIR = "./offline";

try {
    new URL(START_URLS);
} catch {
    console.error("Invalid URL: ", START_URLS);
    process.exit(1);
}

const ALLOWED_ORIGIN = "https://developer.apple.com";
const ALLOWED_PATH_PREFIXES = [
    "/library/archive/"
];
const STATE_FILE = path.join(OUTPUT_DIR, ".crawl-state.json");
const FETCH_DELAY_MS = 300;  // change to 0 to disable
var visitedPages = new Set();
const downloadedAssets = new Map();

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

if (await fs.pathExists(STATE_FILE)) {
    const saved = JSON.parse(await fs.readFile(STATE_FILE, "utf8"));
    visitedPages = new Set(saved.visitedPages);
}

// Remove URL fragment from links
function canonicalize(url) {
    const u = new URL(url);
    u.hash = "";
    return u.href;
}

// Replace chars not specified by the regex with _.
function sanitizePath(p) {
    return p.replace(/[^a-zA-Z0-9._/-]/g, "_");
}

// Get a clean local path from url.
function localPathForUrl(url) {
    const u = new URL(url);
    let p = u.pathname;
    if (p.endsWith("/")) p += "index.html";  // Directory, append .index.html
    if (!path.extname(p)) p += ".html";  // No file extension, add .html
    return sanitizePath(path.join(u.hostname, p));
}

function isHtmlContentType(type) {
    if (!type) return false;
    return type.includes("text/html");
}

// Download assets. Can be js, css, another html page.
async function downloadAsset(url) {
    if (downloadedAssets.has(url)) return downloadedAssets.get(url);

    if (FETCH_DELAY_MS > 0) {
        await sleep(FETCH_DELAY_MS);
    }
    const res = await fetch(url);
    if (!res.ok) return null;
    
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const type = res.headers.get("content-type");
    const ext = mime.extension(type) || "bin";
    const u = new URL(url);
    const filename = sanitizePath(
        path.join(u.hostname, u.pathname)) +
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

// Process the given url.
// Fetches the html pages, extracts links. If it's assets, download them. If
// it's html page process the page recursively.
// All asset path will be updates to point to local.
// Fetched urls are cached to prevent refetch.
async function processPage(url) {
    if (visitedPages.has(url)) return;  // comment this to fetch irrespective of cache.

    const canonicalUrl = canonicalize(url);
    if (visitedPages.has(canonicalUrl)) return;
    visitedPages.add(canonicalUrl);

    if (FETCH_DELAY_MS > 0) {
        await sleep(FETCH_DELAY_MS);
    }

    const res = await fetch(url);
    if (!res.ok) return;

    const html = await res.text();
    const dom = new JSDOM(html, { url });
    const document = dom.window.document;
    const baseUrl = new URL(url);
    const pageLocalPath = path.join(OUTPUT_DIR, localPathForUrl(url));

    async function rewriteAttr(el, attr) {
        const value = el.getAttribute(attr);
        if (!value) return;

        try {
            const absolute = new URL(value, baseUrl).href;
            const assetLocal = await downloadAsset(absolute);
            if (!assetLocal) return;

            const assetFullPath = path.join(OUTPUT_DIR, assetLocal);
            const relative = path.relative(
                path.dirname(pageLocalPath),
                assetFullPath
            );
            el.setAttribute(attr, relative);
        } catch(e) {
            console.log("error: rewriteAttr: %o", e);
        }
    }

    for (const meta of document.querySelectorAll('meta[name="book-json"][content]')) {
        const value = meta.getAttribute("content");
        if (!value) continue;

        try {
            const absolute = new URL(value, baseUrl).href;
            const result = await downloadAsset(absolute);
            if (!result) continue;

            const assetFullPath = path.join(OUTPUT_DIR, result);
            const relative = path.relative(
                path.dirname(pageLocalPath),
                assetFullPath
            );
            meta.setAttribute("content", relative);

            // Download sample code zip if present.
            if (result.endsWith("book.json")) {
                const jsonText = await fs.readFile(assetFullPath, "utf8");
                const bookJson = JSON.parse(jsonText);
                if (bookJson.sampleCode) {
                    const sampleZipUrl = new URL(
                        bookJson.sampleCode,
                        absolute
                    ).href;
                    await downloadAsset(sampleZipUrl);
                }
            }
        } catch(e) {
            console.error("error: book-json: %o", e);
        }
    }

    for (const el of document.querySelectorAll("img[src], script[src], link[href]")) {
        const attr = el.tagName === "LINK" ? "href" : "src";
        await rewriteAttr(el, attr);
    }

    for (const a of document.querySelectorAll("a[href]")) {
        const href = a.getAttribute("href");
        if (!href) continue;

        try {
            const absolute = new URL(href, baseUrl);

            const isAllowed =
                absolute.origin === ALLOWED_ORIGIN &&
                ALLOWED_PATH_PREFIXES.some(prefix =>
                    absolute.pathname.startsWith(prefix)
                );

            if (!isAllowed) continue;

            if (FETCH_DELAY_MS > 0) {
                await sleep(FETCH_DELAY_MS);
            }

            const res = await fetch(absolute.href, { method: "HEAD" });
            if (!res.ok) continue;

            const contentType = res.headers.get("content-type");

            // Non HTML content like zip, pdf, etc.
            if (!isHtmlContentType(contentType)) {
                const assetLocal = await downloadAsset(absolute.href);
                if (!assetLocal) continue;

                const assetFullPath = path.join(OUTPUT_DIR, assetLocal);
                const relative = path.relative(
                    path.dirname(pageLocalPath),
                    assetFullPath
                );

                a.setAttribute("href", relative);
                continue;
            }

            // HTML content
            const canonical = canonicalize(absolute.href);
            a.setAttribute("href", localPathForUrl(canonical));

            if (!visitedPages.has(canonical)) {
                await processPage(absolute.href);
            }
        } catch {}
    }

    if (!(await fs.pathExists(pageLocalPath))) {
        await fs.ensureDir(path.dirname(pageLocalPath));
        await fs.writeFile(
            pageLocalPath,
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
    const startTime = new Date();
    console.log("Crawl started at:", startTime.toLocaleString());
    await fs.ensureDir(OUTPUT_DIR);
    const queue = [...START_URLS];
    while (queue.length > 0) {
        const url = queue.shift();
        await processPage(url);
    }
    const endTime = new Date();
    const durationMinutes = (endTime - startTime) / (1000 * 60);
    console.log("Crawl finished at:", endTime.toLocaleString());
    console.log("Offline site saved to", OUTPUT_DIR);
    console.log("Total duration (mins):", durationMinutes.toFixed(2));
})();

/* Helper scripts */

/*

Get all links from the current page. Execute in dev tools console after the page
has been loaded and the table of content is displayed if present.

var links = new Set();

document.querySelectorAll("a[href]").forEach(a => {
  try {
    const url = new URL(a.getAttribute("href"), window.location.href);
    url.hash = "";  // remove fragment
    links.add(url.href);
  } catch () {}
});

console.log([...links]);

*/

/*
 
Copy dynamically appended body contents from the archive's main page. Run this
in chrome dev console.

copy(document.body.innerHTML.replace(/\n/g, ""))

*/
