import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { rejectUntrustedRequest } from "../com.github.copilot/extensions/concert-playlist-canvas/http-security.mjs";
import { loadSetlistSource, searchArtists } from "../com.github.copilot/extensions/concert-playlist-canvas/setlist.mjs";

const artistMbid = "2b1c601f-4c4c-4654-959e-2d243a4d4eab";
const now = new Date("2026-11-13T10:00:00Z");

function show(id, eventDate, titles, tour = "Tournée actuelle") {
    return {
        id,
        eventDate,
        artist: { name: "Artiste exemple" },
        tour: tour ? { name: tour } : undefined,
        venue: { id: `venue-${id}`, name: `Salle ${id}` },
        url: `https://www.setlist.fm/setlist/example/2026/venue-${id}.html`,
        sets: { set: [{ song: titles.map((title) => typeof title === "string" ? { name: title } : title) }] },
    };
}

function fakeApi(pages) {
    const calls = [];
    const fetchImpl = async (url) => {
        const page = Number(new URL(url).searchParams.get("p"));
        calls.push(page);
        const payload = pages[page - 1];
        assert.ok(payload, `Unexpected page ${page}`);
        return new Response(JSON.stringify(payload), { status: 200 });
    };
    return { fetchImpl, calls };
}

function search(fetchImpl, options = {}) {
    return loadSetlistSource({
        artistMbid,
        requestedArtist: "Artiste exemple",
        apiKey: "test-key",
        now,
        fetchImpl,
        ...options,
    });
}

test("plugin marketplace manifest points to the packaged canvas", async () => {
    const plugin = JSON.parse(await readFile(new URL("../plugin.json", import.meta.url), "utf8"));
    const marketplace = JSON.parse(await readFile(new URL("../.github/plugin/marketplace.json", import.meta.url), "utf8"));

    assert.equal(plugin.name, "concert-playlist");
    assert.equal(plugin.$schema, "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json");
    assert.equal(marketplace.name, "concert-tools");
    assert.equal(marketplace.plugins.length, 1);
    assert.equal(marketplace.plugins[0].name, plugin.name);
    assert.equal(marketplace.plugins[0].version, plugin.version);
    assert.equal(marketplace.plugins[0].source, ".");
    await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
});

test("artist search returns selectable MusicBrainz IDs and disambiguation", async () => {
    let requested;
    const fetchImpl = async (url, options) => {
        requested = new URL(url);
        assert.equal(options.headers["x-api-key"], "test-key");
        return { ok: true, json: async () => ({
            total: 2,
            artist: [
                { mbid: artistMbid, name: "Artiste exemple", disambiguation: "Groupe belge" },
                { mbid: "b10bbbfc-cf9e-42e0-be17-e2c3e1d2600d", name: "Artiste exemple", disambiguation: "Autre groupe" },
            ],
        }) };
    };
    const result = await searchArtists({ name: "  Artiste & exemple  ", apiKey: "test-key", fetchImpl });
    assert.equal(requested.searchParams.get("artistName"), "Artiste & exemple");
    assert.equal(requested.searchParams.get("sort"), "relevance");
    assert.equal(result.artists.length, 2);
    assert.equal(result.artists[0].mbid, artistMbid);
    assert.equal(result.artists[1].disambiguation, "Autre groupe");
    assert.deepEqual(await searchArtists({ name: "Absent", apiKey: "test-key", fetchImpl: async () => ({ status: 404 }) }), { artists: [], total: 0 });
    await assert.rejects(() => searchArtists({ name: " ", apiKey: "test-key", fetchImpl }), /1 and 200/);
    await assert.rejects(() => searchArtists({ name: "Test", apiKey: "test-key", fetchImpl: async () => ({ status: 429, ok: false }) }), /429/);
});

test("artist selection supplies the chosen ID and ignores stale searches", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    assert.match(html, /<html lang="en">/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const elements = new Map();
    function element() {
        return {
            value: "", children: [], handlers: {}, disabled: false,
            addEventListener(name, fn) { this.handlers[name] = fn; },
            replaceChildren(...items) { this.children = items; },
            append(...items) { this.children.push(...items); },
        };
    }
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
    };
    let resolveSearch;
    const context = {
        document: { querySelectorAll: () => [], querySelector: get, createElement: element },
        Option: function (label, value) { this.label = label; this.value = value; },
        fetch: () => new Promise((resolve) => { resolveSearch = resolve; }),
    };
    runInNewContext(`${script}
      globalThis.find = findArtists;
      globalThis.stateRef = state;
      globalThis.loaded = null;
      loadSource = async (criteria) => { globalThis.loaded = criteria; };
    `, context);
    get("#concert-count").value = "5";
    get("#artist-name").value = "Exemple";
    const stale = context.find();
    get("#artist-name").handlers.input();
    resolveSearch({ ok: true, json: async () => ({ artists: [{ mbid: artistMbid, name: "Ancien" }], total: 1 }) });
    await stale;
    assert.equal(context.stateRef.artists.length, 0);
    assert.equal(get("#load-source").disabled, true);

    context.fetch = async () => ({ ok: true, json: async () => ({
        artists: [{ mbid: artistMbid, name: "Exemple", disambiguation: "Groupe" }], total: 1,
    }) });
    await context.find();
    assert.equal(get("#artist-results").hidden, false);
    assert.equal(get("#load-source").disabled, true);
    get("#artist-choice").handlers.change({ target: { value: artistMbid } });
    assert.equal(get("#load-source").disabled, false);
    get("#load-source").handlers.click();
    assert.equal(context.loaded.artistMbid, artistMbid);
    assert.equal(context.loaded.artistName, "Exemple");
    assert.equal(context.loaded.concertCount, 5);
    get("#artist-name").handlers.input();
    assert.equal(get("#load-source").disabled, true);
    assert.equal(context.stateRef.selectedArtist, null);
});

