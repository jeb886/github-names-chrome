# GitHub Display Names

Chrome extension that replaces GitHub usernames with the user's profile name (when one is set) across github.com. Hover a replaced name to see the `@username`.

## Install
Works in Chrome, Edge, Brave and other Chromium browsers. It isn't on the Chrome Web Store, so it's installed in developer mode:

1. Download `github-names-chrome-vX.Y.Z.zip` from the [latest release](https://github.com/jeb886/github-names-chrome/releases/latest).
2. Unzip it. You get a `github-names-chrome` folder; keep it somewhere permanent, because Chrome loads the extension from that folder.
3. Open `chrome://extensions` (Edge: `edge://extensions`).
4. Turn on **Developer mode** (top right).
5. Click **Load unpacked** and select the `github-names-chrome` folder (the one that contains `manifest.json`).
6. Open any GitHub page. Pin the extension from the puzzle-piece menu to reach its settings.

**Update:** download the new zip, replace the folder's contents, then click the reload icon on the extension's card in `chrome://extensions`.

**From source:** clone this repo and use **Load unpacked** on the repo folder.

## How it works
- Finds user links (`/username`, `?author=username`, GitHub hovercard links) whose text is the username and swaps in the profile name. Organizations, code blocks and editors are skipped.
- Names come from the same hovercard GitHub shows on hover (`/users/<name>/hovercard`) — no API token or REST rate limit.
- Each name is cached for 7 days (one storage key per user, shared by all tabs); expired entries are pruned when Chrome starts.
- If GitHub rate-limits (HTTP 429/403), all tabs pause lookups for `Retry-After` (or 5 minutes) and then resume.
- Watches page changes, including GitHub reusing a link for a different user.
- Popup: toggle on/off, optionally show `Name (username)`, clear cache.

## Tests
```
pip install -r requirements-dev.txt
python -m playwright install chromium
python -m pytest tests
```
Tests load the extension in headless Chromium against a mocked github.com.

## Releasing
Bump `version` in `manifest.json`, merge to `main`, then push a matching tag (`git tag v1.1.0 && git push origin v1.1.0`). The Release workflow packages the extension and publishes the zip.
