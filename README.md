# Telegram Channel Scraper → Excel

Collects messages (text and links) from Telegram channels you choose, filters them by keyword,
and saves them to an Excel report. It can collect **past messages (chat history)** and
**new incoming messages (live)** in the same run.

Built with Python + [Telethon](https://docs.telethon.dev) (the Telegram client API) + openpyxl.

---

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
python -m pytest tests
```
The tests use a simulated Telegram client, so they don't need an account or network access.