test("the union uses five shows, removes duplicates and tapes, and hides concert order", async () => {
    const api = fakeApi([{
        total: 6,
        itemsPerPage: 20,
        setlist: [
            show("1", "29-10-2026", ["Zulu", "Alpha", "Alpha", { name: "Recorded", tape: true }]),
            show("2", "28-10-2026", ["Bêta"]),
            show("3", "27-10-2026", [{ name: "Echo", cover: { name: "Autre artiste" } }]),
            show("4", "26-10-2026", ["Gamma"]),
            show("5", "25-10-2026", ["Alpha"]),
            show("6", "24-10-2026", ["Exclu"]),
        ],
    }]);
    const result = await search(api.fetchImpl);
    assert.equal(result.source.count, 5);
    assert.deepEqual(result.source.shows.map((show) => show.url),
        ["1", "2", "3", "4", "5"].map((id) => `https://www.setlist.fm/setlist/example/2026/venue-${id}.html`));
    assert.deepEqual(result.songs.map((song) => song.title), ["Alpha", "Bêta", "Echo", "Gamma", "Zulu"]);
    assert.equal(result.songs.find((song) => song.title === "Echo").cover, true);
    assert.equal(result.songs.find((song) => song.title === "Echo").artist, "Artiste exemple");
    assert.equal(result.needsOlderConsent, false);
});

test("concert count boundaries control tour selection and cross-page coverage", async () => {
    const shows = Array.from({ length: 27 }, (_, i) => show(String(i + 1), `${String(29 - i).padStart(2, "0")}-10-2026`, [`Song ${i + 1}`]));
    const minimum = fakeApi([{ total: 27, itemsPerPage: 15, setlist: shows.slice(0, 15) }]);
    const one = await search(minimum.fetchImpl, { concertCount: 1 });
    assert.equal(one.source.count, 1);
    assert.deepEqual(one.songs.map((song) => song.title), ["Song 1"]);
    assert.equal(one.needsOlderConsent, false);
    assert.deepEqual(minimum.calls, [1]);
    const maximum = fakeApi([
        { total: 27, itemsPerPage: 15, setlist: shows.slice(0, 15) },
        { total: 27, itemsPerPage: 15, setlist: shows.slice(15) },
    ]);
    const result = await search(maximum.fetchImpl, { concertCount: 25 });
    assert.equal(result.source.count, 25);
    assert.equal(result.songs.length, 25);
    assert.ok(!result.songs.some((song) => ["Song 26", "Song 27"].includes(song.title)));
    assert.match(result.source.method, /25 concert/);
    assert.equal(result.needsOlderConsent, false);
    assert.deepEqual(maximum.calls, [1, 2]);
    const mixed = shows.slice(0, 6).map((item, index) => index < 2 ? item : { ...item, tour: { name: "Previous tour" } });
    const fallback = await search(fakeApi([{ total: 6, itemsPerPage: 20, setlist: mixed }]).fetchImpl, { concertCount: 3 });
    assert.equal(fallback.source.count, 3);
    assert.match(fallback.source.method, /Most recent/);
    assert.deepEqual(fallback.songs.map((song) => song.title), ["Song 1", "Song 2", "Song 3"]);
});

test("invalid concert counts are rejected before contacting setlist.fm", async () => {
    let calls = 0;
    for (const concertCount of [0, -1, 26, 1.5, NaN, Infinity, null, true, false, "5", "", [], {}]) {
        await assert.rejects(() => search(async () => { calls++; }, { concertCount }), /whole number.*1 and 25/);
    }
    assert.equal(calls, 0);
});

test("setlist endpoint forwards omitted and explicit counts without coercion", async () => {
    const extension = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    const start = extension.indexOf("async function routeApi(");
    const end = extension.indexOf("\nasync function startCanvasServer(", start);
    const shows = Array.from({ length: 25 }, (_, i) => show(String(i), "29-10-2026", [`Song ${i}`]));
    const api = fakeApi([{ total: 25, itemsPerPage: 25, setlist: shows }]);
    const context = {
        process: { env: { SETLISTFM_API_KEY: "test-key" } },
        readJson: async (req) => req.body,
        loadSetlistSource: (options) => loadSetlistSource({ ...options, now, fetchImpl: api.fetchImpl }),
        sendJson: (res, status, body) => { res.status = status; res.body = body; },
    };
    runInNewContext(`${extension.slice(start, end)}\nglobalThis.route = routeApi;`, context);
    const url = new URL("http://127.0.0.1/api/setlists");
    for (const [concertCount, expected] of [[undefined, 5], [1, 1], [25, 25]]) {
        const response = {};
        await context.route({ method: "POST", body: { artistMbid, concertCount } }, response, url);
        assert.equal(response.status, 200);
        assert.equal(response.body.source.count, expected);
    }
    const calls = api.calls.length;
    for (const concertCount of ["5", null, 0, 26, 1.5]) {
        await assert.rejects(() => context.route({ method: "POST", body: { artistMbid, concertCount } }, {}, url), /whole number/);
    }
    assert.equal(api.calls.length, calls);
});

test("custom count retains older and incomplete coverage consent", async () => {
    const api = fakeApi([{ total: 2, itemsPerPage: 20, setlist: [
        show("1", "29-10-2026", ["A"]), show("2", "10-10-2025", ["B"]),
    ] }]);
    const initial = await search(api.fetchImpl, { concertCount: 25 });
    assert.equal(initial.source.count, 1);
    assert.equal(initial.needsOlderConsent, true);
    const expanded = await search(api.fetchImpl, { concertCount: 25, allowOlder: true });
    assert.equal(expanded.source.count, 2);
    assert.equal(expanded.needsOlderConsent, false);
    assert.equal(expanded.needsIncompleteConsent, true);
    const partial = await search(api.fetchImpl, { concertCount: 25, allowOlder: true, acceptIncomplete: true });
    assert.equal(partial.source.count, 2);
    assert.equal(partial.needsIncompleteConsent, false);
    const recentPartial = await search(api.fetchImpl, { concertCount: 25, acceptIncomplete: true });
    assert.equal(recentPartial.source.count, 1);
    assert.equal(recentPartial.needsOlderConsent, false);
});

