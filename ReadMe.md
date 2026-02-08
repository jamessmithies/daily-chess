# Daily Chess with Claude — Google Apps Script (Email Only)

Play a daily correspondence chess game against Claude, entirely via email replies.

## How it works

1. A daily trigger sends you Claude's move (or a nudge if it's your turn)
2. You reply with your move in algebraic notation
3. The script polls Gmail every few minutes, picks up your reply, and emails back Claude's response in the same thread
4. Game state lives in a Google Sheet
5. All chess emails are automatically labeled `chess-claude` and archived (keeps your inbox clean - just check the label for unread moves)

## Setup (3 minutes)

### 1. Create the Sheet
Go to [Google Sheets](https://sheets.google.com) and create a new spreadsheet.

### 2. Open Apps Script
In the sheet: **Extensions → Apps Script**. Delete any default code in `Code.gs` and paste the contents of `Code.gs` from this project.

### 3. Set Script Properties
In Apps Script: **Project Settings** (gear icon) → **Script Properties**. Add:
- `ANTHROPIC_API_KEY` → your key from [console.anthropic.com](https://console.anthropic.com)
- `EMAIL` → your email address (optional; defaults to your Google account email)

### 4. (Optional) Edit defaults
At the top of the script in the `CONFIG` object:
- `DIFFICULTY`: `'beginner'`, `'intermediate'`, or `'advanced'`
- `PLAYER_COLOUR`: `'white'` or `'black'`
- `DAILY_HOUR`: hour (24h) for the daily email
- `POLL_MINUTES`: how often to check for replies (default 5)
- `AUTO_ARCHIVE`: `true` to automatically archive chess emails (keeps inbox clean)
- `MIN_CLAUDE_CALL_MS`: minimum milliseconds between API calls (default 2000)
- `INTER_CALL_DELAY_MS`: delay between move validation and response generation (default 2000)

### 5. Run Quick Start
Select `quickStart` from the function dropdown → **Run**. Grant permissions when prompted.

This single function does everything:
- Creates the GameState sheet
- Validates your API key
- Sets up daily and polling triggers
- Sends your first chess email

Check your inbox (or the `chess-claude` label if auto-archived) — the first email includes an algebraic notation quick reference.

---

**Alternative: Manual Step-by-Step Setup**

If you prefer to run each step individually:
1. Run `initialiseSheet`
2. Run `setupTriggers`
3. Run `startFirstGame`

## Commands

All commands must be the **first word** in your reply.

| Reply | What it does |
|-------|-------------|
| *(a chess move)* | e.g. `e4`, `Nf3`, `O-O`, `Qxd7+` |
| `NEW` | Start a new game |
| `RESIGN` | Resign the current game |
| `PAUSE` | Pause daily emails (e.g. going on holiday) |
| `CONTINUE` | Resume after a pause |

## Notes

- **Response time:** Up to 5 minutes (configurable via `POLL_MINUTES`).
- **API costs:** Roughly $0.10–0.30 per full game.
- **Email threading:** Each game gets its own thread with a unique token. Gmail labels it `chess-claude`.
- **Auto-archive:** Set `AUTO_ARCHIVE: true` in CONFIG to automatically keep chess emails out of your inbox. The thread is archived immediately when you reply, so you never see your own messages cluttering your inbox. Check the `chess-claude` label for unread moves from Claude.
- **Move history only:** Emails show move history (e.g., "1.e4 1...e5 2.Nf3") - perfect for following along on a physical board.
- **Notation guide:** Every email includes an algebraic notation reference at the bottom for quick lookup.
- **Sender verification:** Only replies from your Google account email are processed.
- **Changing difficulty mid-game:** Edit cell B5 in the GameState sheet.
- **Troubleshooting:** If `quickStart` or other functions throw errors, check the execution log for details.
