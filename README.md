# Email Chess

[![Google Apps Script](https://img.shields.io/badge/Google%20Apps%20Script-4285F4?logo=google&logoColor=white)](https://script.google.com/)
[![Stockfish](https://img.shields.io/badge/Stockfish%2016-339933?logo=lichess&logoColor=white)](https://stockfishchess.org/)
[![Claude API](https://img.shields.io/badge/Claude%20API-191919?logo=anthropic&logoColor=white)](https://www.anthropic.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Play correspondence chess against Stockfish through email, with Claude providing teaching commentary.

**Designed for use with a physical chess board** - emails contain move history in algebraic notation, perfect for following along on a real board.

## Features

- **Play Stockfish**: Full-strength Stockfish 16 engine with three difficulty levels
- **Learn as You Play**: Claude analyses each position and provides strategic commentary
- **Fully Email-Driven**: Play chess without leaving your inbox
- **Play Anytime**: No daily reminders - move when you want
- **Standard Notation**: Uses algebraic notation (e.g., e4, Nf3, O-O)
- **Position Evaluation**: See how the engine assesses each position
- **Deterministic Validation**: chess.js validates all moves - no hallucinated illegal moves

## How it works

1. Set up the Google spreadsheet, Apps Script project, and Cloud Function
2. You receive an email with Stockfish's move and Claude's commentary
3. You reply with your move in algebraic notation
4. The script polls Gmail, validates your move with chess.js, gets Stockfish's response from the Cloud Function, and emails it back with Claude's analysis
5. Game state lives in a Google Sheet that can be shared with any AI chatbot for further analysis
6. All chess emails are labeled "chess-game" for easy filtering

## Architecture

```
Player email reply
  -> Google Apps Script polls Gmail
  -> Validates move with chess.js (deterministic)
  -> Calls Stockfish Cloud Function (IAM-authenticated)
  -> Calls Claude API for teaching commentary
  -> Sends reply email with move + evaluation + commentary
```

## Quick Start

See [DEPLOYMENT_INSTRUCTIONS.md](DEPLOYMENT_INSTRUCTIONS.md) for the full setup guide, including:
- Deploying the Stockfish Cloud Function with IAM authentication
- Configuring Google Apps Script
- Setting billing budget alerts

### Prerequisites

- Google account with Gmail and Google Sheets
- Anthropic API key ([get one here](https://console.anthropic.com))
- Google Cloud project with billing enabled
- `gcloud` CLI installed

### Short version

1. Deploy the Cloud Function: `gcloud functions deploy getMove --gen2 ...`
2. Grant invoke permission to your Google account
3. Create a Google Sheet, open Extensions > Apps Script
4. Add `Chess.gs` and `code.gs`
5. Set Script Properties: `ANTHROPIC_API_KEY`, `STOCKFISH_URL`
6. Run `quickStart()`

## How to Play

### Making Moves
Reply to the email thread with your move as the **first word**:
- `e4` - Pawn to e4
- `Nf3` - Knight to f3
- `O-O` - Castle kingside
- `Qxd7+` - Queen takes d7, check

### Commands
Type these as the **first word** in your reply:
- `NEW` - Start a new game
- `RESIGN` - Resign current game
- `PAUSE` - Pause the game
- `CONTINUE` - Resume after pause

### Algebraic Notation Quick Reference
```
Pieces:  K=King Q=Queen R=Rook B=Bishop N=Knight (pawns have no letter)
Moves:   Nf3 = knight to f3
Capture: Nxe5 = knight captures on e5
Castle:  O-O = kingside, O-O-O = queenside
Promote: e8=Q = pawn promotes to queen
Check:   + (e.g. Qd7+)
Mate:    # (e.g. Qf7#)
```

## Configuration Options

Edit these in the script's `CONFIG` object:

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `DIFFICULTY` | `intermediate` | `beginner`, `intermediate`, `advanced` | Stockfish playing strength |
| `PLAYER_COLOUR` | `white` | `white`, `black` | Your color for new games |
| `POLL_MINUTES` | `5` | Any number | How often to check for replies |

### Difficulty Levels

| Level | Stockfish Skill | Search Depth | Approximate Elo |
|-------|----------------|--------------|-----------------|
| Beginner | 3 | 5 | ~1200 |
| Intermediate | 10 | 10 | ~1800 |
| Advanced | 20 | 15 | ~2500+ |

## Estimated Costs

| Component | Monthly Cost |
|-----------|-------------|
| Cloud Function (Stockfish) | < $0.10 |
| Claude API (commentary) | ~$0.10-0.30/game |
| Google Apps Script / Gmail / Sheets | Free |

**Total**: Under $1/month for casual play.

## Troubleshooting

### Game Not Responding?
- Check that triggers are set up (run `setupTriggers()`)
- Verify your move is the first word in your reply
- Ensure you're replying to the correct thread

### Cloud Function Errors?
- Verify IAM permissions (see deployment guide step 1.4)
- Test the function with `curl` (see deployment guide step 1.5)
- Check Cloud Function logs in the Google Cloud Console

### API Errors?
- Verify your Anthropic API key in Script Properties
- Commentary is non-fatal - games continue without it

### Email Issues?
- Check spam/promotions folders
- Look for threads labeled "chess-game"
- Ensure you're using the account that owns the script

### Reset Everything?
Run these in order:
1. Delete all triggers: `ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))`
2. Run `quickStart()` again

## Tips

- Emails stay in your Gmail - delete or archive them as you prefer
- Moves are processed within 5 minutes by default
- Claude provides strategic commentary calibrated to the difficulty level
- You can have one active game at a time
- Share your GameState sheet link with any LLM chatbot for additional analysis

## FAQ

**Q: Can I change difficulty mid-game?**
A: Not recommended. Start a new game with the `NEW` command instead.

**Q: What if the commentary is missing?**
A: Commentary is non-fatal. If the Claude API fails, the game continues with just the engine move and evaluation.

**Q: Can I take back moves?**
A: No, moves are final once processed.

**Q: What if I enter an illegal move?**
A: chess.js validates your move deterministically and shows you the list of legal moves.

**Q: Can I play multiple games?**
A: One active game at a time per script instance.

## License

MIT License - See LICENSE file for details