test("count UI validates, retains retry criteria and discards stale sources without losing artist searches", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    assert.match(html, /id="concert-count"[^>]*type="number"[^>]*min="1"[^>]*max="25"[^>]*step="1"[^>]*value="5"/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    function element(tag = "") {
        return {
            tag, value: "", children: [], handlers: {}, attributes: {}, textContent: "",
            addEventListener(name, fn) { this.handlers[name] = fn; },
            append(...items) { this.children.push(...items); },
            replaceChildren(...items) { this.children = items; },
            setAttribute(name, value) { this.attributes[name] = value; },
        };
    }
    const elements = new Map();
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
    };
    const requests = [];
    const pending = [];
    const context = {
        document: { querySelectorAll: () => [], querySelector: get, createElement: element },
        Option: function (label, value) { this.label = label; this.value = value; },
        fetch: (url, options) => {
            requests.push({ url, body: JSON.parse(options.body) });
            return new Promise((resolve) => pending.push((body) => resolve({ ok: true, json: async () => body })));
        },
    };
    runInNewContext(`${script}\n globalThis.ref = state; globalThis.load = loadSource; globalThis.find = findArtists;`, context);
    get("#concert-count").value = "5";
    get("#artist-name").value = "Example";
    const finding = context.find();
    get("#concert-count").value = "25";
    get("#concert-count").handlers.input();
    pending.shift()({ artists: [{ mbid: artistMbid, name: "Example" }], total: 1 });
    await finding;
    assert.equal(context.ref.artists.length, 1);
    get("#artist-choice").handlers.change({ target: { value: artistMbid } });
    const clickLoad = get("#load-source").handlers.click;
    for (const value of ["", "0", "26", "1.5", "invalid"]) {
        get("#concert-count").value = value;
        get("#concert-count").handlers.input();
        assert.equal(get("#load-source").disabled, true);
        assert.equal(get("#concert-count").attributes["aria-invalid"], "true");
        clickLoad();
        assert.match(get("#concert-count-status").textContent, /whole number/);
    }
    assert.equal(requests.length, 1);
    get("#concert-count").value = "25";
    get("#concert-count").handlers.input();
    assert.equal(get("#load-source").disabled, false);
    clickLoad();
    assert.equal(requests.at(-1).body.concertCount, 25);
    const source = {
        artist: "Example", songs: [], source: { count: 2, shows: [], method: "Recent", period: "Year" },
        needsOlderConsent: true,
    };
    pending.shift()(source);
    await new Promise(setImmediate);
    const root = get("#source-result");
    assert.ok(root.children.some((item) => /Fewer than 25/.test(item.textContent)));
    root.children.find((item) => item.textContent === "Search older concerts").handlers.click();
    assert.equal(requests.at(-1).body.concertCount, 25);
    assert.equal(requests.at(-1).body.allowOlder, true);
    pending.shift()({ ...source, needsOlderConsent: false, needsIncompleteConsent: true });
    await new Promise(setImmediate);
    assert.ok(root.children.some((item) => /Fewer than 25.*expanding/.test(item.textContent)));
    root.children.find((item) => /Continue with 2/.test(item.textContent)).handlers.click();
    assert.equal(requests.at(-1).body.concertCount, 25);
    assert.equal(requests.at(-1).body.allowOlder, true);
    assert.equal(requests.at(-1).body.acceptIncomplete, true);
    get("#concert-count").value = "1";
    get("#concert-count").handlers.input();
    pending.shift()({ ...source, needsOlderConsent: false });
    await new Promise(setImmediate);
    assert.equal(context.ref.source, null);
    assert.equal(root.children.length, 0);
    assert.equal(context.ref.selectedArtist.mbid, artistMbid);
    assert.equal(get("#load-source").disabled, false);
    const current = context.load({ artistMbid, concertCount: 1 });
    pending.shift()({ ...source, needsOlderConsent: false });
    await current;
    assert.equal(context.ref.source.artist, "Example");
    get("#concert-count").value = "5";
    get("#concert-count").handlers.input();
    assert.equal(context.ref.source, null);
    const extension = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    assert.match(extension, /concertCount: body\.concertCount/);
});

test("cover artists survive deduplication and conflicting or missing artists remain unknown", async () => {
    const api = fakeApi([{ total: 3, itemsPerPage: 20, setlist: [
        show("1", "29-10-2026", ["Known", { name: "Conflict", cover: { name: "Original A" } }]),
        show("2", "28-10-2026", [
            { name: "Known", cover: { name: "Original B" } },
            { name: "Conflict", cover: { name: "Original B" } },
            { name: "Unknown", info: "cover" },
            { name: "Self", cover: { name: "Artiste exemple" } },
        ]),
        show("3", "27-10-2026", [{ name: "Conflict", cover: { name: "Original A" } }]),
    ] }]);
    const result = await search(api.fetchImpl);
    const find = (title) => result.songs.find((song) => song.title === title);
    assert.equal(find("Known").cover, true);
    assert.equal(find("Known").coverArtist, "Original B");
    for (const title of ["Conflict", "Unknown", "Self"]) {
        assert.equal(find(title).cover, true);
        assert.equal(find(title).coverArtist, "");
    }
});

test("setlist links reject missing and untrusted URLs", async () => {
    const shows = [
        show("1", "29-10-2026", ["A"]),
        show("2", "28-10-2026", ["B"]),
        show("3", "27-10-2026", ["C"]),
        show("4", "26-10-2026", ["D"]),
        show("5", "25-10-2026", ["E"]),
    ];
    shows[1].url = "javascript:alert(1)";
    shows[2].url = "https://www.setlist.fm.evil.example/setlist/example";
    shows[3].url = "https://www.setlist.fm@evil.example/setlist/example";
    delete shows[4].url;
    const result = await search(fakeApi([{ total: 5, itemsPerPage: 20, setlist: shows }]).fetchImpl);
    assert.deepEqual(result.source.shows.map((show) => show.url), [shows[0].url, null, null, null, null]);
});

