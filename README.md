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

## Architecture

```
Player email reply
  -> Google Apps Script polls Gmail
  -> Validates move with chess.js (deterministic)
  -> Calls Stockfish Cloud Function (IAM-authenticated)
  -> Calls Claude API for teaching commentary
  -> Sends reply email with move + evaluation + commentary
```

Three components:

1. **Google Apps Script (code.gs + Chess.gs)** - Email flow, game state, move validation (chess.js), Claude commentary
2. **Google Cloud Function (Stockfish WASM)** - Stockfish 16 chess engine for opponent moves
3. **Claude API** - Teaching commentary (non-blocking; game works even if commentary fails)

## Prerequisites

- Google account with Gmail and Google Sheets
- Anthropic API key ([get one here](https://console.anthropic.com))
- Google Cloud project with billing enabled
- `gcloud` CLI installed ([install guide](https://cloud.google.com/sdk/docs/install))

## Setup

### Step 1: Set up Google Cloud project

```bash
# Authenticate
gcloud auth login

# Create a new project (or use an existing one)
gcloud projects create email-chess --name="Email Chess"
gcloud config set project email-chess

# Enable required APIs
gcloud services enable cloudfunctions.googleapis.com
gcloud services enable cloudbuild.googleapis.com
gcloud services enable run.googleapis.com
```

### Step 2: Set a billing budget alert

Expected cost is well under $1/month for personal use, but set a ceiling to be safe.

1. Go to the [billing console](https://console.cloud.google.com/billing)
2. Navigate to **Billing** > **Budgets & alerts**
3. Click **Create budget**
4. Set the budget amount to **$5**
5. Set alert thresholds at **50%**, **90%**, and **100%**
6. Enable email notifications

### Step 3: Deploy the Stockfish Cloud Function

From the `stockfish-cloud-function/` directory:

```bash
cd stockfish-cloud-function

gcloud functions deploy getMove \
  --project=YOUR_PROJECT_ID \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=getMove \
  --trigger-http \
  --no-allow-unauthenticated \
  --memory=512MB \
  --timeout=120s
```

Note the **URL** from the output. It will look like:
```
https://us-central1-email-chess.cloudfunctions.net/getMove
```

### Step 4: Create a service account for the Cloud Function

Gen2 Cloud Functions run on Cloud Run, which requires an **ID token** (not an access token) for authentication. Apps Script obtains this by impersonating a service account.

```bash
# Create a service account
gcloud iam service-accounts create stockfish-invoker \
  --display-name="Stockfish Cloud Function Invoker"

# Grant it permission to invoke the Cloud Function
gcloud functions add-invoker-policy-binding getMove \
  --gen2 \
  --region=us-central1 \
  --member="serviceAccount:stockfish-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com"

# Grant your Google account permission to impersonate this service account
gcloud iam service-accounts add-iam-policy-binding \
  stockfish-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com \
  --member="user:YOUR_EMAIL@gmail.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

Replace `YOUR_PROJECT_ID` and `YOUR_EMAIL@gmail.com` with your values.

Note the service account email: `stockfish-invoker@YOUR_PROJECT_ID.iam.gserviceaccount.com`

### Step 5: Enable the IAM Credentials API

```bash
gcloud services enable iamcredentials.googleapis.com
```

### Step 6: Test the Cloud Function

```bash
TOKEN=$(gcloud auth print-identity-token)

curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "difficulty": "intermediate"}' \
  YOUR_CLOUD_FUNCTION_URL
```

Expected response:
```json
{"move":"e2e4","evaluation":{"type":"cp","value":30}}
```

### Step 7: Create the Apps Script project

1. Open [Google Sheets](https://sheets.google.com) and create a new blank spreadsheet
2. Go to **Extensions > Apps Script**
3. Delete any default code in the editor

### Step 8: Link Apps Script to your GCP project

Apps Script needs to use your GCP project (not its default hidden project) so it can call the IAM Credentials API.

1. In the Apps Script editor, click **Project Settings** (gear icon)
2. Under **Google Cloud Platform (GCP) Project**, click **Change project**
3. Enter your GCP project **number** (find it at [console.cloud.google.com](https://console.cloud.google.com) under project settings -- it's the numeric ID, not the project name)
4. Click **Set project**

### Step 9: Add the script files

**File 1: Chess.gs**
1. Click the **+** next to "Files" in the left sidebar
2. Select **Script** and name it `Chess`
3. Delete any default content
4. Copy the entire contents of `Chess.gs` from this repo and paste it in
5. Save (Ctrl+S)

**File 2: Code.gs**
1. Click on the default `Code.gs` file
2. Replace all content with the contents of `code.gs` from this repo
3. Save (Ctrl+S)

### Step 10: Configure Script Properties

1. Click **Project Settings** (gear icon in left sidebar)
2. Scroll to **Script Properties**
3. Add these properties:

| Property | Value |
|----------|-------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `STOCKFISH_URL` | The Cloud Function URL from step 3 |
| `STOCKFISH_SA` | The service account email from step 4 (e.g. `stockfish-invoker@your-project.iam.gserviceaccount.com`) |
| `EMAIL` | *(Optional)* Your email address. If not set, uses the account email. |

### Step 11: Start playing

1. In the Apps Script editor, select `quickStart` from the function dropdown
2. Click **Run**
3. When prompted, click **Review Permissions** and authorize the script (you may need to click "Advanced" and "Go to project" if it shows a warning)
4. Check your inbox for the first chess email

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

### What the Emails Look Like

Each response email contains:
- The engine's move in standard algebraic notation
- Position evaluation (how the engine assesses the position)
- Full move history
- Current FEN position
- Claude's teaching commentary (strategic explanations, tips)

## Configuration

Edit these in the `CONFIG` object at the top of `code.gs`:

| Setting | Default | Options | Description |
|---------|---------|---------|-------------|
| `DIFFICULTY` | `intermediate` | `beginner`, `intermediate`, `advanced` | Stockfish playing strength |
| `PLAYER_COLOUR` | `white` | `white`, `black` | Your color for new games |
| `POLL_MINUTES` | `5` | Any number | How often to check for replies (minutes) |

### Difficulty Levels

| Level | Stockfish Skill | Search Depth | Approximate Elo |
|-------|----------------|--------------|-----------------|
| Beginner | 3 | 5 | ~1200 |
| Intermediate | 10 | 10 | ~1800 |
| Advanced | 20 | 15 | ~2500+ |

## Security

- The Cloud Function is deployed with **IAM authentication** -- it is not publicly accessible
- GAS authenticates using `ScriptApp.getOAuthToken()` which provides an OAuth 2.0 token
- Only your Google account (and any accounts you explicitly grant `roles/run.invoker`) can call the function
- The only data sent to the Cloud Function is FEN strings (board positions) -- no personal data
- The Anthropic API key is stored in GAS Script Properties (encrypted at rest by Google)

## Estimated Costs

| Component | Monthly Cost |
|-----------|-------------|
| Cloud Function (Stockfish) | < $0.10 (2M free invocations/month) |
| Claude API (commentary) | ~$0.10-0.30 per full game |
| Google Apps Script / Gmail / Sheets | Free |

**Total**: Under $1/month for casual play.

## Troubleshooting

### "STOCKFISH_URL is not set" error
- Check Script Properties in the Apps Script project settings
- Ensure the property name is exactly `STOCKFISH_URL`

### Cloud Function returns 403/401
- Verify the service account has Cloud Run Invoker role (step 4)
- Verify your Google account has Service Account Token Creator role on the SA (step 4)
- Verify the IAM Credentials API is enabled (step 5)
- Verify the Apps Script project is linked to your GCP project (step 8)
- Check that `STOCKFISH_SA` is set correctly in Script Properties
- IAM changes can take a few minutes to propagate

### "Failed to get ID token" error
- Ensure `STOCKFISH_SA` in Script Properties is a valid service account email
- Verify your Apps Script project is linked to the correct GCP project (step 8)
- Verify your Google account has the `roles/iam.serviceAccountTokenCreator` role

### "Engine returned invalid move" error
- This should be rare. Check that the FEN in the GameState sheet is valid
- Try starting a new game with the `NEW` command

### Commentary missing from emails
- Commentary is non-fatal -- if the Claude API fails, the game continues without it
- Check your Anthropic API key is valid and has credit
- Check the Apps Script execution log for details

### Moves not being picked up
- Verify triggers are set up: run `setupTriggers()` in the Apps Script editor
- Check that your reply is in the correct email thread
- Your move must be the first word in the reply

### Reset everything
1. Delete all triggers in the Apps Script console:
   ```javascript
   ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t))
   ```
2. Run `quickStart()` again

## Updating the Cloud Function

If you need to redeploy after changes:

```bash
cd stockfish-cloud-function

gcloud functions deploy getMove \
  --gen2 \
  --runtime=nodejs20 \
  --region=us-central1 \
  --source=. \
  --entry-point=getMove \
  --trigger-http \
  --no-allow-unauthenticated \
  --memory=512MB \
  --timeout=120s
```

## Local Testing

### Test Stockfish directly

```bash
cd stockfish-cloud-function
npm install
node test.js
```

### Test the Cloud Function HTTP server locally

```bash
cd stockfish-cloud-function
npm start
# In another terminal:
curl -X POST http://localhost:8080 \
  -H "Content-Type: application/json" \
  -d '{"fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1", "difficulty": "beginner"}'
```

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

**Q: How much does it cost?**
A: Under $1/month for casual play. See [Estimated Costs](#estimated-costs).

## Acknowledgements

- **[Stockfish](https://stockfishchess.org/)** - Chess engine, licensed under [GPLv3](https://www.gnu.org/licenses/gpl-3.0.html). Used as a runtime dependency via the [stockfish](https://www.npmjs.com/package/stockfish) npm package. Stockfish is not distributed with this project; it is installed as a dependency of the Cloud Function.
- **[chess.js](https://github.com/jhlywa/chess.js)** by Jeff Hlywa - Chess rules library, licensed under [BSD-2-Clause](https://opensource.org/licenses/BSD-2-Clause). Adapted and embedded in `Chess.gs` for Google Apps Script compatibility.
- **[Claude](https://www.anthropic.com/)** by Anthropic - AI model used for teaching commentary.

## License

MIT License - See LICENSE file for details.

This license applies to the project's own code (`code.gs`, Cloud Function wrapper, etc.). Third-party dependencies retain their original licenses: Stockfish is GPLv3, chess.js is BSD-2-Clause. See `Chess.gs` header for the full chess.js license text.
