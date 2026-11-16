import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createCanvas, joinSession } from "@github/copilot-sdk/extension";
import { rejectUntrustedRequest } from "./http-security.mjs";
import { orderPlaylistsByLatestAddition } from "./playlist-activity.mjs";
import { loadSetlistSource, searchArtists } from "./setlist.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const APP_PATH = join(ROOT, "app.html");
const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:43821/callback";
const SPOTIFY_SCOPES = [
    "user-read-private",
    "playlist-read-private",
    "playlist-modify-private",
].join(" ");
const servers = new Map();
const pendingAuthorizations = new Map();
let callbackServer;
let spotifyTokens = null;
let spotifyUserId = null;
let spotifyRefreshPromise = null;

function json(res, status, value) {
    res.writeHead(status, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
    });
    res.end(JSON.stringify(value));
}

function errorMessage(error) {
    return error instanceof Error ? error.message : "Unexpected error.";
}

function escapeHtml(value) {
    return value.replace(/[&<>"']/g, (character) => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
    })[character]);
}

async function readJson(req) {
    let text = "";
    let bytes = 0;
    req.setEncoding("utf8");
    for await (const chunk of req) {
        bytes += Buffer.byteLength(chunk, "utf8");
        if (bytes > 65_536) throw new Error("Request is too large.");
        text += chunk;
    }
    try {
        return text ? JSON.parse(text) : {};
    } catch {
        throw new Error("Invalid JSON body.");
    }
}

async function sendJson(res, status, body) {
    json(res, status, body);
}

function cleanExpiredAuthorizations() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [state, entry] of pendingAuthorizations) {
        if (entry.createdAt < cutoff) pendingAuthorizations.delete(state);
    }
}

async function exchangeAuthorizationCode(code, state) {
    const pending = pendingAuthorizations.get(state);
    pendingAuthorizations.delete(state);
    if (!pending || pending.createdAt < Date.now() - 10 * 60_000) {
        throw new Error("Authorization expired or invalid OAuth state.");
    }

    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: pending.clientId,
            grant_type: "authorization_code",
            code,
            redirect_uri: SPOTIFY_REDIRECT_URI,
            code_verifier: pending.verifier,
        }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Spotify rejected the authorization.");
    const result = await response.json();
    if (typeof result.access_token !== "string" || typeof result.refresh_token !== "string"
        || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
        throw new Error("Invalid Spotify authorization response.");
    }
    spotifyTokens = {
        accessToken: result.access_token,
        refreshToken: result.refresh_token,
        expiresAt: Date.now() + result.expires_in * 1000,
        clientId: pending.clientId,
    };
    spotifyUserId = null;
}

async function handleSpotifyCallback(req, res) {
    const url = new URL(req.url, SPOTIFY_REDIRECT_URI);
    const state = url.searchParams.get("state");
    const code = url.searchParams.get("code");
    const oauthError = url.searchParams.get("error");

    try {
        if (oauthError) {
            pendingAuthorizations.delete(state);
            throw new Error("Spotify authorization denied.");
        }
        if (!state || !code) throw new Error("Incomplete Spotify response.");
        await exchangeAuthorizationCode(code, state);
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
            "X-Content-Type-Options": "nosniff",
        });
        res.end("<!doctype html><html lang=en><meta charset=utf-8><title>Spotify connected</title><p>Spotify is connected. Return to the canvas.</p></html>");
    } catch (error) {
        res.writeHead(400, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'none'",
            "X-Content-Type-Options": "nosniff",
        });
        res.end(`<!doctype html><html lang=en><meta charset=utf-8><title>Spotify connection</title><p>${escapeHtml(errorMessage(error))}</p><p>Return to the canvas and try again.</p></html>`);
    }
}

async function ensureCallbackServer() {
    if (callbackServer?.listening) return;
    callbackServer = createServer((req, res) => {
        if (req.method === "GET" && req.headers.host === "127.0.0.1:43821"
            && new URL(req.url ?? "/", SPOTIFY_REDIRECT_URI).pathname === "/callback") {
            void handleSpotifyCallback(req, res);
            return;
        }
        res.writeHead(404);
        res.end();
    });
    await new Promise((resolve, reject) => {
        callbackServer.once("error", reject);
        callbackServer.listen(43821, "127.0.0.1", () => {
            callbackServer.off("error", reject);
            resolve();
        });
    });
}