test("source displays discreet setlist links with spoiler warnings", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    function element(tag = "") {
        return {
            tag, children: [], attributes: {}, textContent: "",
            append(...items) { this.children.push(...items); },
            replaceChildren(...items) { this.children = items; },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener() {},
        };
    }
    const elements = new Map();
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
    };
    const context = {
        document: { querySelectorAll: () => [], querySelector: get, createElement: element },
    };
    runInNewContext(`${script}\n globalThis.render = renderSource;`, context);
    const shows = Array.from({ length: 5 }, (_, i) => ({
        date: `0${i + 1}-10-2026`, venue: `Venue ${i + 1}`, entries: 3,
        url: `https://www.setlist.fm/setlist/example/2026/venue-${i + 1}.html`,
    }));
    context.render({ source: { count: 5, method: "Recent", period: "Year", shows }, songs: [] }, {});
    const root = get("#source-result");
    const rows = root.children.find((child) => child.tag === "ul").children;
    assert.equal(rows.length, 5);
    for (let i = 0; i < rows.length; i++) {
        const link = rows[i].children[0];
        assert.equal(link.tag, "a");
        assert.equal(link.href, shows[i].url);
        assert.equal(link.target, "_blank");
        assert.equal(link.rel, "noopener noreferrer");
        assert.match(link.attributes["aria-label"], /contains spoilers/);
    }
    assert.ok(root.children.some((child) => /may reveal the running order/.test(child.textContent)));
    shows[0].url = null;
    context.render({ source: { count: 5, method: "Recent", period: "Year", shows }, songs: [] }, {});
    assert.equal(root.children.find((child) => child.tag === "ul").children[0].children[0].textContent, "Link unavailable");
});

test("prefers five current-tour shows even when they span API pages", async () => {
    const api = fakeApi([
        { total: 7, itemsPerPage: 3, setlist: [
            show("1", "29-10-2026", ["A"]),
            show("2", "28-10-2026", ["B"]),
            show("3", "27-10-2026", ["C"], "Autre tournée"),
        ] },
        { total: 7, itemsPerPage: 3, setlist: [
            show("4", "26-10-2026", ["D"]),
            show("5", "25-10-2026", ["E"]),
            show("6", "24-10-2026", ["F"]),
        ] },
    ]);
    const result = await search(api.fetchImpl);
    assert.deepEqual(api.calls, [1, 2]);
    assert.equal(result.source.count, 5);
    assert.match(result.source.method, /Tournée actuelle/);
    assert.deepEqual(result.songs.map((song) => song.title), ["A", "B", "D", "E", "F"]);
});

test("falls back to the five latest shows when the current tour has fewer than five", async () => {
    const api = fakeApi([{ total: 6, itemsPerPage: 20, setlist: [
        show("1", "29-10-2026", ["A"]),
        show("2", "28-10-2026", ["B"]),
        show("3", "27-10-2026", ["C"], "Ancienne tournée"),
        show("4", "26-10-2026", ["D"], "Ancienne tournée"),
        show("5", "25-10-2026", ["E"], "Ancienne tournée"),
        show("6", "24-10-2026", ["F"], "Ancienne tournée"),
    ] }]);
    const result = await search(api.fetchImpl);
    assert.equal(result.source.count, 5);
    assert.match(result.source.method, /Most recent documented concerts/);
    assert.deepEqual(result.songs.map((song) => song.title), ["A", "B", "C", "D", "E"]);
});

test("older shows and incomplete coverage require explicit choices", async () => {
    const api = fakeApi([{ total: 5, itemsPerPage: 20, setlist: [
        show("1", "29-10-2026", ["A"]),
        show("2", "28-10-2026", ["B"]),
        show("3", "12-11-2025", ["C"]),
        show("4", "11-11-2025", ["D"]),
        show("5", "10-11-2025", ["E"]),
    ] }]);
    const initial = await search(api.fetchImpl);
    assert.equal(initial.needsOlderConsent, true);
    assert.equal(initial.source.count, 2);
    assert.deepEqual(initial.songs.map((song) => song.title), ["A", "B"]);
    const expanded = await search(api.fetchImpl, { allowOlder: true });
    assert.equal(expanded.needsOlderConsent, false);
    assert.equal(expanded.source.count, 5);
    const partial = await search(api.fetchImpl, { acceptIncomplete: true });
    assert.equal(partial.needsOlderConsent, false);
    assert.equal(partial.source.count, 2);
});

test("an expanded but incomplete search still asks before continuing", async () => {
    const api = fakeApi([{ total: 1, itemsPerPage: 20, setlist: [show("1", "10-10-2025", ["A"])] }]);
    const expanded = await search(api.fetchImpl, { allowOlder: true });
    assert.equal(expanded.needsIncompleteConsent, true);
    const partial = await search(api.fetchImpl, { allowOlder: true, acceptIncomplete: true });
    assert.equal(partial.needsIncompleteConsent, false);
    assert.equal(partial.source.count, 1);
});

test("ignores future, invalid, duplicate, and empty shows", async () => {
    const api = fakeApi([{ total: 5, itemsPerPage: 20, setlist: [
        show("future", "14-11-2026", ["A"]),
        show("invalid", "31-02-2026", ["B"]),
        show("empty", "29-10-2026", [{ name: "Recorded", tape: true }]),
        show("same", "28-10-2026", ["C"]),
        show("same", "28-10-2026", ["C"]),
    ] }]);
    const result = await search(api.fetchImpl);
    assert.equal(result.source.count, 1);
    assert.deepEqual(result.songs.map((song) => song.title), ["C"]);
    assert.equal(result.needsOlderConsent, true);
});

test("rejects foreign origins, missing POST origins, wrong content types, and rebinding hosts", () => {
    const port = 43822;
    const headers = { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, "content-type": "application/json; charset=utf-8" };
    assert.equal(rejectUntrustedRequest({ method: "POST", headers }, port), null);
    assert.equal(rejectUntrustedRequest({ method: "GET", headers: { host: headers.host } }, port), null);
    assert.equal(rejectUntrustedRequest({ method: "POST", headers: { ...headers, origin: "https://example.invalid" } }, port).status, 403);
    assert.equal(rejectUntrustedRequest({ method: "POST", headers: { ...headers, origin: undefined } }, port).status, 403);
    assert.equal(rejectUntrustedRequest({ method: "POST", headers: { ...headers, origin: "null" } }, port).status, 403);
    assert.equal(rejectUntrustedRequest({ method: "POST", headers: { ...headers, "content-type": "text/plain" } }, port).status, 415);
    assert.equal(rejectUntrustedRequest({ method: "GET", headers: { host: `example.invalid:${port}` } }, port).status, 403);
});

