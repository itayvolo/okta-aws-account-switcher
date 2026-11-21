# AWS Account Switcher

Chrome extension (Manifest V3) for switching between AWS accounts and roles
through Okta and IAM Identity Center. Each role's console session is saved, so
switching back to a role you've already logged into is instant.

## Install

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick this folder.
3. Pin the extension from the puzzle-piece menu.

**Updating:** after `git pull`, click **↻** on the extension's card. Chrome keeps
running the old background script until you do. The popup header shows the
version that's actually loaded.

## Setup

1. Open the popup → ⚙ Settings.
2. Enter your Okta domain (e.g. `company.okta.com`) and click **Login**.
   AWS apps are detected from your Okta dashboard.
3. Go back to the account list and click ⟳ to load accounts.

## Usage

| Action | How |
|---|---|
| Open the popup | Toolbar icon or **Alt+Shift+A** (change in `chrome://extensions/shortcuts`) |
| Switch | Click a row (uses the last role you picked) or a role chip |
| Switch in a new tab | **Cmd/Ctrl+click** or **Cmd/Ctrl+Enter** |
| Search | Type a name or account id |
| Keyboard | ↑/↓ move, ←/→ or 1–9 pick a role, Enter switch, Esc clear search |
| Pin to top | ☆ on the right of a row |
| Copy account id | Click the id |
| Sign out of an account | ⇥ on the right of a row |
| Refresh / log in to all / sign out of all | ⟳ / ⚡ / ⇥ in the app header |

Role chips: a green dot means a live session, and amber means under 15 minutes
left (hover a chip to see the time left). ⚡ logs in once per account, using
the last role you picked (otherwise ReadOnly), and skips accounts that already
have a live session.

## Files

| File | Role |
|---|---|
| `manifest.json` | Extension manifest |
| `popup.html` / `popup.js` / `popup.css` | Popup UI |
| `background.js` | Service worker: startup, message router, alarms |
| `okta.js` | Okta login and AWS app detection |
| `aws_login.js` | Federation login, session capture, switching |
| `accounts.js` | Account list refresh, log in/out of all, expiry |
| `endpoints.js` | Region presets, settings migration, role picking (shared) |
| `get_accounts_portal.js` / `get_accounts.js` | Account scrapers (Identity Center portal / classic SAML page) |

Debug logging: set `DEBUG_MODE = true` in `background.js`, reload, and open the
service worker console from `chrome://extensions`.

## Privacy

No credentials are stored. The extension keeps AWS console cookies per role in
`chrome.storage.local` and talks only to Okta and AWS.
