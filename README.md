# Concert playlist plugin

Prepare a private Spotify playlist for an upcoming concert without revealing
the order in which songs were played. This GitHub Copilot plugin includes a
local canvas for the GitHub Copilot App.

The canvas searches setlist.fm for an artist and recent concerts, collects
distinct songs, and lets you choose their Spotify versions. The preview groups
tracks by album, from newest to oldest, with cover songs at the end. You can create
a private playlist or replace an existing private playlist that you own.
Nothing is written to Spotify until you confirm.

## Requirements

- A GitHub Copilot App installation that supports canvas extensions, and a
  local session on the computer where the browser runs.
- A [setlist.fm API key](https://www.setlist.fm/settings/api). Sign in or
  [create an account](https://www.setlist.fm/signup) first. See the
  [API documentation](https://api.setlist.fm/docs/1.0/index.html) for terms.
- A Spotify account and a Spotify developer application. For an application in
  development mode, Spotify requires the **app owner** to have Premium and
  limits access to up to five authorized users. See
  [Spotify quota modes](https://developer.spotify.com/documentation/web-api/concepts/quota-modes).
- Internet access and local port `43821` available for the Spotify callback.
  No Azure resources or hosting are required.

## Install from the marketplace

The repository includes an Agent Plugins 1.0 plugin and a GitHub-hosted
marketplace catalog. Once these files are published to the repository's default
branch, install it in GitHub Copilot App:

1. Open **Customize** and choose the marketplace settings beside the marketplace
   selector.
2. Add `bmoussaud/github-copilot-concert-plugin`.
3. Browse for **concert-playlist** and select **Install**.
4. Configure the setlist.fm and Spotify credentials below, then restart Copilot
   App and start a new local session. Approve the extension and environment
   variable permission if prompted.

The marketplace catalog is `.github/plugin/marketplace.json`; the plugin
manifest is `plugin.json`. The canvas implementation is bundled under
`com.github.copilot/extensions/concert-playlist-canvas`. The whole repository
is the plugin source, so no separate hosting or `npm install` is needed.

Copilot CLI can also install the plugin from the same marketplace:

```powershell
copilot plugin marketplace add bmoussaud/github-copilot-concert-plugin
copilot plugin install concert-playlist@concert-tools
```

The canvas UI requires a canvas-capable host such as GitHub Copilot App; CLI
installation alone does not provide a graphical canvas.

## Configure setlist.fm and Spotify

1. Apply for a [setlist.fm API key](https://www.setlist.fm/settings/api).
2. Sign in to the [Spotify Developer Dashboard](https://developer.spotify.com/dashboard)
   and create an application, or use an existing one.
3. In the Spotify application's settings, add this exact redirect URI and save:

   ```text
   http://127.0.0.1:43821/callback
   ```

   Use `127.0.0.1`, not `localhost`. The port and path must match. See
   [Spotify redirect URI requirements](https://developer.spotify.com/documentation/web-api/concepts/redirect_uri).
4. Copy the Spotify application's **Client ID**. This extension uses OAuth
   authorization code with PKCE and does **not** require a Client Secret.
   If another Spotify account will use a development-mode app, add it under
   **Settings > Users Management** in the Spotify dashboard.
5. On Windows, search for **Edit environment variables for your account**.
   Add these user variables with your own values:

   | Variable | Value |
   | --- | --- |
   | `SETLISTFM_API_KEY` | Your setlist.fm API key |
   | `SPOTIFY_CLIENT_ID` | Your Spotify application's Client ID |

6. Quit GitHub Copilot App completely, reopen it, and start a new local session
   so the plugin inherits the variables. If Copilot asks permission to pass
   `SETLISTFM_API_KEY` to the extension, approve it.

On other platforms, make both variables available to the process launching
Copilot App. A graphical app may not inherit variables from shell startup files.

Do not put the key in the repository or paste it into chat. To check that the
Windows user variables exist without displaying their values:

```powershell
foreach ($name in 'SETLISTFM_API_KEY', 'SPOTIFY_CLIENT_ID') {
    $value = [Environment]::GetEnvironmentVariable($name, 'User')
    Write-Output ("{0}: {1}" -f $name, (-not [string]::IsNullOrWhiteSpace($value)))
}
```

## Create a playlist

1. In a local Copilot App session where the extension is installed, ask:
   **“Open the Spoiler-free playlist canvas.”**
2. Under **Source**, search for the artist and select the correct result.
   The MusicBrainz identifier is retrieved automatically. Load the setlists;
   if coverage is incomplete, choose whether to expand the search or continue.
   Each selected concert links to setlist.fm; opening it can reveal the concert order.
3. Under **Connect**, sign in to Spotify and grant the requested permissions.
4. Under **Selection**, check the proposed versions, edit a search title if
   necessary, or exclude a song. Missing matches are highlighted. Spotify album
   artwork is shown in the version menu when available. Covers are searched by
   their original artist when known, or by title alone otherwise.
5. Under **Preview**, review the album-sorted tracks and choose whether to
   create a playlist or replace an owned private playlist.
6. Under **Confirmation**, explicitly confirm the Spotify write.

The source uses up to five recent documented concerts, preferring the latest
tour when it has five; otherwise it uses the most recent concerts. A version
appearing most often among this preparation's search results is preselected,
with Spotify's first result breaking ties. Verify matches yourself: the
original studio version cannot be guaranteed.

The existing-playlist menu is ordered by the latest track addition, **not**
playlist creation date. Empty playlists and playlists with missing addition
dates appear last. Spotify may rate-limit this lookup.

## Privacy and troubleshooting

- Spotify authorization uses a browser and the loopback callback. Tokens are
  kept in the extension process's memory, not persisted; reconnect after an
  extension or app restart. In-progress canvas selections can also be lost
  when the canvas reloads.
- Spotify search results and playlists remain in the local canvas and extension
  process; the extension's agent action does not return their contents to
  Copilot. Artist and track searches are still sent to setlist.fm and Spotify,
  respectively, and artwork is loaded from Spotify's image service.
- **Canvas not found:** confirm the marketplace plugin is installed and enabled,
  restart the app, and use a local session.
- **Missing key or Client ID:** check the user variables, approve any extension
  permission prompt, and restart the app. A variable set in a different
  process may not be inherited by an already-running app.
- **Spotify authorization fails:** check the exact redirect URI, that port
  `43821` is free, and the development-mode Premium and user-allowlist rules.
- **Write interrupted:** a playlist may have been created or partially
  replaced. Check it in Spotify before retrying.

For canvas details, see the
[GitHub Copilot App canvas documentation](https://docs.github.com/en/copilot/how-tos/github-copilot-app/working-with-canvas-extensions).
For marketplace publishing details, see the
[GitHub plugin marketplace documentation](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/create-and-share-plugin-marketplaces).

## Development

To run the local tests from the repository root, install Node.js and run:

```powershell
node --test tests\concert-playlist.test.mjs
```