test("Spotify proposals are selected by preparation-wide frequency, with stable ties and manual choices", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const element = { addEventListener() {} };
    const context = { document: { querySelectorAll: () => [], querySelector: () => element } };
    runInNewContext(`${script}\nglobalThis.count = countProposals; globalThis.choose = selectProposal;`, context);
    const a = { id: "a", uri: "spotify:track:a" };
    const b = { id: "b", uri: "spotify:track:b" };
    const c = { id: "c", uri: "spotify:track:c" };
    const entries = [{ matches: [a, b, b] }, { matches: [b, c] }, { matches: [c], error: "failed" }];
    const frequencies = context.count(entries);
    assert.equal(frequencies.get(b.uri), 2);
    assert.equal(frequencies.get(c.uri), 1);
    assert.equal(context.choose(entries[0], frequencies), b);
    assert.equal(context.choose({ matches: [a] }, frequencies), a);
    assert.equal(context.choose({ matches: [a, c] }, frequencies), a);
    assert.equal(context.choose({ matches: [] }, frequencies), null);
    assert.equal(context.choose({ matches: [a], error: "failed" }, frequencies), null);
    assert.equal(context.choose({ matches: [a, b], track: a, manuallyChosen: true }, frequencies), a);
    assert.equal(context.choose({ matches: [a, b], track: null, manuallyChosen: true }, frequencies), null);
});

test("song rows highlight missing results and reveal the search editor only on title activation", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    function element() {
        return {
            children: [], classes: new Set(), handlers: {}, attributes: {},
            classList: { add(value) { this.owner.classes.add(value); } },
            append(...items) { this.children.push(...items); },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(name, handler) { this.handlers[name] = handler; },
            focus() { this.focused = true; },
        };
    }
    const create = () => { const item = element(); item.classList.owner = item; return item; };
    const context = {
        document: { querySelectorAll: () => [], querySelector: create, createElement: create },
        Option: function (label) { this.label = label; },
    };
    runInNewContext(`${script}\nglobalThis.makeRow = makeChoiceRow;`, context);
    const song = { title: "Exemple", artist: "Artiste" };
    const entry = { include: true, track: null, matches: [] };
    const missing = context.makeRow(song, entry);
    assert.ok(missing.classes.has("no-results"));
    assert.ok(missing.children[1].children.some((child) => child.className === "no-results-message"));
    const info = missing.children[1];
    const title = info.children.find((child) => child.className === "song-title");
    const form = info.children.find((child) => child.className === "song-edit");
    const query = form.children[1];
    const search = form.children[2];
    assert.equal(title.textContent, "Exemple");
    assert.equal(title.hidden, false);
    assert.equal(form.hidden, true);
    assert.equal(search.attributes["aria-label"], "Search Spotify");
    title.handlers.click();
    assert.equal(entry.editing, true);
    assert.equal(title.hidden, true);
    assert.equal(form.hidden, false);
    assert.equal(query.focused, true);
    const failed = context.makeRow(song, { include: true, track: null, matches: [], error: "Erreur réseau" });
    assert.equal(failed.classes.has("no-results"), false);
    assert.ok(failed.children[1].children.some((child) => child.textContent === "Erreur réseau"));
});

test("track choices show artwork and preserve manual selection and missing-image fallback", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    function element(tag) {
        const item = {
            tag, children: [], handlers: {}, attributes: {},
            classList: { add() {} },
            append(...items) { this.children.push(...items); },
            replaceChildren(...items) { this.children = items; },
            replaceWith(replacement) { this.replacement = replacement; },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(name, handler) { this.handlers[name] = handler; },
            focus() { this.focused = true; },
        };
        return item;
    }
    const context = {
        document: { querySelectorAll: () => [], querySelector: () => element("div"), createElement: element },
    };
    runInNewContext(`${script}\nupdateSelectionState = () => {}; globalThis.makeRow = makeChoiceRow;`, context);
    const a = { id: "a", title: "Exemple", artists: ["Artiste"], album: "Album A", releaseDate: "2025", image: "https://i.scdn.co/image/a" };
    const b = { id: "b", title: "Exemple", artists: ["Artiste"], album: "Album B", releaseDate: "2024", image: "" };
    const entry = { include: true, track: a, matches: [a, b] };
    const row = context.makeRow({ id: "song", title: "Exemple", artist: "Artiste" }, entry);
    const picker = row.children[1].children.find((child) => child.className === "version-picker");
    const [summary, list] = picker.children;
    assert.equal(summary.children[0].src, a.image);
    assert.equal(list.children[2].children[1].src, a.image);
    assert.match(list.children[3].children[1].className, /placeholder/);
    assert.equal(list.children[2].children[0].checked, true);

    list.children[3].children[0].handlers.change();
    assert.equal(entry.track, b);
    assert.equal(entry.manuallyChosen, true);
    assert.match(summary.children[0].className, /placeholder/);
    assert.match(summary.attributes["aria-label"], /Album B/);
    list.children[1].children[0].handlers.change();
    assert.equal(entry.track, null);
    assert.equal(entry.manuallyChosen, true);
    list.children[2].children[1].handlers.error();
    assert.match(list.children[2].children[1].replacement.className, /placeholder/);
    picker.open = true;
    picker.handlers.keydown({ key: "Escape", preventDefault() {} });
    assert.equal(picker.open, false);
    assert.equal(summary.focused, true);
});

