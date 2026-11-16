# Session Browser

A desktop browser where **tabs are websites** and a **sidebar lists separate logins** for the selected site.
Open Gmail once, stay signed in as Personal and Work at the same time, and switch with one click.

Built with Electron (Chromium). Every login session gets its own persistent Chromium storage partition,
so cookies, localStorage, IndexedDB, cache and service workers are never shared between sessions.

## Run it

Requires Node.js 20 or newer.

```
npm install
npm start
```

Linux: if Electron reports a sandbox error, run `npx electron . --no-sandbox`, or fix the SUID sandbox helper.

## Build a Windows app

Double-click `build-exe.bat` (it sits next to `package.json`). It installs dependencies and packages
`dist\SessionBrowser-win32-x64\SessionBrowser.exe` and launches it when the build finishes. Keep that whole folder together. Windows SmartScreen may warn
because the app is unsigned. The script is excluded from the packaged app.

## Using it

The tabs sit in the window's title bar, like Chrome's, with the system minimise/maximise/close buttons at the right. There is
no menu bar: the **three-dot menu** at the right of the toolbar holds New website, Downloads, Show/Hide accounts panel,
Cut/Copy/Paste/Select all, Reload, Open in system browser and Exit. The **Accounts** button at the left of the toolbar
shows or hides the left panel (it remembers your choice).

1. Press **+** (Ctrl/Cmd+T) and enter a site such as `mail.google.com`. Each website is a Chrome-style tab with its own icon.
2. The **Unassigned session** at the top of the sidebar is a signed-out page for that website. Sign in on the website's own
   page. Nothing else to press. Clicking **Unassigned session** only ever shows that signed-out page. It never turns into
   something else and never adds another entry.
3. When sign-in is detected, the session moves into **Accounts** and is selected, and a fresh Unassigned session is ready
   for the next login. If you signed in with Google it is named after that Google account's email. Otherwise it is named
   after an email in the page title, or "Account 1", "Account 2". Use **Rename** any time.
4. Click any account to switch. Click **Unassigned session** again to sign in to another one.
5. Right-click an account for **Rename**, **Close** and **Remove**. **×** at the right of an account closes it: it is unloaded (frees memory), stays signed in, and reopens when you click it.
   Press **×** on a closed (greyed) account to remove it and delete its saved login. **×** on the Unassigned session starts
   over with a fresh signed-out one.

Closing a website tab deletes all its sessions from this computer. Your online accounts are never deleted.
If detection misses a site, **Name it manually** appears under the Unassigned session as a fallback.

### Downloads

The download button in the toolbar (or **Ctrl/Cmd+J**) opens a Downloads panel docked on the right of the page (not an overlay): progress, speed and time left,
**Pause / Resume / Cancel**, **Open**, **Show in folder**, search, and **Clear all**. Files save straight to your Downloads folder
without overwriting anything. Finished downloads are remembered; a file that was moved or deleted is marked. Programs and
scripts (for example `.exe`) are shown in their folder instead of being run from the browser. Removing an entry never deletes the file.

### Side panels (Downloads, Passwords, Saved sessions)

Three icons at the top right each open and close their own panel on the right: **Downloads**, **Passwords** (the key) and
**Saved sessions** (the two people). Pressing another icon switches the panel, and pressing the same one closes it. The
Passwords panel lists saved logins (site and username, with Remove), an **Auto sign-in** switch per site and a **Fill** button for the logins of the page you have
open. The Saved sessions panel lists saved sign-ins and lets you add, refresh, rename and remove them.

### Auto sign-in (opt-in per site)

