# GitHub Display Names

Chrome extension that replaces GitHub usernames with the user's profile name (when one is set) across github.com. Hover a replaced name to see the `@username`.

## Install
1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select this folder.

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