test("preview shows one cover per album instead of repeating it for each track", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    function element(tag) {
        return {
            tag, children: [],
            append(...items) { this.children.push(...items); },
            replaceChildren(...items) { this.children = items; },
            addEventListener() {},
        };
    }
    const root = element("div");
    const continueButton = element("button");
    const context = {
        document: {
            querySelectorAll: () => [],
            querySelector: (selector) => selector === "#playlist-preview" ? root : continueButton,
            createElement: element,
        },
    };
    runInNewContext(`${script}
      globalThis.stateRef = state;
      globalThis.preview = renderPreview;
    `, context);
    const songs = [
        { id: "1", cover: false },
        { id: "2", cover: false },
        { id: "3", cover: false },
    ];
    const makeTrack = (title, album, releaseDate, number, image) => ({
        title, album, releaseDate, track: number, image, disc: 1, artists: ["Artiste"],
    });
    const tracks = [
        makeTrack("Piste A", "Album récent", "2024", 1, "https://i.scdn.co/image/a"),
        makeTrack("Piste B", "Album récent", "2024", 2, "https://i.scdn.co/image/a"),
        makeTrack("Piste C", "Album ancien", "2020", 1, "https://i.scdn.co/image/b"),
    ];
    context.stateRef.source = { songs };
    context.stateRef.choices = new Map(songs.map((song, i) => [song.id, { include: true, track: tracks[i] }]));
    context.preview();
    const albums = root.children.filter((child) => child.className === "album-row");
    const rows = root.children.filter((child) => child.className === "preview-track");
    assert.equal(albums.length, 2);
    assert.deepEqual(albums.map((album) => album.children.filter((child) => child.tag === "img").length), [1, 1]);
    assert.equal(rows.length, 3);
    assert.ok(rows.every((row) => row.children.every((child) => child.tag !== "img")));
    assert.deepEqual(rows.map((row) => row.children[0].textContent), [
        "Piste A — Artiste", "Piste B — Artiste", "Piste C — Artiste",
    ]);
    assert.equal(continueButton.disabled, false);
});

test("editing a title searches only that query, preserves the source title and handles failures", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const element = { addEventListener() {} };
    const context = { document: { querySelectorAll: () => [], querySelector: () => element } };
    runInNewContext(`${script}
      renderChoiceRows = () => {};
      globalThis.retry = researchSong;
      globalThis.setSearch = (fn) => { searchSong = fn; };
    `, context);
    const song = { id: "1", title: "Titre original", artist: "Artiste" };
    const entry = { include: true, track: { id: "old" }, matches: [], manuallyChosen: true };
    let calls = 0;
    let resolveSearch;
    context.setSearch((source, title) => {
        calls++;
        assert.equal(source, song);
        assert.equal(title, "Titre corrigé");
        return new Promise((resolve) => { resolveSearch = resolve; });
    });
    await context.retry(song, entry, "   ");
    assert.equal(calls, 0);
    assert.match(entry.queryError, /1 and 200/);
    const pending = context.retry(song, entry, " Titre corrigé ");
    assert.equal(entry.searching, true);
    await context.retry(song, entry, "Autre titre");
    assert.equal(calls, 1);
    resolveSearch([{ id: "new", uri: "spotify:track:new" }]);
    await pending;
    assert.equal(song.title, "Titre original");
    assert.equal(entry.queryTitle, "Titre corrigé");
    assert.equal(entry.matches[0].id, "new");
    assert.equal(entry.manuallyChosen, false);
    assert.equal(entry.searching, false);
    assert.equal(entry.editing, false);
    context.setSearch(async () => { throw new Error("Échec"); });
    await context.retry(song, entry, "Nouvelle recherche");
    assert.equal(entry.matches.length, 0);
    assert.ok(entry.error);
    assert.equal(entry.searching, false);
    assert.equal(entry.editing, true);
});

test("an empty Spotify search retries without a leading article and rejects unrelated alternatives", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    const element = { addEventListener() {} };
    const calls = [];
    let responses = [
        [],
        [
            { id: "matching", title: "Exemple", artists: ["Artiste"] },
            { id: "wrong-artist", title: "Exemple", artists: ["Autre"] },
            { id: "wrong-version", title: "Exemple Live", artists: ["Artiste"] },
        ],
    ];
    const context = {
        document: { querySelectorAll: () => [], querySelector: () => element },
        fetch: async (url, options) => {
            calls.push(JSON.parse(options.body));
            const tracks = responses.shift();
            return { ok: true, json: async () => ({ tracks }) };
        },
    };
    runInNewContext(`${script}\nglobalThis.search = searchSong;`, context);
    const song = { title: "The Exemple", artist: "Artiste" };
    const result = await context.search(song);
    assert.deepEqual(calls.map((call) => call.title), ["The Exemple", "Exemple"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].id, "matching");
    assert.equal(song.title, "The Exemple");

    calls.length = 0;
    responses = [[{ id: "first", title: "The Exemple", artists: ["Artiste"] }]];
    assert.equal((await context.search(song))[0].id, "first");
    assert.equal(calls.length, 1);

    calls.length = 0;
    responses = [[]];
    assert.equal((await context.search(song, "Exemple")).length, 0);
    assert.equal(calls.length, 1);

    calls.length = 0;
    responses = [[], []];
    assert.equal((await context.search(song)).length, 0);
    assert.equal(calls.length, 2);

    calls.length = 0;
    context.fetch = async () => {
        calls.push("failed");
        return { ok: false, status: 429, json: async () => ({ error: "Limite Spotify" }) };
    };
    await assert.rejects(() => context.search(song), /Limite Spotify/);
    assert.equal(calls.length, 1);
});

test("cover searches use the original artist or title alone, including article retries", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    const element = { addEventListener() {} };
    const calls = [];
    let responses = [];
    const context = {
        document: { querySelectorAll: () => [], querySelector: () => element },
        fetch: async (url, options) => {
            calls.push(JSON.parse(options.body));
            const tracks = responses.shift();
            return { ok: true, json: async () => ({ tracks }) };
        },
    };
    runInNewContext(`${script}\nglobalThis.search = searchSong;`, context);
    const song = { title: "The Example", artist: "Performing Artist", cover: true, coverArtist: "Original Artist" };
    responses = [[], [
        { id: "original", title: "Example", artists: ["Original Artist"] },
        { id: "performer", title: "Example", artists: ["Performing Artist"] },
    ]];
    let tracks = await context.search(song);
    assert.deepEqual(calls.map((call) => call.artist), ["Original Artist", "Original Artist"]);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].id, "original");

    calls.length = 0;
    song.coverArtist = "";
    responses = [[], [
        { id: "match", title: "Example", artists: ["Another Artist"] },
        { id: "wrong-title", title: "Example Live", artists: ["Another Artist"] },
    ]];
    tracks = await context.search(song);
    assert.deepEqual(calls.map((call) => call.artist), ["", ""]);
    assert.equal(tracks.length, 1);
    assert.equal(tracks[0].id, "match");

    calls.length = 0;
    song.cover = false;
    responses = [[{ id: "regular", title: "The Example", artists: ["Performing Artist"] }]];
    await context.search(song);
    assert.equal(calls[0].artist, "Performing Artist");
});

