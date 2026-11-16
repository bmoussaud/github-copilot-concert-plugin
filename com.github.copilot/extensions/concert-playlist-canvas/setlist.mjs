const ARTIST_MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TARGET_SHOWS = 5;
const MAX_PAGES = 25;

export async function searchArtists({ name, apiKey, fetchImpl = fetch }) {
    if (!apiKey?.trim()) throw new Error("SETLISTFM_API_KEY is missing from the environment approved by Copilot.");
    const query = typeof name === "string" ? name.trim() : "";
    if (!query || query.length > 200) throw new Error("Enter an artist name between 1 and 200 characters.");
    const params = new URLSearchParams({ artistName: query, sort: "relevance" });
    const response = await fetchImpl(`https://api.setlist.fm/rest/1.0/search/artists?${params}`, {
        headers: { Accept: "application/json", "x-api-key": apiKey.trim() },
        signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 404) return { artists: [], total: 0 };
    if (response.status === 401 || response.status === 403) throw new Error("Invalid or unauthorized setlist.fm API key.");
    if (!response.ok) throw new Error(`setlist.fm error (${response.status}). Try again later.`);
    const payload = await response.json();
    if (!Array.isArray(payload.artist) || !Number.isInteger(payload.total) || payload.total < 0) {
        throw new Error("Invalid setlist.fm response for artist search.");
    }
    const artists = payload.artist.map((artist) => {
        if (!ARTIST_MBID.test(artist?.mbid ?? "") || typeof artist.name !== "string" || !artist.name.trim()) {
            throw new Error("Invalid setlist.fm artist result.");
        }
        return { mbid: artist.mbid, name: artist.name.trim(), disambiguation: String(artist.disambiguation ?? "").trim() };
    });
    return { artists, total: payload.total };
}

function parseEventDate(value) {
    const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value ?? "");
    if (!match) return null;
    const day = Number(match[1]);
    const month = Number(match[2]) - 1;
    const year = Number(match[3]);
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return null;
    return date;
}

function getSongs(setlist) {
    const result = [];
    const sets = setlist.sets?.set ?? setlist.set ?? [];
    for (const set of Array.isArray(sets) ? sets : [sets]) {
        const songs = set?.song ?? [];
        for (const song of Array.isArray(songs) ? songs : [songs]) {
            if (!song?.name || song.tape === true) continue;
            const artist = String(setlist.artist?.name ?? "").trim();
            const originalArtist = typeof song.cover?.name === "string" ? song.cover.name.trim() : "";
            result.push({
                title: String(song.name).trim(),
                artist,
                cover: Boolean(song.cover) || /\bcover\b/i.test(String(song.info ?? "")),
                coverArtist: originalArtist && normalize(originalArtist) !== normalize(artist) ? originalArtist : "",
            });
        }
    }
    return result;
}

