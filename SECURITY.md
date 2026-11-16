# Security note

**Session isolation.** One persistent Electron partition (`persist:sb-<uuid>`) per login session. Cookies are never
swapped in a shared view. Verified by automated tests for cookies, localStorage and IndexedDB.

**What is stored where.**
- `session-browser.json` (in the app's user-data folder, mode 0600): website names and URLs, session labels, partition
  names, last visited origin + path, and download history (file name, saved path, source host name, size, state). Query
  strings, fragments, full download URLs, page titles, passwords, cookies and tokens are not stored.
- Browser data (cookies, storage) lives in the user-data `Partitions/` folder, written by Chromium and protected only by
  OS file permissions. It is **not encrypted by this app**. Use full-disk encryption (BitLocker, FileVault, LUKS) and
  a locked OS account.

**Google account reuse is a deliberate exception to isolation, and is now automatic.** Whenever a Google sign-in cookie
appears in a session, Google and YouTube cookies are copied into a saved Google account (its own partition) so that the
account can be offered on later sign-in screens. Choosing one copies those cookies into the session you pick, so that
session holds a live Google sign-in. Each copy has the same power as the original, so protect the computer accordingly.
Nothing else is shared, and a saved account is only ever copied into a session when you click it.

**Identifying the Google account.** The app makes a request to `accounts.google.com/ListAccounts` using the signed-in
session's own cookies and keeps only the email address from the reply. The email is stored in the metadata file as the
account's name. The request goes to Google only.

**Sign-in detection** inspects cookie names and flags and navigation addresses only. Cookie values are hashed in memory
to notice a changed session id and are not stored or logged. Account labels (such as an email address taken from a page
title) are saved in the metadata file because they are names you would otherwise type.

**Downloads.** Files save to the Downloads folder under a sanitised, non-overwriting name. The Downloads popup refers to a
download only by an opaque id, and the main process looks up the path itself, so the popup cannot make the app open an
arbitrary path. Programs and scripts (such as `.exe`, `.bat`, `.sh`) are revealed in their folder, never launched from the app.
Tab icons are fetched without cookies and held in memory only.

**Password manager.** Saved logins live in `vault.json` (user-data folder, mode 0600). Each username and password is
encrypted with the operating system's secure storage (Electron `safeStorage`: Windows DPAPI, macOS Keychain, Linux
libsecret/kwallet) before it is written. If secure storage is unavailable, or Linux would fall back to its built-in
fixed key (`basic_text`), the app refuses to save anything. It never falls back to plaintext. Only the site address
(origin) is stored unencrypted, so a login can be found.
- A small script (`sitepreload.js`) runs in the main frame of website pages. It exposes nothing to the page. It reports a
  username and password only when *you* submit a login (trusted click or Enter), and the app, not the page, decides which
  site it came from. The page's own scripts cannot call it, read saved logins, or trigger a fill.
- A submitted login is held in memory only until the sign-in is confirmed (a server-side sign-in, or the page no longer asking
  for a password), then offered. It is dropped after 10 minutes. Wrong passwords are never offered. A login with no readable
  username is not saved.
- Saving always asks you first (Save / Not now / Never for this site) in a small bottom-left window (`toast.html`) that never takes
  focus. It shows only fixed text and buttons chosen by the app (a site name and username) and reports only a button press and
  its own height. Filling happens only when you press a button in that box or press Fill on a login in the Passwords panel, never
  automatically on page load, so a hidden form cannot harvest a password.
- A login is only typed into a page with the exact same origin (scheme, host and port), checked again at fill time. Only
  https pages (and http on this computer) can save or receive passwords. Lookalike hosts do not match. Passwords are not
  filled into embedded frames.
- Passwords never reach the app's own UI pages (including the side panel): they see only the site and the username.
- **Saved sessions** (Google, Microsoft, Apple, Facebook, GitHub) keep a provider's login cookies in a separate isolated partition and
  copy them into a tab only when you pick that session. Cookie values are never read, logged or shown. Log out clears a tab's
  cookies and storage but never touches a saved session or a saved password.
- Nothing is logged except the event name.
- **Limits.** Encryption is tied to your operating-system login. It protects the file if it is copied or the disk is read
  offline. It does **not** protect against malware or another person using your unlocked Windows account, because that
  account can ask the OS to decrypt. There is no separate master password. Passwords are not shown or exported by the app.
  Passwords typed in a sign-in popup can be saved, but are filled from the normal tab.

**Credentials.** Typed directly into the website's own page, except where you choose to save them in the password manager above.

**Website isolation from the app.** Websites run sandboxed with context isolation and no Node access. The only preload on a website is the password
manager's `sitepreload.js` described above. Only the app's own UI page has a small, allow-listed IPC bridge, and the main process rejects IPC from any
other sender. The UI page has a strict content-security policy. Non-http(s) navigation and popups are blocked.

**Logging.** Event names and shortened opaque ids only. No URLs, titles, cookies or headers.

**Not done.** No app-level lock or unlock screen. No encryption of partition data at rest. Website authentication,
expiry, MFA and device checks stay under each website's control. Deleting local data signs you out on this device only.

**Auto sign-in.** Opt-in per exact origin (stored in the vault file with the logins). It runs only for the visible tab, only when a single login
clearly applies, at most once per 90 seconds per page type, and the page script refuses to submit a form whose action is another origin.
It reduces typing, not safety: anything that can already read your unlocked Windows account can read the vault.

**Recent pages.** Address (query and fragment removed), title, account and time, in the app's data file. Removed with the account, can be
switched off or cleared in Settings.

**Right-click menus.** Built by the app from fixed templates. A page can influence only the labels of spelling suggestions it did not
choose (they come from the spell checker) and the address a link points to, which is used as a copy or open target.

**Downloads.** Files go to a folder inside Downloads named after the application unless you choose another folder in Settings. A chosen
folder must be an absolute path the app can write to, or it is refused.

**Windows Hello.** An optional gate in this app. The prompt is Windows' own (UserConsentVerifier), reached through PowerShell because Electron has no API for it,
and the app learns only verified or not. It fails closed: no answer, an error or a timeout all mean locked. Turning it on needs a successful verification.
**What it does not do:** it does not change how `vault.json` is encrypted (Windows account encryption). Malware running as you, or anyone with your unlocked
Windows account, can still ask Windows to decrypt the file directly. Hello stops casual use of the app (a walk-up user, a shared screen), not that.

**Account notes** are plain text in the app data file (up to 120 characters). Do not put secrets in them.


## Viewing a saved password (pm:reveal)

- Only the app's own window or side panel may call it. The password is returned to that caller only, never put in the state the pages receive, and never logged.
- The operating system must verify the person on every view (Windows Hello, or Touch ID on macOS). The "unlocked for a while" window used for filling does not count. If no check is available, or it fails, the answer is no.
- The password is shown for 15 seconds, then wiped. It is also wiped when the panel changes tab, loses focus, or the vault locks. At most 6 views per minute.
- Download links: the full address is held in memory only. The saved history keeps the address without query, fragment or credentials.