async function startSpotifyAuthorization() {
    const clientId = process.env.SPOTIFY_CLIENT_ID?.trim();
    if (!clientId) throw new Error("SPOTIFY_CLIENT_ID is missing. Set it and reload the extension.");
    await ensureCallbackServer();
    cleanExpiredAuthorizations();

    const verifier = randomBytes(48).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(24).toString("base64url");
    pendingAuthorizations.set(state, { clientId, verifier, createdAt: Date.now() });

    const url = new URL("https://accounts.spotify.com/authorize");
    url.search = new URLSearchParams({
        client_id: clientId,
        response_type: "code",
        redirect_uri: SPOTIFY_REDIRECT_URI,
        code_challenge_method: "S256",
        code_challenge: challenge,
        state,
        scope: SPOTIFY_SCOPES,
    }).toString();
    return { authorizationUrl: url.toString() };
}

async function refreshSpotifyToken() {
    const pending = spotifyRefreshPromise ??= refreshSpotifyTokenOnce();
    try {
        await pending;
    } finally {
        if (spotifyRefreshPromise === pending) spotifyRefreshPromise = null;
    }
}

async function refreshSpotifyTokenOnce() {
    if (!spotifyTokens?.refreshToken) throw new Error("Reconnect your Spotify account.");
    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: spotifyTokens.clientId,
            grant_type: "refresh_token",
            refresh_token: spotifyTokens.refreshToken,
        }),
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
        spotifyTokens = null;
        spotifyUserId = null;
        throw new Error("Your Spotify session has expired. Reconnect.");
    }
    const result = await response.json();
    if (typeof result.access_token !== "string" || !Number.isFinite(result.expires_in) || result.expires_in <= 0) {
        throw new Error("Invalid Spotify refresh response. Reconnect.");
    }
    spotifyTokens = {
        ...spotifyTokens,
        accessToken: result.access_token,
        refreshToken: result.refresh_token ?? spotifyTokens.refreshToken,
        expiresAt: Date.now() + result.expires_in * 1000,
    };
}

