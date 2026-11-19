import os
import re
import time
from collections import Counter
from pathlib import Path

import pytest
from playwright.sync_api import expect, sync_playwright

EXT = str(Path(__file__).resolve().parent.parent)

PAGE = """<!doctype html><html><body>
<a id="alice" href="/alice">alice</a>
<a id="bob" href="/acme/repo/commits?author=bob" data-hovercard-url="/users/bob/hovercard" data-hovercard-type="user">bob</a>
<a id="org" href="/acme" data-hovercard-type="organization">acme</a>
<a id="noname" href="/noname">noname</a>
<a id="native" href="/alice">Alice Smith (<span>alice</span>)</a>
<a id="nav" href="/pricing">pricing</a>
<pre><a id="code" href="/alice">alice</a></pre>
<div id="dynamic"></div>
</body></html>"""

NAMES = {"alice": "Alice Smith", "bob": "Bob Jones", "carol": "Carol King", "dave": "Dave Lee"}


def hovercard(login, name):
    secondary = f'<a class="Link--secondary no-underline ml-1" href="/{login}">{name}</a>' if name else ""
    return f'<div><a href="/{login}"><img alt="@{login}"></a><a class="Link--primary" href="/{login}">{login}</a>{secondary}</div>'


class FakeGitHub:
    def __init__(self):
        self.hits = Counter()
        self.rate_limit = {}

    def handle(self, route):
        path = route.request.url.split("github.com", 1)[1].split("?")[0]
        m = re.match(r"^/users/([^/]+)/hovercard$", path)
        if not m:
            return route.fulfill(status=200, content_type="text/html", body=PAGE)
        login = m.group(1)
        self.hits[login] += 1
        if self.rate_limit.get(login, 0) > 0:
            self.rate_limit[login] -= 1
            return route.fulfill(status=429, headers={"Retry-After": "2"}, body="")
        if login not in NAMES and login != "noname":
            return route.fulfill(status=404, body="")
        return route.fulfill(status=200, content_type="text/html", body=hovercard(login, NAMES.get(login)))


@pytest.fixture()
def env(tmp_path):
    gh = FakeGitHub()
    with sync_playwright() as p:
        kwargs = {"executable_path": os.environ["CHROME_PATH"]} if os.environ.get("CHROME_PATH") else {"channel": "chromium"}
        ctx = p.chromium.launch_persistent_context(
            str(tmp_path / "profile"),
            headless=True,
            args=[f"--disable-extensions-except={EXT}", f"--load-extension={EXT}"],
            **kwargs,
        )
        ctx.route("https://github.com/**", gh.handle)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event("serviceworker")
        yield ctx, gh, sw
        ctx.close()


def open_page(ctx):
    page = ctx.new_page()
    page.goto("https://github.com/acme/repo")
    return page


def test_replaces_usernames(env):
    ctx, gh, _ = env
    page = open_page(ctx)
    expect(page.locator("#alice")).to_have_text("Alice Smith")
    expect(page.locator("#alice")).to_have_attribute("title", "@alice")
    expect(page.locator("#bob")).to_have_text("Bob Jones")
    page.wait_for_timeout(500)
    expect(page.locator("#org")).to_have_text("acme")
    expect(page.locator("#noname")).to_have_text("noname")
    expect(page.locator("#native")).to_have_text("Alice Smith (alice)")
    expect(page.locator("#nav")).to_have_text("pricing")
    expect(page.locator("#code")).to_have_text("alice")
    assert gh.hits["pricing"] == 0 and gh.hits["acme"] == 0


def test_cache_shared_across_tabs(env):
    ctx, gh, _ = env
    expect(open_page(ctx).locator("#alice")).to_have_text("Alice Smith")
    expect(open_page(ctx).locator("#alice")).to_have_text("Alice Smith")
    assert gh.hits["alice"] == 1


def test_handles_reused_and_added_links(env):
    ctx, gh, _ = env
    page = open_page(ctx)
    expect(page.locator("#alice")).to_have_text("Alice Smith")
    page.evaluate("""() => {
        const a = document.querySelector('#alice');
        a.setAttribute('href', '/dave');
        a.firstChild.nodeValue = 'dave';
        document.querySelector('#dynamic').innerHTML = '<a id="added" href="/bob">bob</a>';
    }""")
    expect(page.locator("#alice")).to_have_text("Dave Lee")
    expect(page.locator("#alice")).to_have_attribute("title", "@dave")
    expect(page.locator("#added")).to_have_text("Bob Jones")


def test_pauses_after_rate_limit(env):
    ctx, gh, _ = env
    gh.rate_limit["alice"] = 1
    page = open_page(ctx)
    page.wait_for_timeout(800)
    expect(page.locator("#alice")).to_have_text("alice")
    page.evaluate("document.querySelector('#dynamic').innerHTML = '<a id=\"carol\" href=\"/carol\">carol</a>'")
    page.wait_for_timeout(500)
    assert gh.hits["carol"] == 0
    expect(page.locator("#alice")).to_have_text("Alice Smith", timeout=5000)
    expect(page.locator("#carol")).to_have_text("Carol King", timeout=5000)
    assert gh.hits["alice"] == 2


def test_settings_toggle(env):
    ctx, _, sw = env
    page = open_page(ctx)
    expect(page.locator("#alice")).to_have_text("Alice Smith")
    sw.evaluate("chrome.storage.sync.set({showLogin: true})")
    expect(page.locator("#alice")).to_have_text("Alice Smith (alice)")
    sw.evaluate("chrome.storage.sync.set({enabled: false})")
    expect(page.locator("#alice")).to_have_text("alice")
    expect(page.locator("#alice")).not_to_have_attribute("title", "@alice")


def test_prunes_expired_entries(env):
    _, _, sw = env
    old = int(time.time() * 1000) - 8 * 24 * 3600 * 1000
    sw.evaluate(f"chrome.storage.local.set({{'n:old': {{name: 'Old', t: {old}}}, 'n:new': {{name: 'New', t: Date.now()}}}})")
    sw.evaluate("pruneExpired()")
    keys = sw.evaluate("chrome.storage.local.get(null).then(Object.keys)")
    assert "n:new" in keys and "n:old" not in keys
