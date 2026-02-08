# Email Chess ♟️

Play asynchronous correspondence chess against Claude AI entirely through email. Make moves at your own pace - the game waits for you!

## Features

- 📧 **Fully Email-Driven**: Play chess without leaving your inbox
- ⏰ **Play Anytime**: No daily commitments - move when you want
- 🎯 **Three Difficulty Levels**: Beginner, Intermediate, Advanced
- 📝 **Standard Notation**: Uses algebraic notation (e.g., e4, Nf3, O-O)
- 🔄 **Automatic Responses**: Claude responds within minutes of your move
- 🏷️ **Gmail Organization**: Auto-labels and archives game threads

## Quick Start

### Prerequisites
- Google account with Gmail and Google Sheets
- Anthropic API key ([get one here](https://console.anthropic.com))

### Setup (5 minutes)

1. **Create a Google Sheet**
   - Open [Google Sheets](https://sheets.google.com)
   - Create a new blank spreadsheet

2. **Open Apps Script**
   - Go to `Extensions → Apps Script`
   - Delete any default code

3. **Add the Script**
   - Copy all code from `code.gs`
   - Paste into Apps Script editor
   - Save (Ctrl+S or Cmd+S)

4. **Configure API Key**
   - Click `Project Settings` (gear icon)
   - Scroll to `Script Properties`
   - Add property: `ANTHROPIC_API_KEY` = your API key
   - (Optional) Add property: `EMAIL` = your email address

5. **Start Playing**
   - Run `quickStart()` function
   - Authorize when prompted
   - Check your email for the first game!

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
| `DIFFICULTY` | `intermediate` | `beginner`, `intermediate`, `advanced` | Claude's playing strength |
| `PLAYER_COLOUR` | `white` | `white`, `black` | Your color for new games |
| `POLL_MINUTES` | `5` | Any number | How often to check for replies |
| `AUTO_ARCHIVE` | `true` | `true`, `false` | Auto-archive threads after moves |

## Manual Setup Functions

Instead of `quickStart()`, you can run these individually:

1. `initialiseSheet()` - Set up the game state sheet
2. `setupTriggers()` - Configure email polling
3. `startFirstGame()` - Begin your first game

## Troubleshooting

### Game Not Responding?
- Check that triggers are set up (run `setupTriggers()`)
- Verify your move is the first word in your reply
- Ensure you're replying to the correct thread

### API Errors?
- Verify your API key in Script Properties
- Check your API usage at console.anthropic.com
- API calls are limited to 200/day by default

### Email Issues?
- Check spam/promotions folders
- Look for threads labeled "chess-claude"
- Ensure you're using the account that owns the script

### Reset Everything?
Run these in order:
1. Delete all triggers: `ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))`
2. Run `quickStart()` again

## Tips

- 💡 The game thread stays in one email conversation
- 📁 Archived threads are still playable (the script finds them)
- ⚡ Moves are processed within 5 minutes typically
- 🎯 Claude provides commentary based on difficulty level
- 🔄 You can have one active game at a time

## FAQ

**Q: Can I change difficulty mid-game?**
A: No, start a new game with the NEW command.

**Q: How do I castle?**
A: Use O-O for kingside, O-O-O for queenside.

**Q: Can I take back moves?**
A: No, moves are final once processed.

**Q: What if I enter an illegal move?**
A: Claude will explain why it's illegal and ask for a valid move.

**Q: Can I play multiple games?**
A: One active game at a time per script instance.

## License

MIT License - See LICENSE file for details

## Support

For issues or questions:
- Check the code comments for technical details
- Review your Apps Script logs for errors
- Ensure all setup steps were completed

---

*Enjoy your games! Chess is best savored slowly. ♟️*