function normalize(value) {
    return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function summarizeShow(setlist) {
    const city = setlist.venue?.city;
    const place = [setlist.venue?.name, city?.name, city?.country?.name].filter(Boolean).join(", ");
    const url = typeof setlist.url === "string" && URL.canParse(setlist.url) ? new URL(setlist.url) : null;
    const trustedUrl = url?.protocol === "https:"
        && (url.hostname === "www.setlist.fm" || url.hostname === "setlist.fm")
        && !url.port && !url.username && !url.password && url.pathname.startsWith("/setlist/");
    return {
        date: setlist.eventDate,
        venue: place || "Venue not specified",
        entries: getSongs(setlist).length,
        url: trustedUrl ? url.href : null,
    };
}

function annualCutoff(now) {
    const year = now.getUTCFullYear() - 1;
    const month = now.getUTCMonth();
    const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
    return new Date(Date.UTC(year, month, Math.min(now.getUTCDate(), lastDay)));
}

export async function loadSetlistSource({
    artistMbid,
    requestedArtist,
    apiKey,
    allowOlder = false,
    acceptIncomplete = false,
    fetchImpl = fetch,
    now = new Date(),
}) {
    if (!apiKey?.trim()) throw new Error("SETLISTFM_API_KEY is missing from the environment approved by Copilot.");
    if (!ARTIST_MBID.test(artistMbid)) throw new Error("Invalid MusicBrainz MBID.");

    const cutoff = annualCutoff(now);
    const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const seen = new Set();
    const candidates = [];
    let artist = requestedArtist || "Artist";
    let completeSearch = false;

    for (let page = 1; page <= MAX_PAGES; page++) {
        const response = await fetchImpl(`https://api.setlist.fm/rest/1.0/artist/${artistMbid}/setlists?p=${page}`, {
            headers: { Accept: "application/json", "x-api-key": apiKey.trim() },
            signal: AbortSignal.timeout(20_000),
        });
        if (response.status === 404) throw new Error("Artist not found on setlist.fm.");
        if (response.status === 401 || response.status === 403) throw new Error("Invalid or unauthorized setlist.fm API key.");
        if (!response.ok) throw new Error(`setlist.fm error (${response.status}). Try again later.`);

        const payload = await response.json();
        const items = payload.setlist ?? payload.setlists?.setlist ?? [];
        const rawSetlists = (Array.isArray(items) ? items : [items]).filter(Boolean);
        const setlists = rawSetlists
            .filter(Boolean)
            .map((item) => ({ item, date: parseEventDate(item.eventDate) }))
            .filter(({ date }) => date && date.getTime() <= today)
            .sort((a, b) => b.date - a.date);
        let crossedCutoff = false;
        for (const { item, date } of setlists) {
            if (!allowOlder && date < cutoff) {
                crossedCutoff = true;
                continue;
            }
            if (!getSongs(item).length) continue;
            const id = item.id || `${item.eventDate}|${item.venue?.id ?? item.venue?.name ?? ""}`;
            if (seen.has(id)) continue;
            seen.add(id);
            candidates.push({ item, date });
            if (item.artist?.name) artist = item.artist.name;
        }
        candidates.sort((a, b) => b.date - a.date);
        const tour = candidates[0]?.item.tour?.name?.trim();
        const matches = tour ? candidates.filter(({ item }) => item.tour?.name?.trim() === tour) : [];
        const enough = tour ? matches.length >= TARGET_SHOWS : candidates.length >= TARGET_SHOWS;
        const total = Number(payload.total);
        const pageSize = Number(payload.itemsPerPage);
        const exhausted = !rawSetlists.length
            || (Number.isFinite(total) && total >= 0 && pageSize > 0 && page * pageSize >= total);
        if (enough || crossedCutoff || exhausted) {
            completeSearch = true;
            break;
        }
    }
    if (!completeSearch) {
        throw new Error("The search exceeds the 25-page setlist.fm limit. Try a more specific source.");
    }

    const tour = candidates[0]?.item.tour?.name?.trim();
    const tourMatches = tour ? candidates.filter(({ item }) => item.tour?.name?.trim() === tour) : [];
    const useTour = tourMatches.length >= TARGET_SHOWS;
    const selected = (useTour ? tourMatches : candidates).slice(0, TARGET_SHOWS).map(({ item }) => item);
    if (!selected.length && acceptIncomplete) {
        throw new Error("No concerts with usable songs were found.");
    }
    const songsByKey = new Map();
    const ambiguousCoverArtists = new Set();
    for (const setlist of selected) {
        for (const song of getSongs(setlist)) {
            const key = `${normalize(song.title)}|${normalize(song.artist)}`;
            const existing = songsByKey.get(key);
            if (!existing) {
                songsByKey.set(key, { ...song, id: key });
            } else {
                existing.cover ||= song.cover;
                if (song.coverArtist && !ambiguousCoverArtists.has(key)) {
                    if (existing.coverArtist && normalize(existing.coverArtist) !== normalize(song.coverArtist)) {
                        existing.coverArtist = "";
                        ambiguousCoverArtists.add(key);
                    } else {
                        existing.coverArtist = song.coverArtist;
                    }
                }
            }
        }
    }
    const collator = new Intl.Collator("fr", { sensitivity: "base", numeric: true });
    const songs = [...songsByKey.values()].sort((a, b) =>
        collator.compare(a.title, b.title) || collator.compare(a.artist, b.artist) || a.id.localeCompare(b.id),
    );
    const incomplete = selected.length < TARGET_SHOWS && !acceptIncomplete;
    return {
        artist,
        source: {
            method: useTour ? `Five concerts from the tour: ${tour}` : "Most recent documented concerts",
            period: allowOlder ? "Search expanded to older concerts" : "Last twelve months",
            shows: selected.map(summarizeShow),
            count: selected.length,
        },
        songs,
        needsOlderConsent: incomplete && !allowOlder,
        needsIncompleteConsent: incomplete && allowOlder,
    };
}