Off by default. Turn it on for a site from the Passwords panel, or press **Always sign in here** in the bottom-left suggestion. When that site's
sign-in page opens, the saved login is filled **and submitted** by itself, but only when one login clearly applies (it is the only
one, or it is the account's own), only on that exact site, and never into a form that posts to another site. If a sign-in fails it is
not retried for 90 seconds, so a wrong password cannot lock you out by looping.

### Password manager

When you sign in to a site, a small box appears at the **bottom left** (it never takes focus and can be dismissed with ×):
**Save / Not now / Never**. It appears only **after the sign-in has worked** (a wrong password is never offered). Each saved login is tied to a site
**and a username**, so two accounts on one site stay separate. For Google the username is read from Google itself. Saved logins
are encrypted with your computer's secure storage (Windows DPAPI). When a sign-in form appears for a site you have a login for,
the same box offers **Use a saved login?**. Nothing is ever filled until you press a button, and only on the exact site it was
saved for. The Passwords panel (key icon) also has a Fill button for the open page. If secure storage is unavailable nothing is saved. See `SECURITY.md`.

### How sign-in detection works

It uses login-looking cookie *names* (for example `sessionid`, `SID`, `auth_token`) appearing or changing after the page
first loaded, and the page moving off a login-looking address. Cookie values are only hashed in memory to notice a
refreshed session id. Sign-in detection never reads page content. Only the password manager reads the login form, and only when you submit it. It is a heuristic. Some sites will not
trigger it, and rarely a refreshed session cookie may convert a session early. Nothing is lost by that, because it is the
same session.

### Saved sessions (Google, Microsoft, Apple, Facebook, GitHub)

- A **saved session** keeps one sign-in so any website that asks you to "Continue with" that provider can use it without
  signing in again. Google sessions are saved **automatically** when you sign in to any Google site (and named after the email).
  For the other providers use **Saved sessions → Add session**, sign in in the window that opens, and give it a name with Rename.
- Whenever a session reaches a provider's sign-in page (for example after pressing "Continue with Google"), a **Choose an
  account** dialog lists **all** saved sessions of that provider, including ones whose account is Closed. Tick one, several, or
  **Select all**. **Use another account** continues to the provider's own sign-in (as a modal window when it was a popup).
  A session already tied to a saved session of that provider keeps it and is not offered the chooser.
- "Sign in with" popups and OAuth windows open as a modal window over the app, sharing the page's session, never as a new tab.
- Only Google offers an account lookup, so only Google sessions are checked against an email when they are used.

To learn the email, the app asks Google (`accounts.google.com/ListAccounts`, the call Chromium itself makes) using that
session's own cookies, and keeps only the email address. This is the one place the app reads an identity from a signed-in
session. If the lookup fails the account is saved as "Google account N" and renamed when the lookup works.

Only **Google and YouTube cookies** are copied into the session you pick. Local storage, IndexedDB and other site data are
never copied, and sessions you do not pick are untouched.
Shortcuts: Ctrl/Cmd+L address bar, Ctrl/Cmd+T add website, Ctrl/Cmd+R reload.

## Accounts list

Right-click an account for **Rename, Log in, Log out, Open, Remove**. The Unassigned entry has no menu. It becomes an account by
itself when a sign-in is detected, and its × starts it over.

- **Log out** ends the login of *that website* for the account (its cookies and storage) and keeps the account listed as signed
  out. A saved Google/Apple/... session in the tab is left alone, so logging back in is quick. On a provider's own site
  (mail.google.com, github.com) the site's cookies are the provider login, so those go too.
- **Log in** goes to the website's own sign-in page (remembered from the last time you saw it) and the bottom-left box offers
  the saved login for that account first. If the account uses a saved session it is restored first, then press
  **Continue with Google** (or the provider's button). If the saved session has expired a sign-in window opens and the account
  carries on by itself afterwards.
- The **×** on an open account logs it out and closes it. On a closed account it removes it. Drag an account to reorder it.

## Address bar

Each tab has a default address, fixed once the tab exists. While you are on it, the bar shows it read-only. After you navigate
away the bar splits: the default address (click to return to it) beside the real address.

## Signed-in indicator

Each account shows a dot: **green** signed in, **red** signed out (its login has expired or was ended), **grey ring** if the app has
not detected a sign-in for it. It is worked out from the site's login cookies (names only, values are never read) and updates
live, including for closed accounts.

## Search and Settings

**Search** (Ctrl+K or the magnifier icon) is a floating panel that finds accounts, websites, saved sessions, saved passwords (site and
username only) and commands. Arrow keys move, Enter opens, Esc closes. Results are ranked: exact title, title starts with, title
contains, then secondary text. Every state is explained (no results, nothing typed yet, passwords could not be searched).

**Settings** has a category rail (General, Appearance, About). Changes apply and save immediately.
- **Appearance:** Light / Dark / System mode (System uses your chosen light and dark themes), a gallery of **100 themes** with search,
  category filters and recently used, a 24-colour accent palette plus a custom colour, density, corner style, text size and motion,
  and a **custom theme builder** (four colours, live preview, contrast check, save, update, duplicate, delete). Every theme is
  contrast-checked by the tests. Websites that follow the system appearance (auto) follow the app's theme.
- **General:** default home page for new tabs and the **download folder**. The default is a folder named after the application
  inside your Downloads folder.

## Right-click menus

Spelling: right-click a misspelled word in a text field for **Spelling** (all the corrections in one submenu) and Add to dictionary. Links, images, media, text fields,
selected text and plain page areas each get their own items (see `src/contextmenu.js` and its tests). A password field never offers Cut or Copy.

## Tabs and their addresses

A tab's address is **free until an account is signed in**. In a new tab you can type any address, and if you go to a different site
(by typing, a redirect or a link) the tab's default address and name follow you. **Once the tab has an account it is locked** to its
site: the default address becomes read-only, the bar splits into the default (click to return) and the real address when you
navigate away, and links or typed addresses for other sites open in tabs of their own. Remove the last account and the tab is free again.

## Recent pages

Pages you open in an account are remembered with that account (address and title, never the part after `?` or `#`) and show up in
Search under Recent pages. Opening one switches to its account, reopening it if it was closed. They go when the account is removed.
Settings → General can turn this off or clear it.

## Notes, history search, spinner

- **Account notes:** right-click an account, Add note. The note shows at the bottom of the account's entry. Hovering an account shows its full name, state and note.
- **Search is a history search.** Ctrl+K lists the pages you visited (newest first, grouped by day) and typing filters them. The Everything scope adds accounts, websites, saved sessions, passwords and commands.
- **Loading spinner:** shown while a page has nothing on it yet (before it starts, or while it is blank), and gone as soon as there is content.
- **Download panel footer:** shows the combined download speed while anything is downloading.

## Windows Hello for saved passwords

Settings → General → Saved passwords and Windows Hello. When on (Windows only), saved logins can be listed, filled, auto-used or changed only after Windows
verifies you (PIN, fingerprint or face), and lock again after 1, 5, 15 or 60 minutes. Saving a new login never asks. Turning it on needs a successful
verification first, so a PC where it does not work cannot lock you out. See `SECURITY.md` for what this does and does not protect against.

## Skill: how multi-account sign-in works

`skills/multi-account-login/SKILL.md` describes the whole design (accounts, saved sessions and the Google chooser, Log in / Log out, the
password vault, suggestions, auto-fill, auto sign-in, Windows Hello), its invariants, a code map and a manual test script.
`tests/skill.test.js` fails if the skill names a function, file or channel that no longer exists.

## Staying on one website

Every session belongs to one website and cannot wander to another domain. Sign-in trips (Google, Microsoft, Apple, OAuth,
SSO, popups) are allowed **temporarily**. They never become the session's saved address, so closing, reopening or restarting
always returns to the site. A link or typed address that leads to a **different** site opens as its own website tab and the
account stays put. A blank tab takes the site you type, not wherever a sign-in redirect lands. Related domains count as one
site (for example Google and YouTube, or claude.ai and anthropic.com).

## Build stamp

The footer of the accounts panel (and Settings) shows `Build YYYY-MM-DD HH:MM:SS`. It lives only in `src/ui/build.js` and is set
on every code change, last. Timezone: Australia/Melbourne. If no clock is available it shows `Build unknown · vN` instead.

## Tests

```
npm test                    # Windows, macOS, desktop Linux
xvfb-run -a npm test        # headless Linux
```

Tests run the real app against a local server with test-only credentials and check: cookie, localStorage and
IndexedDB isolation between two sessions on one origin; clearing one session leaves the other intact; sessions,
selected site and selected account survive a restart; deleted profile storage and corrupt metadata are
handled; no cookie values or query strings reach the metadata file; the single Unassigned session (reused, replaced after sign-in); automatic Google account saving and naming; closing sessions;
the download manager (progress, pause, cancel, safe names, history, no URLs stored).

## Known limitations

- **Google sign-in may be refused.** Google and some other providers block embedded browsers. This app does not
  disguise itself to get around that. **Open in system browser** in the toolbar opens the page in your normal
  browser, but that browser does not share this app's sessions.
- **No extensions** (no Chrome Web Store, uBlock, or password-manager extensions).
- **No Widevine DRM**, so Netflix, Spotify web and similar services will usually not play.
- **No Chrome sync or bookmarks.** The password manager fills on click only, has no master password, and cannot import or export.
- **Sign-in detection is a heuristic** (see above), with the manual button as the fallback. Account names come from an
  email address in the page title, so sites that do not show one get a placeholder.
- **Google handling is untested against real Google.** It is tested with a stand-in server. The email lookup uses an
  undocumented Google endpoint that may change. Google may refuse its sign-in window in an embedded browser, may expire
  copied logins, and signing out of Google in one copy can end the others. Use **Refresh** if a saved account stops working.
- **No password "show" (eye) button.** That button is a feature of Edge and Chrome's own browser layer, which Electron does
  not include. Sites that draw their own eye button still show it.
- **Memory:** each open session runs its own renderer. Sessions load lazily, but memory grows as you open more.
- **Security updates** track the bundled Electron version. Update it regularly.
- Website permissions (camera, microphone, location, notifications) are denied. Downloads go to the Downloads folder with no save dialog.
- QUIC/HTTP3 is switched off. It opens UDP sockets, which is what makes Windows Firewall ask whether to allow the app.
- On macOS the standard application menu is kept (the system needs it for Cmd+C/V). Windows and Linux have no menu bar.
- Tabs can be reordered by dragging. Dragging a tab out into its own window is not built.
- Not yet built: duplicate session, import/export, themes toggle, installers (only the unsigned portable folder from `build-exe.bat`).
- Only tested here on Linux under a virtual display. Windows and macOS are untested.

See `SECURITY.md`.


## Added in this version

- **Closing a tab** only warns when it holds real accounts (or a waiting session that looks signed in). An empty tab closes at once.
- **Sign-in detection** re-reads cookies and retries for about 40 s while a page is still loading or still on a sign-in-looking address. A completed login form also names a waiting session, for sites whose login cookies are not recognisable.
- **Downloads** show the date and time. Right-click a row for Open, Show in folder, **Copy download link**, and Remove/Pause/Cancel. The full link is kept in memory only; after a restart the copied link has no `?` or `#` part.
- **Settings > General**: **Search engine** (ten built in, or your own address with `%s`; used by the address bar and "Search the web for") and **Fastest download speed recorded** (smoothed, with date and file, resettable).
- **Passwords > View** shows one password for 15 seconds after Windows Hello (or Touch ID) verifies you, fresh every time. Other systems refuse.
- **Logo**: `assets/icon.png` and `assets/icon.ico` (window, taskbar and the packaged exe via `build-exe.bat`); `src/ui/logo.png` inside the app.
- **Download balloons**: a balloon when a download starts (**Open when complete**) and when it ends (**Open**, **Show in folder**). Right-click a running download for the same Open when complete switch. Programs are shown in their folder, never run.
- **Signed-in detection** also reads the page's own storage (a token under a name like token, jwt, auth or session) and remembers a sign-in completed in a form, so sites that do not use recognisable cookies show as Signed in at start-up. Only a yes or no leaves the page.
- **History** lists every page opened in any tab, with or without an account (up to 1000), each with its date and time, and the date is searchable too. Removing an account removes its pages; visits from tabs without an account are kept.
- **Sign-in on load**: a waiting session kept from an earlier run that already holds a live login (or a stored token) is named as an account at start-up, instead of waiting for a cookie to change.
- Back, forward, reload, add-tab and close icons are drawn as SVG so they are centred in their circles.
