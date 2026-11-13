import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { rejectUntrustedRequest } from "../.github/extensions/concert-playlist-canvas/http-security.mjs";
import { orderPlaylistsByLatestAddition } from "../.github/extensions/concert-playlist-canvas/playlist-activity.mjs";
import { loadSetlistSource, searchArtists } from "../.github/extensions/concert-playlist-canvas/setlist.mjs";

const artistMbid = "2b1c601f-4c4c-4654-959e-2d243a4d4eab";
const now = new Date("2026-11-13T10:00:00Z");

function show(id, eventDate, titles, tour = "Tournée actuelle") {
    return {
        id,
        eventDate,
        artist: { name: "Artiste exemple" },
        tour: tour ? { name: tour } : undefined,
        venue: { id: `venue-${id}`, name: `Salle ${id}` },
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
    await assert.rejects(() => searchArtists({ name: " ", apiKey: "test-key", fetchImpl }), /1 à 200/);
    await assert.rejects(() => searchArtists({ name: "Test", apiKey: "test-key", fetchImpl: async () => ({ status: 429, ok: false }) }), /429/);
});

test("artist selection supplies the chosen ID and ignores stale searches", async () => {
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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
    assert.deepEqual(result.songs.map((song) => song.title), ["Alpha", "Bêta", "Echo", "Gamma", "Zulu"]);
    assert.equal(result.songs.find((song) => song.title === "Echo").cover, true);
    assert.equal(result.songs.find((song) => song.title === "Echo").artist, "Artiste exemple");
    assert.equal(result.needsOlderConsent, false);
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
    assert.match(result.source.method, /plus récents/);
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
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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
    assert.equal(search.attributes["aria-label"], "Rechercher sur Spotify");
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
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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
      renderPlaylistTarget = () => {};
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
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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
    assert.match(entry.queryError, /1 à 200/);
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
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
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

test("private playlists are ordered by their latest known complete addition dates across all pages", async () => {
    const playlists = [
        { id: "empty" },
        { id: "older" },
        { id: "newest" },
        { id: "same-date" },
        { id: "missing-date" },
    ];
    const pages = {
        empty: { 0: { items: [], next: null } },
        older: { 0: { items: [{ added_at: "2026-11-12T19:30:00+02:00" }], next: null } },
        newest: {
            0: { items: Array.from({ length: 50 }, () => ({ added_at: "2024-01-01T00:00:00Z" })), next: "next" },
            50: { items: [{ added_at: "2026-11-12T19:00:00Z" }], next: null },
        },
        "same-date": { 0: { items: [{ added_at: "2026-11-12T20:00:00+01:00" }], next: null } },
        "missing-date": {
            0: { items: [{ added_at: null }, { added_at: "2030-01-01T00:00:00Z" }], next: null },
        },
    };
    const calls = [];
    let active = 0;
    let maxActive = 0;
    const spotifyFetch = async (path) => {
        const url = new URL(path, "https://api.spotify.com");
        const id = url.pathname.split("/")[2];
        const offset = Number(url.searchParams.get("offset"));
        assert.equal(url.searchParams.get("fields"), "next,items(added_at)");
        assert.equal(url.searchParams.get("limit"), "50");
        calls.push(`${id}:${offset}`);
        maxActive = Math.max(maxActive, ++active);
        await new Promise((resolve) => setImmediate(resolve));
        active--;
        assert.ok(pages[id]?.[offset], `Unexpected playlist page: ${id}:${offset}`);
        return pages[id][offset];
    };

    const result = await orderPlaylistsByLatestAddition(playlists, spotifyFetch);
    assert.deepEqual(result.map((playlist) => playlist.id), ["newest", "same-date", "older", "empty", "missing-date"]);
    assert.equal(result[0].lastAddedAt, Date.parse("2026-11-12T19:00:00Z"));
    assert.equal(result[3].lastAddedAt, null);
    assert.equal(result[4].lastAddedAt, null);
    assert.ok(calls.includes("newest:50"));
    assert.ok(maxActive > 1 && maxActive <= 3);
    assert.equal(playlists[0].lastAddedAt, undefined);
});

test("playlist activity errors are surfaced instead of producing an incorrect ordering", async () => {
    const playlist = [{ id: "example" }];
    await assert.rejects(
        () => orderPlaylistsByLatestAddition(playlist, async () => { throw new Error("Limite Spotify"); }),
        /Limite Spotify/,
    );
    await assert.rejects(
        () => orderPlaylistsByLatestAddition(playlist, async () => ({ items: [], next: "next" })),
        /pagination/,
    );
    await assert.rejects(
        () => orderPlaylistsByLatestAddition(playlist, async () => ({ items: [{ added_at: "invalid" }], next: null })),
        /Date d’ajout Spotify invalide/,
    );
});

test("the playlist activity endpoint returns the ordered owned playlists", async () => {
    const extension = await readFile(new URL("../.github/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    const start = extension.indexOf("async function routeApi(");
    const end = extension.indexOf("\nasync function startCanvasServer(", start);
    assert.ok(start >= 0 && end > start);
    const playlists = [{ id: "old" }, { id: "new" }];
    const context = {
        getOwnedPrivatePlaylists: async () => playlists,
        orderPlaylistsByLatestAddition,
        spotifyFetch: async (path) => ({
            items: [{ added_at: path.includes("/new/") ? "2026-01-01T00:00:00Z" : "2025-01-01T00:00:00Z" }],
            next: null,
        }),
        sendJson: (res, status, body) => { res.status = status; res.body = body; },
    };
    runInNewContext(`${extension.slice(start, end)}\nglobalThis.route = routeApi;`, context);
    const res = {};
    await context.route({ method: "GET" }, res, new URL("http://127.0.0.1/api/spotify/playlists/activity"));
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.playlists.map((playlist) => playlist.id), ["new", "old"]);
});

test("playlist sorting updates the preview without losing the target and reports errors", async () => {
    const html = await readFile(new URL("../.github/extensions/concert-playlist-canvas/app.html", import.meta.url), "utf8");
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    function element(tag) {
        return {
            tag, children: [], value: "", handlers: {},
            append(...items) { this.children.push(...items); },
            replaceChildren(...items) { this.children = items; },
            querySelector(selector) { return selector === "select" ? this.children.find((child) => child.tag === "select") : null; },
            addEventListener(name, handler) { this.handlers[name] = handler; },
            setAttribute(name, value) { this[name] = value; },
        };
    }
    const root = element("div");
    const placeholder = element("div");
    let resolveActivity;
    const initial = [
        { id: "old", name: "Ancienne", tracks: 1 },
        { id: "new", name: "Récente", tracks: 2 },
        { id: "empty", name: "Vide", tracks: 0 },
    ];
    const ordered = [
        { ...initial[1], lastAddedAt: 2 },
        { ...initial[0], lastAddedAt: 1 },
        { ...initial[2], lastAddedAt: null },
    ];
    const response = (playlists) => ({ ok: true, json: async () => ({ playlists }) });
    const context = {
        document: {
            querySelectorAll: () => [],
            querySelector: (selector) => selector === "#playlist-target" ? root
                : selector === "#target-playlist" ? root.querySelector("select") : placeholder,
            createElement: element,
        },
        Option: function (label, value) { this.label = label; this.value = value; },
        fetch: async (url) => {
            if (url === "/api/spotify/playlists") return response(initial);
            assert.equal(url, "/api/spotify/playlists/activity");
            return new Promise((resolve) => { resolveActivity = resolve; });
        },
    };
    runInNewContext(`${script}
      globalThis.stateRef = state;
      globalThis.loadBase = loadPlaylists;
      globalThis.loadActivity = loadPlaylistActivity;
      globalThis.renderTarget = renderPlaylistTarget;
    `, context);

    await context.loadBase();
    assert.equal(context.stateRef.playlistOrderStatus, "loading");
    context.renderTarget();
    root.querySelector("select").value = "old";
    resolveActivity(response(ordered));
    await new Promise((resolve) => setImmediate(resolve));
    const select = root.querySelector("select");
    assert.equal(context.stateRef.playlistOrderStatus, "ready");
    assert.equal(select.value, "old");
    assert.deepEqual(select.children.map((option) => option.value), ["", "new", "old", "empty"]);
    assert.match(select.children[3].label, /date inconnue/);

    context.fetch = async () => response(ordered.filter((playlist) => playlist.id !== "old"));
    await context.loadActivity();
    assert.equal(root.querySelector("select").value, "old");
    assert.match(root.querySelector("select").children.at(-1).label, /date inconnue/);

    context.fetch = async () => ({ ok: false, status: 429, json: async () => ({ error: "Limite Spotify" }) });
    await context.loadActivity();
    assert.equal(context.stateRef.playlistOrderStatus, "error");
    assert.ok(root.children.some((child) => child.textContent?.includes("Limite Spotify")));
    assert.ok(root.children.some((child) => child.textContent === "Réessayer le tri"));
    assert.equal(root.querySelector("select").value, "old");
});

test("concurrent Spotify requests share a token refresh and ignore late 401s for an old token", async () => {
    const extension = await readFile(new URL("../.github/extensions/concert-playlist-canvas/extension.mjs", import.meta.url), "utf8");
    const start = extension.indexOf("async function refreshSpotifyToken()");
    const end = extension.indexOf("\nasync function getSpotifyUser()", start);
    assert.ok(start >= 0 && end > start);
    function contextFor(expiresAt, fetch) {
        const context = { fetch, URLSearchParams, AbortSignal };
        runInNewContext(`
          let spotifyTokens = { accessToken: "old", refreshToken: "refresh", clientId: "client", expiresAt: ${expiresAt} };
          let spotifyUserId = null;
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