test("Spotify search endpoint omits the artist filter for title-only searches", async () => {
    const extension = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    const start = extension.indexOf("async function routeApi(");
    const end = extension.indexOf("\nasync function startCanvasServer(", start);
    const queries = [];
    const context = {
        URLSearchParams,
        readJson: async (req) => req.body,
        spotifyFetch: async (path) => {
            queries.push(new URL(path, "https://api.spotify.com").searchParams.get("q"));
            return { tracks: { items: [] } };
        },
        sendJson: (res, status, body) => { res.status = status; res.body = body; },
    };
    runInNewContext(`${extension.slice(start, end)}\nglobalThis.route = routeApi;`, context);
    const url = new URL("http://127.0.0.1/api/spotify/search");
    const response = {};
    await context.route({ method: "POST", body: { title: "Example", artist: "" } }, response, url);
    await context.route({ method: "POST", body: { title: "Example", artist: "Original Artist" } }, response, url);
    assert.deepEqual(queries, ["track:Example", "track:Example artist:Original Artist"]);
});

test("playlist API only creates private playlists and refuses existing targets without Spotify calls", async () => {
    const extension = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    const start = extension.indexOf("async function routeApi(");
    const end = extension.indexOf("\nasync function startCanvasServer(", start);
    const calls = [];
    const context = {
        readJson: async (req) => req.body,
        spotifyFetch: async (path, options) => {
            calls.push({ path, method: options.method, body: JSON.parse(options.body) });
            return { id: "created" };
        },
        sendJson: (res, status, body) => { res.status = status; res.body = body; },
        errorMessage: (error) => error.message,
    };
    runInNewContext(`${extension.slice(start, end)}\nglobalThis.route = routeApi;`, context);
    const url = new URL("http://127.0.0.1/api/spotify/playlist");
    const tracks = Array.from({ length: 101 }, () => "spotify:track:0123456789012345678901");
    const body = { name: "Waiting for Example 20261231", tracks };
    for (const playlistId of ["0123456789012345678901", " ", null, 123]) {
        await assert.rejects(() => context.route({ method: "POST", body: { ...body, playlistId } }, {}, url), /not supported/);
        assert.equal(calls.length, 0);
    }
    const res = {};
    await context.route({ method: "POST", body }, res, url);
    assert.equal(res.status, 200);
    assert.equal(res.body.url, "https://open.spotify.com/playlist/created");
    assert.equal(calls[0].path, "/me/playlists");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].body.name, body.name);
    assert.equal(calls[0].body.public, false);
    assert.equal(calls[0].body.collaborative, false);
    assert.deepEqual(calls.slice(1).map((call) => [call.path, call.method, call.body.uris.length]), [
        ["/playlists/created/items", "POST", 100],
        ["/playlists/created/items", "POST", 1],
    ]);
    calls.length = 0;
    await context.route({ method: "POST", body: { ...body, playlistId: "" } }, {}, url);
    assert.equal(calls[0].path, "/me/playlists");
    calls.length = 0;
    for (const path of ["/api/spotify/playlists", "/api/spotify/playlists/activity"]) {
        const result = {};
        await context.route({ method: "GET" }, result, new URL(`http://127.0.0.1${path}`));
        assert.equal(result.status, 404);
    }
    assert.equal(calls.length, 0);
});

test("canvas does not offer playlist replacement or load existing playlists", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    assert.doesNotMatch(html, /target-playlist|playlist-target|\/api\/spotify\/playlists|Replace this playlist/);
    assert.match(html, /id="save-playlist">Confirm and save/);
    const elements = new Map();
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, {
            disabled: true, hidden: false, textContent: "",
            addEventListener() {}, focus() {},
        });
        return elements.get(selector);
    };
    const requests = [];
    const context = {
        document: { querySelectorAll: () => [], querySelector: get },
        fetch: async (url) => {
            requests.push(url);
            return { ok: true, json: async () => ({ spotifyConfigured: true, spotifyConnected: true }) };
        },
    };
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    runInNewContext(`${script}\nglobalThis.connect = beginConnection;`, context);
    await context.connect();
    assert.deepEqual(requests, ["/api/status"]);
    assert.equal(get("#continue-to-selection").disabled, false);
});

test("confirmation date uses the local calendar and the confirmed name is stable", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    function element() {
        return {
            value: "", checked: false, disabled: false, hidden: false, handlers: {}, textContent: "",
            addEventListener(name, handler) { this.handlers[name] = handler; },
        };
    }
    const elements = new Map();
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
    };
    let localDay = 31;
    class LocalDate extends Date {
        getFullYear() { return 2026; }
        getMonth() { return 11; }
        getDate() { return localDay; }
        toISOString() { throw new Error("UTC date must not be used"); }
    }
    const writes = [];
    const context = {
        Date: LocalDate,
        document: { querySelectorAll: () => [], querySelector: get },
        fetch: async (url, options) => {
            writes.push({ url, body: JSON.parse(options.body) });
            return { ok: true, json: async () => ({ url: "https://open.spotify.com/playlist/example" }) };
        },
    };
    runInNewContext(`${script}
      globalThis.stateRef = state;
      globalThis.render = renderConfirmation;
      globalThis.save = savePlaylist;
      selectedTracks = () => [{ track: { uri: "spotify:track:0123456789012345678901" } }];
    `, context);
    context.stateRef.source = { artist: "Example" };
    context.render();
    assert.equal(writes.length, 0);
    assert.equal(get("#confirm-heading").textContent, "Create a private playlist?");
    assert.match(get("#confirm-warning").textContent, /Nothing will be written until you confirm/);
    assert.match(get("#confirm-summary").textContent, /“Waiting for Example”/);
    get("#include-date").checked = true;
    get("#include-date").handlers.change();
    assert.match(get("#confirm-summary").textContent, /“Waiting for Example 20261231”/);
    context.render();
    assert.equal(context.stateRef.confirmedName, "Waiting for Example 20261231");
    localDay = 1;
    await context.save();
    assert.equal(writes[0].body.name, "Waiting for Example 20261231");
    assert.equal("playlistId" in writes[0].body, false);
    assert.equal(get("#include-date").disabled, true);
    context.render();
    assert.equal(context.stateRef.confirmedName, "Waiting for Example 20261201");
    get("#include-date").checked = false;
    get("#include-date").handlers.change();
    assert.equal(context.stateRef.confirmedName, "Waiting for Example");
    get("#include-date").checked = true;
    context.render();
    assert.equal(context.stateRef.confirmedName, "Waiting for Example 20261201");
});

