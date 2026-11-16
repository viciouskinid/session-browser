---
name: multi-account-login
description: Mandatory whenever an AI assistant designs, changes, reviews or debugs how this app signs in to websites with several accounts, especially Google and other "Continue with" providers. Covers isolated account sessions, saved provider sessions and the account chooser, Log in / Log out, the password vault (offer, save, update), suggestions and auto-fill, opt-in auto sign-in, the Windows Hello gate, the signed-in indicator, failure modes, a code map, and a verification checklist.
---

# Multi-account login (accounts, Google, passwords, auto-fill)

## 1. What the app does

One website tab (a *workspace*) can hold many accounts, each in its own isolated browser session (its own cookies and storage), so being
signed in as one account never affects another. Three separate stores cooperate:

| Store | Holds | Lives in |
|---|---|---|
| **Account sessions** | one isolated partition per account of a website, plus its name, note, state | `store.data.sessions`, partition `persist:...` |
| **Saved sessions** | a provider's login (Google, Microsoft, Apple, Facebook, GitHub) kept so any site's "Continue with ..." can reuse it | `store.data.googleAccounts` (legacy name, has `provider`) and its own partition |
| **Password vault** | username + password per site, encrypted by the OS | `vault.json` (see `src/vault.js`) |

They are independent: logging out of an account never deletes a saved session or a saved password.

## 2. Invariants (never break these)

1. **One partition per account.** Cookies cross between partitions only when the app copies a provider's login cookies on purpose.
2. **One provider login per session.** A session bound to a saved Google session never takes a second Google account; another account gets a session of its own.
3. **Cookie values are never read, logged or shown.** Detection uses cookie names, domains and expiry only.
4. **A password never reaches an app page** (main UI, side panel, top-right box). Only the main process and the target page see it.
5. **Offer to save only after the sign-in has worked**, and only with a known username. A login is identified by site + username (case-insensitive). No username, no save.
6. **Fill only on the exact origin**, in the main frame, re-checked at fill time, and only after a user action, or opt-in auto sign-in for that exact site. Never submit a form that posts to another origin.
7. **A tab is free until it has an account, then locked** to its site. Sign-in trips (Google, SSO, OAuth) are temporary and are never saved as the account's address.
8. **Windows Hello fails closed.** If verification cannot run, nothing unlocks. Turning it on requires a successful verification now.
9. **Log out clears the website's login only.** Provider cookies in the tab, saved sessions and saved passwords stay.
10. **After a logout, auto sign-in must not undo it** until the user logs in on purpose.

## 3. Workflows

### A. First sign-in in the Unassigned session (password or any method)
1. The Unassigned session is an ordinary isolated session with no account yet.
2. When login cookies of the site appear and the page is no longer a sign-in page, the session is **auto-assigned**: named by the Google email if known, else an email found in the page title, else "Account N" (upgraded to an email later if one appears).
3. A fresh Unassigned session is created, so one is always waiting.
4. If the site used a password form, the login is **held in memory** (10 minutes) until the sign-in is confirmed, then offered (workflow G).

### B. "Continue with Google" on another website (the chooser)
1. The site opens Google's sign-in as a popup or redirect. A session **not yet bound** to a saved session of that provider, and with at least one signed-in saved session, shows the **Choose an account** dialog. The popup waits hidden behind it.
2. The list shows **all** signed-in saved sessions of that provider, including accounts that are Closed. Nothing is excluded for being previously used.
3. **Pick one or several.** The first goes to this session, others each get their own session. An account that already has a session on this website is switched to (reopened if Closed), never duplicated.
4. For each pick the app copies the provider's login cookies into the session, then for Google **verifies the email** against what Google reports. A mismatch removes only the provider's cookies and shows an error.
5. The session is bound to the saved session, named by the email, and the waiting popup is **reloaded and shown** (not closed) so Google continues and the site's own login completes. With a redirect flow the page reloads. On a Google-owned site the tab goes to its start page.
6. **Use another account** reveals Google's real sign-in (the popup, or the page). Signing in there is saved automatically (workflow C). **Cancel** closes the waiting popup.

