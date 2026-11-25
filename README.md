# Telegram Channel Scraper → Excel

Collects messages (text and links) from Telegram channels you choose, filters them by keyword,
and saves them to an Excel report. It can collect **past messages (chat history)** and
**new incoming messages (live)** in the same run.

There are two versions with the same features and the same Excel layout:

| | **Web app** (`web/`) | **Python script** (repository root) |
|---|---|---|
| How you use it | Open a website. Nothing to install | Run on your computer |
| Interface | Graphical: buttons, filters, live view | Command line + `config.yaml` |
| Hosting | On your own computer (private), or GitHub Pages for testing | Your own machine |
| Good for | Everyday use, any device | Long unattended runs, automation |

---

# Web app

Two ways to open it:

- **On your computer (private, recommended):** double-click `start-web.bat` (Windows) or run
  `./start-web.sh` (macOS/Linux). See [Running it privately](#running-it-privately-on-your-computer).
- **Online for testing:** https://solosoosi.github.io/Telegram/ (once GitHub Pages is enabled,
  see below).

Add `#demo` to the address to try it with sample data, no login needed.

## How it works

The site is static: just HTML, CSS and JavaScript. When you log in, **your browser connects
directly to Telegram's servers** over an encrypted WebSocket using [GramJS](https://gram.js.org)
(the JavaScript version of Telethon). No server of ours ever sees your keys, your login or
your messages. The Excel file is created in your browser too.

## Using it

1. **Log in.** Enter your api_id and api_hash from <https://my.telegram.org> (*API development
   tools*) and your phone number, or click **Load credentials file** to use a `credentials.ini`
   file. The same file works with the Python version, and **Save as file** creates one.
   Then enter the code Telegram sends you, plus your 2-step-verification password if you have one.
2. **Channels.** Type `@username`, a `t.me` link or a channel ID, or click **Browse my channels**
   to pick from the channels and groups you've joined, including private ones.
3. **Keywords.** Add as many as you like, choose **Any** or **All**, and switch on case-sensitive,
   whole-words or search-inside-links matching if you need them. With no keywords, every
   message is collected.
4. **Period and method.** Pick *From* and *To* (or use the quick buttons), then choose
   *History + Live*, *History* or *Live only*. With a *To* date in the future, the app keeps
   listening for new messages until then.
5. Click **Start collecting**. Results appear as they come in, with keyword highlights,
   search, a channel filter and direct links. Click **Export Excel** at any time, including
   while it is still listening.

Your channels, keywords and options are remembered in your browser, but the dates are
chosen each time.

## Login security

- **Default:** your login lasts only for the current browser tab and is gone when you close it.
- **"Remember me on this device":** the login is saved on this device only, **encrypted with
  AES-256** using a passphrase you choose (PBKDF2 with 310,000 iterations). Next time you
  just enter the passphrase.
- **Log out** ends the Telegram session and deletes anything saved on the device. You can
  also end it from Telegram under *Settings → Devices*.
- The site uses a strict Content-Security-Policy. It can only run its own code and can only
  connect to Telegram's servers.
- Keep the page open while collecting: browsers pause background tabs, so live listening needs
  the tab to stay open. For collections that run for days, use the Python version.

## Running it privately on your computer

1. Install **Node.js** once from <https://nodejs.org> (choose the LTS version).
2. Double-click **`start-web.bat`** (Windows) or run **`./start-web.sh`** (macOS/Linux).
   The first start takes a minute to install. After that it opens your browser at
   **http://127.0.0.1:8765**.
3. Keep the window open while you use the app. Close it, or press Ctrl+C, to stop.

The app is served **only to this computer**. Other devices on your network can't open it, and
it doesn't depend on GitHub. It still connects to Telegram, because that's where the messages
come from. Always use the same address (`127.0.0.1:8765`): the browser keeps a remembered login
and your settings separately for each address, so the GitHub Pages site and the local app don't
share them.

## Turning off the public test site

When testing is done: GitHub → repository → **Settings → Pages** → **Unpublish site**
(or set Source to *None*), and disable the workflow under **Actions → "Web app - test &
deploy to GitHub Pages" → ⋯ → Disable workflow**. You can then also make the repository
private (**Settings → General → Danger Zone → Change visibility**). The local app keeps
working either way.

## Deploying to GitHub Pages for testing (one time)

1. On GitHub, open the repository → **Settings → Pages**.
2. Under **Build and deployment → Source**, choose **GitHub Actions**.
3. Run the workflow: **Actions → "Web app - test & deploy to GitHub Pages" → Run workflow**.
   Later pushes that change `web/` on the default branch redeploy automatically.

The workflow (`.github/workflows/pages.yml`) runs the tests, builds the site and publishes it.

## Developing the web app

```
cd web
npm install
npm start        # build + run privately at http://127.0.0.1:8765 (what start-web does)
npm run dev      # dev server with live reload
npm test         # unit tests
npm run build    # production build in web/dist
```

---

# Python script

## 1. One-time setup

**Requirements:** Python 3.9 or newer.