test("restart clears a preparation without a write and preserves connection", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    assert.match(html, /id="restart-preparation"/);
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    function element() {
        return {
            value: "", checked: false, disabled: false, hidden: false, handlers: {}, children: [], attributes: {}, textContent: "",
            addEventListener(name, handler) { this.handlers[name] = handler; },
            replaceChildren(...items) { this.children = items; },
            setAttribute(name, value) { this.attributes[name] = value; },
            removeAttribute(name) { delete this.attributes[name]; },
            focus() {},
        };
    }
    const elements = new Map();
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, element());
        return elements.get(selector);
    };
    let requests = 0;
    const context = {
        document: { querySelectorAll: () => [], querySelector: get, createElement: element },
        fetch: async () => { requests++; throw new Error("Unexpected request"); },
    };
    runInNewContext(`${script}
      globalThis.stateRef = state;
    `, context);
    const state = context.stateRef;
    state.connected = true;
    state.source = { artist: "Previous", songs: [] };
    state.selectedArtist = { mbid: artistMbid };
    state.artists = [state.selectedArtist];
    state.choices.set("song", {});
    get("#artist-name").value = "Previous";
    get("#concert-count").value = "25";
    get("#include-date").checked = true;
    get("#save-status").textContent = "Playlist saved.";
    get("#playlist-link").hidden = false;
    state.saving = true;
    get("#restart-preparation").handlers.click();
    assert.equal(state.source.artist, "Previous");
    state.saving = false;
    get("#restart-preparation").handlers.click();
    assert.equal(requests, 0);
    assert.equal(state.connected, true);
    assert.equal(state.source, null);
    assert.equal(state.selectedArtist, null);
    assert.equal(state.choices.size, 0);
    assert.equal(get("#artist-name").value, "");
    assert.equal(get("#concert-count").value, "5");
    assert.equal(get("#include-date").checked, false);
    assert.equal(get("#save-status").textContent, "");
    assert.equal(get("#playlist-link").hidden, true);
});

test("a Spotify save locks restart and date until the request finishes", async () => {
    const html = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements = new Map();
    const get = (selector) => {
        if (!elements.has(selector)) elements.set(selector, {
            value: "", disabled: false, hidden: false, textContent: "", handlers: {}, children: [],
            addEventListener(name, handler) { this.handlers[name] = handler; },
            replaceChildren(...items) { this.children = items; },
            setAttribute() {}, removeAttribute() {}, focus() {},
        });
        return elements.get(selector);
    };
    let finish;
    const context = {
        document: { querySelectorAll: () => [], querySelector: get },
        fetch: () => new Promise((resolve) => { finish = resolve; }),
    };
    runInNewContext(`${script}
      globalThis.stateRef = state;
      globalThis.save = savePlaylist;
      selectedTracks = () => [{ track: { uri: "spotify:track:0123456789012345678901" } }];
    `, context);
    context.stateRef.source = { artist: "Example" };
    context.stateRef.connected = true;
    context.stateRef.confirmedName = "Waiting for Example";
    const saving = context.save();
    assert.equal(get("#restart-preparation").disabled, true);
    assert.equal(get("#include-date").disabled, true);
    get("#restart-preparation").handlers.click();
    assert.equal(context.stateRef.source.artist, "Example");
    finish({ ok: true, json: async () => ({ url: "https://open.spotify.com/playlist/example" }) });
    await saving;
    assert.equal(get("#restart-preparation").disabled, false);
    assert.equal(get("#include-date").disabled, true);
    get("#restart-preparation").handlers.click();
    assert.equal(context.stateRef.source, null);
    assert.equal(context.stateRef.connected, true);
    assert.equal(get("#playlist-link").hidden, true);
});

test("concurrent Spotify requests share a token refresh and ignore late 401s for an old token", async () => {
    const extension = await readFile(new URL("../com.github.copilot/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    const start = extension.indexOf("async function refreshSpotifyToken()");
    const end = extension.indexOf("\nasync function routeApi(", start);
    assert.ok(start >= 0 && end > start);
    function contextFor(expiresAt, fetch) {
        const context = { fetch, URLSearchParams, AbortSignal };
        runInNewContext(`
          let spotifyTokens = { accessToken: "old", refreshToken: "refresh", clientId: "client", expiresAt: ${expiresAt} };
          let spotifyRefreshPromise = null;
          ${extension.slice(start, end)}
          globalThis.requestSpotify = spotifyFetch;
        `, context);
        return context;
    }
    let refreshes = 0;
    const refreshed = { access_token: "new", refresh_token: "refresh", expires_in: 3600 };
    const context = contextFor(0, async (url) => {
        if (url.startsWith("https://accounts.spotify.com/")) {
            refreshes++;
            await new Promise((resolve) => setImmediate(resolve));
            return { ok: true, json: async () => refreshed };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
    await Promise.all(["/a", "/b", "/c"].map((path) => context.requestSpotify(path)));
    assert.equal(refreshes, 1);

    refreshes = 0;
    let releaseLate;
    let oldRequests = 0;
    const late401 = new Promise((resolve) => { releaseLate = resolve; });
    const second = contextFor(Date.now() + 3_600_000, async (url, options) => {
        if (url.startsWith("https://accounts.spotify.com/")) {
            refreshes++;
            return { ok: true, json: async () => refreshed };
        }
        if (options.headers.Authorization === "Bearer old") {
            if (++oldRequests === 2) await late401;
            return { ok: false, status: 401 };
        }
        return { ok: true, status: 200, json: async () => ({}) };
    });
    const firstRequest = second.requestSpotify("/first");
    const secondRequest = second.requestSpotify("/second");
    await firstRequest;
    releaseLate();
    await secondRequest;
    assert.equal(refreshes, 1);
});