### C. Signing in on Google itself (automatic save)
Whenever Google login cookies appear in any session, the app reads the account email from Google, de-duplicates by email, copies the cookies into the saved session and marks it signed in. A Google that has not answered yet is retried up to three times. The app's own copy of cookies is ignored so it is never mistaken for a new sign-in.

### D. Other providers
Saved sessions panel -> **Add session**: a sign-in window opens for the provider. There is no account lookup, so the session is named by you (Rename). If the window is closed before signing in, the entry is **kept as "Needs sign-in"** so it can be refreshed (Google entries with no sign-in are removed instead).

### E. Log in (an existing account)
1. Select the account (reopening it if Closed). Auto sign-in is allowed again for it.
2. If it is bound to a saved session that is signed in: restore the provider cookies. On a provider-owned site that is the whole login. On any other site go to the site's sign-in page (remembered from before) and say to press **Continue with <provider>**.
3. If the saved session has **expired**: open the provider sign-in window and, when it completes, continue with this account automatically.
4. If it is not bound: go to the site's sign-in page. Saved logins are offered, **the account's own login first** (matched on its name).

### F. Log out
Clears the website's cookies and storage (the whole partition on provider-owned sites), marks the account signed out, blocks auto sign-in for it. The **x** on an open account logs out **and** closes it. On a closed account it removes the account.