1. **Get your Telegram API keys.** Log in at <https://my.telegram.org> → *API development tools* →
   create an app (any name). Note the **api_id** and **api_hash**.
2. **Install and run:**
   - **Windows:** double-click `run.bat`
   - **macOS / Linux:** `./run.sh`

   On first launch these create a private Python environment and install the dependencies.
   (Manual alternative: `pip install -r requirements.txt` then `python scraper.py`.)
3. **Log in.** On the first run, a short wizard asks for your api_id, api_hash (hidden while you
   type) and phone number, and saves them to `credentials.ini`. Telegram then sends you a login
   code (and asks for your 2-step-verification password if you have one).
   **After that, the scraper logs in automatically. You never need to open the Python code.**

To change the saved account details later, run `python scraper.py --setup` (or `run.bat --setup`).

## 2. Choose channels and keywords: `config.yaml`

Open `config.yaml` in any text editor:

```yaml
channels:
  - "@somechannel"               # public username
  - "https://t.me/otherchannel"  # public link
  - "-1001234567890"             # private channel ID

keywords:          # leave empty ( keywords: [] ) to collect everything
  - bitcoin
  - ביטקוין

keyword_options:
  match: any             # any | all
  case_sensitive: false
  whole_word: false
  search_in_links: true

timezone: local          # or e.g. Asia/Jerusalem, UTC
output_folder: output
```

**Private channels:** you must already be a member. Run `python scraper.py --list-channels` to
see the channels and groups you've joined, with their IDs, and copy the ID into `config.yaml`.

## 3. Run it (choose the dates each time)

Run without dates and the scraper asks for them:

```
python scraper.py
  Start date: 2026-11-01
  End date   [Enter = today]: 2026-11-30
```

Or pass them on the command line:

| What you want | Command |
|---|---|
| History + live, Nov 1–30 | `python scraper.py --start 2026-11-01 --end 2026-11-30` |
| Only the last 7 days of history | `python scraper.py --start 7d --end now --mode history` |
| Only new messages from now until 18:00 | `python scraper.py --start now --end "2026-11-24 18:00" --mode live` |
| One-off different keywords/channels | `python scraper.py --start 3d --end now --keywords war ceasefire --channels @chan1 @chan2` |

**Date formats:** `YYYY-MM-DD`, `"YYYY-MM-DD HH:MM"`, `today`, `yesterday`, `now`, or how far
back: `30m`, `12h`, `7d`, `4w`. A date with no time covers the whole day (the start date
begins at 00:00 and the end date runs to 23:59:59). Times use the `timezone` set in `config.yaml`.

**Collection modes (`--mode`):**
- `both` (default): collects history from the start date, then keeps listening for new messages
  until the end date. If the end date has already passed, only history is collected.
- `history`: past messages only.
- `live`: new incoming messages only. Needs an end date in the future.

While listening live, the Excel file is updated every 30 seconds (configurable). Press **Ctrl+C**
at any time to stop; everything collected so far is saved.

Telegram delivers new messages instantly only for channels your account has **joined**. Other
channels are checked every 30 seconds (`live.poll_every_seconds` in `config.yaml`), so nothing
is missed either way.

## 4. The Excel report

Files are saved to `output/telegram_<start>_to_<end>_<run time>.xlsx` and contain:

| Sheet | Contents |
|---|---|
| **Summary** | Run settings (period, channels, keywords, method), channels not found, message count per channel |
| **All Messages** | Every collected message from all channels, sorted by time |
| **One sheet per channel** | The same rows, grouped by the channel they came from |

Columns: **Channel**, Channel Username, **Posted At** (in your time zone), Sender,
Forwarded From (original source of forwarded posts), **Text**, **Links** (inline links, hidden
links, link previews and URL buttons), **Matched Keywords**, **Message Link** (clickable direct link
to the message), **Source** (channel link), Message ID, Collected Via (History or Live).

Messages that contain only media and no text or caption are skipped, because the report
covers text and links only.

## Security

- Your credentials live only in `credentials.ini`, never in the source code. The file is created
  readable by your user account only, and it is listed in `.gitignore` so it can't be committed
  by accident.
- You can keep the file somewhere else: `python scraper.py --credentials D:\secure\tg.ini`
- Or skip the file entirely and use environment variables: `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`,
  `TELEGRAM_PHONE`. These take priority over the file.
- After the first login, Telegram's session is stored in `sessions/telegram_scraper.session`.
  **Treat this file like a password:** anyone who has it can use your account. It is also
  git-ignored. To revoke it, run `python scraper.py --logout`, or end the session in Telegram
  under *Settings → Devices*.
- Never share your api_hash or login code with anyone.

## Notes

- Telegram limits request rates. Waits of up to 5 minutes are handled automatically. A very
  long history in a busy channel can take a while; progress is printed every 500 messages.
- Use the tool in line with Telegram's Terms of Service and applicable privacy laws.

## Tests

```
pip install pytest
python -m pytest tests          # Python version
cd web && npm install && npm test   # web app
```
The tests use a simulated Telegram client, so they don't need an account or network access.
