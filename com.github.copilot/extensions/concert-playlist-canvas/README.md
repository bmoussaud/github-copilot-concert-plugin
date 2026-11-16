# Playlist anti-spoiler

Cette extension Canvas sert l'interface locale `app.html` et son API locale
depuis `extension.mjs`. Elle récupère les setlists par MBID auprès de setlist.fm,
permet de choisir les versions du catalogue Spotify et crée ou remplace une
playlist Spotify **privée** après confirmation explicite.

L'artiste est recherché par son nom sur setlist.fm, puis choisi dans la liste
des correspondances : son identifiant MusicBrainz est récupéré automatiquement.
Si les résultats sont nombreux, préciser le nom pour affiner la recherche.

La source retient jusqu'à cinq concerts renseignés sur les douze derniers mois,
en privilégiant la tournée la plus récente lorsqu'elle comporte cinq concerts.
Chaque concert retenu comporte un lien vers setlist.fm ; l'ouvrir peut révéler
l'ordre du concert.
Si elle en contient moins, les cinq concerts renseignés les plus récents sont
utilisés. Les titres sont dédoublonnés et présentés par ordre alphabétique
avant leur classement par album, jamais dans l'ordre des concerts. Si moins de
cinq concerts sont disponibles, l'interface demande l'accord de l'utilisateur
avant d'élargir la recherche ou de continuer avec une couverture incomplète.
Les correspondances proposées doivent être vérifiées : le catalogue ne permet
pas de garantir automatiquement qu'il s'agit de la version studio d'origine.
La proposition unique, ou celle apparaissant dans le plus grand nombre de
recherches de la préparation, est présélectionnée. En cas d'égalité, la première
proposition Spotify est retenue. Les choix manuels sont conservés et les titres
sans résultat sont mis en évidence ; une erreur de recherche reste distincte.
Le menu de sélection affiche les pochettes Spotify disponibles pour chaque version.
Pour une reprise, la recherche utilise l'artiste d'origine indiqué par setlist.fm
ou uniquement le titre si cet artiste est absent ou ambigu.
Chaque titre peut être corrigé dans la sélection et relancé sur Spotify sans
modifier son nom dans la setlist d'origine : cliquer sur le titre révèle le
champ et sa loupe de recherche. Échap annule l'édition ; une recherche réussie
replie le champ, tandis qu'une absence de résultat le laisse ouvert.
Si une recherche reste vide, un article anglais initial (`The`, `A`, `An`)
est retiré pour un second essai. Seuls les résultats dont le titre et, lorsqu'il
est connu, l'artiste correspondent après normalisation sont conservés.
Dans l'aperçu, les playlists privées proposées pour remplacement sont classées
selon la date du dernier titre ajouté, de la plus récente à la plus ancienne.
Ce n'est pas leur date de création, que Spotify ne fournit pas. Les playlists
vides ou comportant des dates d'ajout manquantes sont placées en dernier. Le
classement charge uniquement les dates d'ajout et s'effectue pendant la
sélection ; en cas d'échec, l'interface le signale et permet de réessayer.

## Configuration

- Définir `SETLISTFM_API_KEY` dans l'environnement utilisateur. Copilot demande
  l'autorisation de transmettre cette variable à l'extension.
- Définir `SPOTIFY_CLIENT_ID` dans l'environnement utilisateur. Aucun Client
  Secret n'est utilisé : la connexion utilise OAuth Authorization Code avec PKCE.
- Dans le Spotify Developer Dashboard, ajouter exactement
  `http://127.0.0.1:43821/callback` comme Redirect URI.
- Recharger Copilot après avoir modifié les variables d'environnement.

La connexion Spotify utilise les portées `user-read-private`,
`playlist-read-private` et `playlist-modify-private`. Les jetons restent en
mémoire dans le processus local de l'extension et sont supprimés à sa fermeture.
Le serveur ne se lie qu'à `127.0.0.1`. L'action Copilot ne retourne aucun titre,
résultat Spotify, URI, jeton ni ordre de concert; ces données restent dans le
Canvas et le processus local. Seul un aperçu trié par albums peut être enregistré.
Les requêtes de modification de l'API locale exigent une origine identique à
celle du Canvas et un corps JSON. Une écriture Spotify interrompue peut laisser
une playlist partiellement modifiée; l'interface invite à la vérifier avant
de réessayer.

`prototypes/anti-spoiler-flow.html` reste la maquette statique de présentation;
le Canvas de l'extension utilise l'interface fonctionnelle `app.html`.

Les tests ciblés s'exécutent depuis la racine du dépôt avec Node.js :
`node --test tests\concert-playlist.test.mjs`.
