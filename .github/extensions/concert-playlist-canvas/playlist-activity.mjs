async function latestAddition(playlistId, spotifyFetch) {
    if (typeof playlistId !== "string" || !playlistId) {
        throw new Error("Identifiant de playlist Spotify invalide.");
    }

    let latest = null;
    let missingDate = false;
    for (let offset = 0; offset <= 100_000;) {
        const query = new URLSearchParams({
            limit: "50",
            offset: String(offset),
            fields: "next,items(added_at)",
        });
        const page = await spotifyFetch(`/playlists/${encodeURIComponent(playlistId)}/items?${query}`);
        if (!Array.isArray(page?.items)
            || (page.next !== null && (typeof page.next !== "string" || !page.next))) {
            throw new Error("Réponse Spotify invalide pour l’activité des playlists.");
        }
        for (const item of page.items) {
            if (item?.added_at == null) {
                missingDate = true;
                continue;
            }
            const timestamp = typeof item.added_at === "string" ? Date.parse(item.added_at) : NaN;
            if (!Number.isFinite(timestamp)) {
                throw new Error("Date d’ajout Spotify invalide.");
            }
            latest = latest === null ? timestamp : Math.max(latest, timestamp);
        }
        if (page.next === null) return missingDate ? null : latest;
        if (!page.items.length) throw new Error("La pagination des titres Spotify est incomplète.");
        offset += page.items.length;
    }
    throw new Error("La playlist Spotify dépasse la limite de pagination.");
}

export async function orderPlaylistsByLatestAddition(playlists, spotifyFetch) {
    const ordered = [...playlists];
    let next = 0;
    let failure;

    async function worker() {
        while (!failure && next < ordered.length) {
            const index = next++;
            try {
                const lastAddedAt = await latestAddition(ordered[index].id, spotifyFetch);
                ordered[index] = { ...ordered[index], lastAddedAt };
            } catch (error) {
                failure ??= error instanceof Error ? error : new Error("Erreur Spotify inattendue.");
            }
        }
    }

    await Promise.all(Array.from({ length: Math.min(3, ordered.length) }, () => worker()));
    if (failure) throw failure;

    return ordered.sort((a, b) => {
        if (a.lastAddedAt === null) return b.lastAddedAt === null ? 0 : 1;
        if (b.lastAddedAt === null) return -1;
        return b.lastAddedAt - a.lastAddedAt;
    });
}