async function spotifyFetch(path, options = {}, retried = false) {
    if (!spotifyTokens) throw new Error("Connect your Spotify account first.");
    if (spotifyTokens.expiresAt < Date.now() + 30_000) await refreshSpotifyToken();
    const accessToken = spotifyTokens?.accessToken;
    if (!accessToken) throw new Error("Reconnect your Spotify account.");
    const response = await fetch(`https://api.spotify.com/v1${path}`, {
        ...options,
        headers: {
            Authorization: `Bearer ${accessToken}`,
            ...(options.body ? { "Content-Type": "application/json" } : {}),
            ...options.headers,
        },
        signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 401 && !retried) {
        if (spotifyTokens?.accessToken === accessToken) await refreshSpotifyToken();
        return spotifyFetch(path, options, true);
    }
    if (response.status === 204) return null;
    if (!response.ok) {
        if (response.status === 429) throw new Error("Spotify is temporarily rate-limiting requests. Try again in a few seconds.");
        throw new Error(`Spotify error (${response.status}). Check the granted permissions.`);
    }
    return response.json();
}

async function getSpotifyUser() {
    if (!spotifyUserId) {
        const profile = await spotifyFetch("/me");
        if (typeof profile?.id !== "string" || !profile.id) throw new Error("Incomplete Spotify profile.");
        spotifyUserId = profile.id;
    }
    return spotifyUserId;
}

async function getOwnedPrivatePlaylists() {
    const userId = await getSpotifyUser();
    const playlists = [];
    for (let offset = 0; offset <= 100_000; offset += 50) {
        const page = await spotifyFetch(`/me/playlists?limit=50&offset=${offset}`);
        if (!Array.isArray(page.items)) throw new Error("Invalid Spotify playlist response.");
        const items = page.items;
        playlists.push(...items
            .filter((item) => item.owner?.id === userId && item.public === false)
            .map((item) => ({ id: item.id, name: item.name, tracks: item.items?.total ?? item.tracks?.total ?? 0 })));
        if (!page.next) return playlists;
        if (!items.length) throw new Error("Spotify playlist pagination is incomplete.");
    }
    throw new Error("The Spotify playlist list exceeds the pagination limit.");
}

async function routeApi(req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/status") {
        return sendJson(res, 200, {
            spotifyConfigured: Boolean(process.env.SPOTIFY_CLIENT_ID?.trim()),
            spotifyConnected: Boolean(spotifyTokens),
            setlistConfigured: Boolean(process.env.SETLISTFM_API_KEY?.trim()),
            redirectUri: SPOTIFY_REDIRECT_URI,
        });
    }
    if (req.method === "POST" && url.pathname === "/api/artists/search") {
        const body = await readJson(req);
        return sendJson(res, 200, await searchArtists({ name: body.name, apiKey: process.env.SETLISTFM_API_KEY }));
    }
    if (req.method === "POST" && url.pathname === "/api/setlists") {
        const body = await readJson(req);
        const result = await loadSetlistSource({
            artistMbid: String(body.artistMbid ?? "").trim(),
            requestedArtist: String(body.artistName ?? "").trim(),
            apiKey: process.env.SETLISTFM_API_KEY,
            allowOlder: body.allowOlder === true,
            acceptIncomplete: body.acceptIncomplete === true,
        });
        return sendJson(res, 200, result);
    }
    if (req.method === "POST" && url.pathname === "/api/spotify/auth/start") {
        return sendJson(res, 200, await startSpotifyAuthorization());
    }
    if (req.method === "GET" && url.pathname === "/api/spotify/auth/status") {
        return sendJson(res, 200, { connected: Boolean(spotifyTokens) });
    }
    if (req.method === "POST" && url.pathname === "/api/spotify/search") {
        const body = await readJson(req);
        const title = String(body.title ?? "").trim();
        const artist = String(body.artist ?? "").trim();
        if (!title || title.length > 200 || artist.length > 200) {
            throw new Error("Track title is missing, or the title or artist is too long.");
        }
        const query = new URLSearchParams({
            q: `track:${title}${artist ? ` artist:${artist}` : ""}`,
            type: "track",
            limit: "5",
        });
        const result = await spotifyFetch(`/search?${query}`);
        if (!Array.isArray(result.tracks?.items)) throw new Error("Invalid Spotify search response.");
        const tracks = result.tracks.items;
        return sendJson(res, 200, {
            tracks: tracks.map((track) => ({
                id: track.id,
                uri: track.uri,
                title: track.name,
                artists: track.artists?.map((item) => item.name) ?? [],
                album: track.album?.name ?? "Unknown album",
                albumType: track.album?.album_type ?? "",
                releaseDate: track.album?.release_date ?? "",
                disc: track.disc_number ?? 1,
                track: track.track_number ?? 0,
                durationMs: track.duration_ms,
                image: track.album?.images?.[0]?.url ?? "",
            })),
        });
    }
    if (req.method === "GET" && url.pathname === "/api/spotify/playlists") {
        return sendJson(res, 200, { playlists: await getOwnedPrivatePlaylists() });
    }
    if (req.method === "GET" && url.pathname === "/api/spotify/playlists/activity") {
        const playlists = await getOwnedPrivatePlaylists();
        return sendJson(res, 200, { playlists: await orderPlaylistsByLatestAddition(playlists, spotifyFetch) });
    }
    if (req.method === "POST" && url.pathname === "/api/spotify/playlist") {
        const body = await readJson(req);
        const name = String(body.name ?? "").trim();
        const playlistId = String(body.playlistId ?? "").trim();
        const tracks = body.tracks;
        if (!name || name.length > 100) throw new Error("Invalid playlist name.");
        if (!Array.isArray(tracks) || tracks.length < 1 || tracks.length > 1000) {
            throw new Error("The playlist must contain between 1 and 1,000 tracks.");
        }
        if (tracks.some((uri) => typeof uri !== "string" || !/^spotify:track:[A-Za-z0-9]{22}$/.test(uri))) {
            throw new Error("The selection contains an invalid Spotify URI.");
        }

        let playlist;
        if (playlistId) {
            if (!/^[A-Za-z0-9]{22}$/.test(playlistId)) throw new Error("Invalid playlist ID.");
            const owned = await getOwnedPrivatePlaylists();
            if (!owned.some((item) => item.id === playlistId)) {
                throw new Error("This is not a private playlist owned by your account.");
            }
            playlist = { id: playlistId };
            try {
                await spotifyFetch(`/playlists/${playlistId}/items`, {
                    method: "PUT",
                    body: JSON.stringify({ uris: tracks.slice(0, 100) }),
                });
                for (let offset = 100; offset < tracks.length; offset += 100) {
                    await spotifyFetch(`/playlists/${playlistId}/items`, {
                        method: "POST",
                        body: JSON.stringify({ uris: tracks.slice(offset, offset + 100) }),
                    });
                }
            } catch (error) {
                throw new Error(`Save interrupted: the playlist may have been partially modified. Check it before retrying. ${errorMessage(error)}`);
            }
        } else {
            try {
                playlist = await spotifyFetch("/me/playlists", {
                    method: "POST",
                    body: JSON.stringify({
                        name,
                        description: "Spoiler-free concert preparation — setlist sorted by album.",
                        public: false,
                        collaborative: false,
                    }),
                });
                for (let offset = 0; offset < tracks.length; offset += 100) {
                    await spotifyFetch(`/playlists/${playlist.id}/items`, {
                        method: "POST",
                        body: JSON.stringify({ uris: tracks.slice(offset, offset + 100) }),
                    });
                }
            } catch (error) {
                throw new Error(`Save interrupted: an empty or incomplete playlist may have been created. Check Spotify before retrying. ${errorMessage(error)}`);
            }
        }
        return sendJson(res, 200, { url: `https://open.spotify.com/playlist/${playlist.id}` });
    }
    return sendJson(res, 404, { error: "Route not found." });
}