### G. Password lifecycle
1. **Capture**: a click or Enter by the user, or a form submit, on a form with a password field reports username and password to the main process (the page address is taken from the frame, never from the page's message). Two-step sign-ins remember the username typed on the first step for 15 minutes.
2. **Confirm**: the sign-in counts as successful when Google sets its login cookie, or the page stops showing a password field and is not another sign-in step. A wrong password is therefore never offered.
3. **Username**: for Google, the email from Google's account lookup. Otherwise the form's username. If none can be read, nothing is saved and a notice says so.
4. **Offer** in the bottom-left box: Save / Not now / Never for this site. An existing login with the same username and a different password is offered as **Update**. A second account on the same site is **New**, never "Update".
5. Logins saved by older versions without a username are removed at startup.

### H. Suggestions, auto-fill and auto sign-in
1. When a sign-in form (or a username step on a sign-in page) appears in the visible tab, and logins exist for that exact origin, the box offers **Use a saved login?** with one button per login (account's own first).
2. A repeat for the same page type within 60 seconds is suppressed (and cleared on Log in / Log out).
3. **Auto sign-in** is opt-in per exact site (Passwords panel, or "Always sign in here"). It runs only if one login clearly applies (the only one, or the account's own), the vault is unlocked, the account has not just logged out, and it has not run for this page type in the last 90 seconds. It fills and submits, and the page script refuses to submit a form whose action is another origin.
4. **Windows Hello** (optional): when on, listing, filling and changing saved logins need verification, and the vault locks again after the chosen time. While locked the box shows "Saved logins are locked" with an Unlock button and no names.

### I. The signed-in indicator
Green = a live login cookie was seen. Red = a login was seen before and is gone, or the user logged out, or the page shows the site's sign-in form. Grey = not detected. **Having no recognised cookie is never evidence of being signed out.**

## 4. Google specifics
- Sign-in cookies are recognised by name (the SID family). Values are never read.
- Email comes from Google's `ListAccounts` endpoint through the account's own session.
- Google may refuse sign-in in an embedded browser. The app does not disguise itself to get around that. The error is Google's.
- A session holds one Google login. Adding a second Google account in the same session overwrites the binding, so use another account session.

## 5. Failure modes

| Symptom | Likely cause | What to check |
|---|---|---|
| Chooser lists nothing | no saved session of that provider is marked signed in | Saved sessions panel: Refresh it |
| "login has expired" | saved cookies lapsed | Log in opens the sign-in window and continues |
| Second user shows "Update" | username came through empty | Google email lookup failed; check `confirmLogin` |
| Signed out but really in | cookie names not recognised | state should be grey, not red |
| Logged out then back in by itself | auto sign-in ran after logout | `noAuto` must block it |
| Fill refused | origin differs from the saved origin | exact scheme, host and port |
| Unlock never appears | Hello unavailable | message from `describe()` in `src/hello.js` |

## 6. Code map

- `syncGoogle` - `src/main.js` - saves Google sign-ins automatically
- `maybeAutoAssign` - `src/main.js` - names and assigns the Unassigned session
- `useGoogle` - `src/main.js` - restores a saved session into one tab
- `useGoogleMany` - `src/main.js` - chooser result, several accounts
- `openGoogleWindow` - `src/main.js` - add / refresh a saved session
- `wantsChooser` - `src/main.js` - when the chooser is offered
- `chooserAccounts` - `src/main.js` - which saved sessions it lists
- `loginSession` - `src/main.js` - Log in
- `logoutSession` - `src/main.js` - Log out
- `clearSiteLogin` - `src/main.js` - what Log out clears
- `refreshLogin` - `src/main.js` - the indicator
- `confirmLogin` - `src/main.js` - success check before an offer
- `maybeSuggest` - `src/main.js` - suggestions and auto sign-in
- `requireUnlock` - `src/main.js` - Windows Hello gate
- `hasLoginCookies` - `src/signin.js` - signed-in test by cookie names
- `forAuthUrl` - `src/providers.js` - which provider a sign-in page belongs to
- `purgeAnonymous` - `src/vault.js` - removes logins without a username
- `setAutofill` - `src/vault.js` - per-site opt-in
- `trySubmit` - `src/sitepreload.js` - submit rules for auto sign-in
- `verify` - `src/hello.js` - the Windows prompt

## 7. IPC channels

`sess:useGoogleMany`, `google:another`, `google:cancel`, `sess:login`, `sess:logout`, `pm:list`, `pm:fill`, `pm:autofill`, `pm:unlock`, `pm:lock`, `hello:set`, `pm:captured`, `pm:page`, `toast:act`

## 8. Verification checklist

Automated (run `npm test`): vault (separate users, no username, purge, auto sign-in opt-in), providers, Hello (fail closed), store (settings cannot switch Hello), signed-in cookie test, site scope, plus the Electron tests where available. This skill's own claims are checked by `tests/skill.test.js`.

Manual, with two Google accounts A and B and one other site X that has "Continue with Google":
- [ ] Sign in to Google as A in a new tab, then as B (Use another account). Both are saved, named by email, none duplicated.
- [ ] On X, Unassigned session, Continue with Google: the chooser lists A and B. Pick A: X signs in as A and the session is named A.
- [ ] Back on X, new Unassigned, pick B: a second session. Picking A again switches to A's session.
- [ ] Close A (x), then Continue with Google again: A is still listed.
- [ ] Log out A (menu): A turns red, B is untouched. Log in: back to green.
- [ ] Sign in to a password site with a wrong password: no offer. With the right one: Save. Second account: "Save", not "Update".
- [ ] Turn on auto sign-in for that site: opening its sign-in page signs in. Log out: it does **not** sign back in until Log in.
- [ ] Turn on Windows Hello: the Passwords panel and suggestions ask for it, then lock after the chosen time.
- [ ] Sign out of everything, restart the app: dots are grey/red only on evidence, and nothing signs in by itself unless auto sign-in is on.

## 9. Known limitations
- Google can block embedded sign-in; nothing here works around that.
- Cookie-name detection cannot recognise every site: its dot stays grey.
- Windows Hello is a gate inside the app, and the PowerShell prompt may appear behind other windows on some PCs. The vault file is protected by Windows account encryption, which Hello does not change.
- Apple, Microsoft, Facebook and GitHub sign-in cookie names are best knowledge and unverified.

## 10. Review log

The skill was checked against the code line by line and by `tests/skill.test.js` (functions, files, channels and invariants named here must exist).
- **Bug found and fixed:** with auto sign-in on, Log out landed on the sign-in form and signed straight back in. Auto sign-in is now blocked for an account after any logout (by the app, or detected when the site ends the login) until a deliberate Log in (invariant 10).
- **Skill corrected:** closing a non-Google "Add session" window early keeps the entry as "Needs sign-in" (it does not discard it).
- **Not verifiable here:** the Windows Hello prompt, Google's live sign-in, and the Electron end-to-end tests need Windows, a network and Electron. They are in the manual checklist (section 8).