async function startCanvasServer() {
    const html = await readFile(APP_PATH, "utf8");
    const server = createServer((req, res) => {
        const rejection = rejectUntrustedRequest(req, server.address().port);
        if (rejection) {
            json(res, rejection.status, { error: rejection.error });
            return;
        }
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname.startsWith("/api/")) {
            void routeApi(req, res, url).catch((error) => {
                const status = error instanceof Error && error.message.includes("Connect your Spotify account first") ? 401 : 400;
                void sendJson(res, status, { error: errorMessage(error) });
            });
            return;
        }
        if (req.method !== "GET" || url.pathname !== "/") {
            res.writeHead(404);
            res.end();
            return;
        }
        res.writeHead(200, {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-store",
            "Content-Security-Policy": "default-src 'self' https://i.scdn.co; img-src 'self' https://i.scdn.co data:; style-src 'self' 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
            "X-Content-Type-Options": "nosniff",
        });
        res.end(html);
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
            server.off("error", reject);
            resolve();
        });
    });
    return { server, url: `http://127.0.0.1:${server.address().port}/` };
}

await joinSession({
    requestedEnvironmentVariables: ["SETLISTFM_API_KEY"],
    canvases: [
        createCanvas({
            id: "concert-playlist",
            displayName: "Spoiler-free playlist",
            description: "Prepare a private concert playlist from setlist.fm without exposing track titles to the agent",
            actions: [
                {
                    name: "show_source_summary",
                    description: "Show the spoiler-free source summary",
                    handler: async () => ({
                        message: "The source and tracks are shown only in the local canvas; no Spotify content or concert order is sent to the agent.",
                    }),
                },
            ],
            open: async (ctx) => {
                let entry = servers.get(ctx.instanceId);
                if (!entry) {
                    entry = await startCanvasServer();
                    servers.set(ctx.instanceId, entry);
                }
                return { title: "Spoiler-free playlist", url: entry.url };
            },
            onClose: async (ctx) => {
                const entry = servers.get(ctx.instanceId);
                if (entry) {
                    servers.delete(ctx.instanceId);
                    await new Promise((resolve, reject) => {
                        entry.server.close((error) => error ? reject(error) : resolve());
                    });
                }
                if (!servers.size && callbackServer?.listening) {
                    await new Promise((resolve, reject) => {
                        callbackServer.close((error) => error ? reject(error) : resolve());
                        callbackServer = null;
                        spotifyTokens = null;
                        spotifyUserId = null;
                        pendingAuthorizations.clear();
                    });
                }
            },
        }),
    ],
});
