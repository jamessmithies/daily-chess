// ============================================================
// EMAIL CHESS — Google Apps Script
// ============================================================
// Play correspondence chess via email against Stockfish (hosted
// on Google Cloud Functions). Claude provides optional teaching
// commentary after each move. You reply with your move in
// algebraic notation and the script responds with the engine's
// next move in the same thread.
//
// Commands (must be the first word in your reply):
//   NEW       — start a new game
//   RESIGN    — resign the current game
//   PAUSE     — pause daily emails (e.g. holiday)
//   CONTINUE  — resume after a pause
//
// Quick Setup:
//   1. Deploy the Stockfish Cloud Function (see stockfish-cloud-function/)
//   2. Create a Google Sheet → Extensions → Apps Script → paste this + Chess.gs
//   3. Project Settings → Script Properties:
//        ANTHROPIC_API_KEY  — your key from console.anthropic.com
//        STOCKFISH_URL      — your Cloud Function URL
//        EMAIL              — your email address (optional; defaults
//                             to your Google account email)
//   4. (Optional) Edit CONFIG defaults below (difficulty, color, etc.)
//   5. Run quickStart() — this does everything in one step!
//
// Manual Setup (if you prefer step-by-step):
//   1-3. Same as above
//   4. Run initialiseSheet()
//   5. Run setupTriggers()
//   6. Run startFirstGame()
// ============================================================

// --- CONFIGURATION ---
const CONFIG = {
  ANTHROPIC_API_KEY: PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
  EMAIL: PropertiesService.getScriptProperties().getProperty('EMAIL'),
  STOCKFISH_URL: PropertiesService.getScriptProperties().getProperty('STOCKFISH_URL'),
  DIFFICULTY: 'intermediate',   // beginner | intermediate | advanced
  PLAYER_COLOUR: 'white',       // white | black
  POLL_MINUTES: 5,              // How often to check for email replies
  MODEL: 'claude-sonnet-4-5-20250929',
  THREAD_LABEL: 'chess-game',   // Gmail label to track the game thread
  AUTO_ARCHIVE: true,           // Automatically archive threads after moves

  MAX_MOVE_LEN: 20,
  MAX_FEN_LEN: 200,
  MAX_COMMENT_LEN: 1500,
  MAX_MOVEHIST_LEN: 6000,
  MIN_CLAUDE_CALL_MS: 2000,  // Minimum time between API calls (2 seconds)
};

const NOTATION_GUIDE = `
---
Algebraic notation quick reference:

Pieces:  K = King, Q = Queen, R = Rook, B = Bishop, N = Knight
         (pawns have no letter — just the square, e.g. e4)
Moves:   Nf3 = knight to f3, Bb5 = bishop to b5
Capture: Nxe5 = knight captures on e5, exd5 = pawn captures on d5
Castle:  O-O = kingside, O-O-O = queenside
Promote: e8=Q = pawn promotes to queen
Check:   + (e.g. Qd7+)  Checkmate: # (e.g. Qf7#)

If two pieces can reach the same square, add the file or rank:
  Rae1 = rook on a-file to e1, R1e2 = rook on rank 1 to e2
`;

// --- UTIL HELPERS ---
function getAccountEmail() {
  const e = (Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!e) throw new Error('Could not determine account email (Session.getEffectiveUser()).');
  return e;
}

function getDestinationEmail() {
  const e = (CONFIG.EMAIL || Session.getEffectiveUser().getEmail() || '').trim().toLowerCase();
  if (!e) throw new Error('Destination email is not set and could not determine account email.');
  return e;
}

function normalizeEmail(fromField) {
  const s = String(fromField || '').trim();
  const m = s.match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

function onlyMeGuard(message) {
  const allowed = getAccountEmail();
  const sender = normalizeEmail(message.getFrom());
  return sender === allowed;
}

function withScriptLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function enforceRateLimit(propertyKey, minMs) {
  const props = PropertiesService.getScriptProperties();
  const now = Date.now();
  const last = parseInt(props.getProperty(propertyKey) || '0', 10);
  if (last && now - last < minMs) {
    throw new Error(`Rate limited: wait ${Math.ceil((minMs - (now - last)) / 1000)}s and try again.`);
  }
  props.setProperty(propertyKey, String(now));
}

function getOrCreateGameToken() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('CHESS_GAME_TOKEN');
  if (!token) {
    token = Utilities.getUuid();
    props.setProperty('CHESS_GAME_TOKEN', token);
  }
  return token;
}

function buildSubject(prefix) {
  const token = getOrCreateGameToken();
  return `${prefix} [chess:${token}]`;
}

function safeTrim(s, maxLen) {
  s = String(s ?? '');
  if (s.length > maxLen) return s.slice(0, maxLen);
  return s;
}


function isValidFen(fen) {
  if (typeof fen !== 'string') return false;
  fen = fen.trim();
  if (!fen || fen.length > CONFIG.MAX_FEN_LEN) return false;

  // Use chess.js to validate FEN
  try {
    const chess = new Chess(fen);
    return true;
  } catch (e) {
    return false;
  }
}

// --- SHEET HELPERS ---
function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('GameState');
}

function getGameState() {
  const sheet = getSheet();
  return {
    fen: sheet.getRange('B1').getValue() || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: sheet.getRange('B2').getValue() || '',
    gameActive: sheet.getRange('B3').getValue() !== false,
    moveNumber: parseInt(sheet.getRange('B4').getValue(), 10) || 1,
    difficulty: sheet.getRange('B5').getValue() || CONFIG.DIFFICULTY,
    playerColour: sheet.getRange('B6').getValue() || CONFIG.PLAYER_COLOUR,
    threadId: sheet.getRange('B7').getValue() || '',
    lastProcessedCount: parseInt(sheet.getRange('B8').getValue(), 10) || 0,
    paused: sheet.getRange('B9').getValue() === true,
  };
}

function saveGameState(state) {
  const sheet = getSheet();
  sheet.getRange('B1').setValue(state.fen);
  sheet.getRange('B2').setValue(state.moveHistory);
  sheet.getRange('B3').setValue(state.gameActive);
  sheet.getRange('B4').setValue(state.moveNumber);
  sheet.getRange('B5').setValue(state.difficulty);
  sheet.getRange('B6').setValue(state.playerColour);
  sheet.getRange('B7').setValue(state.threadId);
  sheet.getRange('B8').setValue(state.lastProcessedCount);
  sheet.getRange('B9').setValue(state.paused);
}

// --- INITIALISE ---
function initialiseSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName('GameState');
  if (!sheet) sheet = ss.insertSheet('GameState');

  sheet.getRange('A1').setValue('FEN');
  sheet.getRange('A2').setValue('Move History');
  sheet.getRange('A3').setValue('Game Active');
  sheet.getRange('A4').setValue('Move Number');
  sheet.getRange('A5').setValue('Difficulty');
  sheet.getRange('A6').setValue('Player Colour');
  sheet.getRange('A7').setValue('Thread ID');
  sheet.getRange('A8').setValue('Last Processed Msg Count');
  sheet.getRange('A9').setValue('Paused');

  const state = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: true,
    moveNumber: 1,
    difficulty: CONFIG.DIFFICULTY,
    playerColour: CONFIG.PLAYER_COLOUR,
    threadId: '',
    lastProcessedCount: 0,
    paused: false,
  };
  saveGameState(state);

  let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
  if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);

  getOrCreateGameToken();

  Logger.log('Sheet initialised. Run setupTriggers() next.');
}

// --- PREFLIGHT CHECK ---
function validateApiKey() {
  const key = CONFIG.ANTHROPIC_API_KEY;
  if (!key || key === 'YOUR_API_KEY_HERE' || String(key).trim() === '') {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it in Project Settings → Script Properties.');
  }

  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 10,
    messages: [{ role: 'user', content: 'Reply with the word "ok".' }],
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  let json = null;
  try { json = JSON.parse(text); } catch (_) {}

  if (code === 401) throw new Error('ANTHROPIC_API_KEY is invalid (401 Unauthorized). Check Script Properties.');
  if (code === 403) throw new Error('ANTHROPIC_API_KEY is forbidden (403). The key may be disabled or restricted.');
  if (code === 429) throw new Error('Anthropic API rate-limited during validation (429). Try again shortly.');
  if (code >= 500) {
    Logger.log('Anthropic API returned ' + code + ' during validation — may be temporary. Proceeding.');
    return true;
  }
  if (code >= 200 && code < 300) {
    Logger.log('API key validated successfully.');
    return true;
  }

  const msg = (json && json.error && json.error.message) ? json.error.message : ('HTTP ' + code);
  throw new Error('Unexpected response during API key validation: ' + msg);
}

function validateStockfishUrl() {
  const url = CONFIG.STOCKFISH_URL;
  if (!url || url === 'YOUR_CLOUD_FUNCTION_URL' || String(url).trim() === '') {
    throw new Error('STOCKFISH_URL is not set. Add it in Project Settings → Script Properties.');
  }
  // Basic URL format check
  if (!/^https:\/\/.+/.test(url)) {
    throw new Error('STOCKFISH_URL must be an HTTPS URL. Got: ' + url);
  }
  Logger.log('Stockfish URL configured: ' + url);

  const sa = PropertiesService.getScriptProperties().getProperty('STOCKFISH_SA');
  if (!sa || String(sa).trim() === '') {
    throw new Error('STOCKFISH_SA is not set. Add the service account email in Script Properties.');
  }
  if (!sa.includes('@') || !sa.includes('.iam.gserviceaccount.com')) {
    throw new Error('STOCKFISH_SA does not look like a service account email. Expected format: name@project.iam.gserviceaccount.com');
  }
  Logger.log('Stockfish service account configured: ' + sa);

  return true;
}

function preflight() {
  Logger.log('Account email (sender allowlist): ' + getAccountEmail());
  Logger.log('Destination email: ' + getDestinationEmail());
  validateApiKey();
  validateStockfishUrl();
  Logger.log('Preflight passed. Ready to play.');
}

// --- CLAUDE API ---
function callClaude(systemPrompt, userMessage) {
  enforceRateLimit('CHESS_LAST_CLAUDE_CALL_MS', CONFIG.MIN_CLAUDE_CALL_MS);

  const url = 'https://api.anthropic.com/v1/messages';
  const payload = {
    model: CONFIG.MODEL,
    max_tokens: 1024,
    temperature: 0.1, // Low temperature for consistent chess moves
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'x-api-key': CONFIG.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  let json;
  try {
    json = JSON.parse(text);
  } catch (_) {
    throw new Error(`Claude API returned non-JSON (HTTP ${code}).`);
  }

  if (code < 200 || code >= 300) {
    const msg = (json && json.error && json.error.message) ? json.error.message : `HTTP ${code}`;
    throw new Error('Claude API error: ' + msg);
  }

  if (json.error) throw new Error('Claude API error: ' + json.error.message);
  if (!json.content || !json.content[0] || typeof json.content[0].text !== 'string') {
    throw new Error('Claude API error: unexpected response shape.');
  }

  return json.content[0].text;
}

function getCommentaryPrompt(state) {
  const difficultyInstructions = {
    beginner: 'The player is a beginner. Explain what the engine\'s move does in plain language. Mention basic concepts like development, controlling the center, or king safety. Keep it encouraging and educational.',
    intermediate: 'The player is intermediate. Give a brief positional or tactical comment about the engine\'s move. Mention ideas like piece activity, pawn structure, or tactical threats.',
    advanced: 'The player is advanced. Give concise analytical commentary. Mention strategic plans, key variations, or positional nuances.',
  };

  return `You are a chess tutor providing commentary on a game between a human player and a chess engine.

You will receive:
- The current position (FEN) after both moves
- The player's move and the engine's response
- The move history

Your job is to comment on the engine's move to help the player learn. Do NOT suggest moves for the player.

Respond with ONLY a JSON object in this exact format, no markdown fencing:
{"comment":"<your commentary on the engine's move>"}

STYLE: ${difficultyInstructions[state.difficulty] || difficultyInstructions.intermediate}

Keep your comment concise (1-3 sentences). Respond ONLY with the JSON object.`;
}

// --- BOARD RENDERING ---
function generateTextBoard(fen) {
  const ranks = fen.split(' ')[0].split('/');
  let board = '';

  for (let i = 0; i < 8; i++) {
    const rankNum = 8 - i;
    let row = rankNum + ' ';
    const rank = ranks[i];

    for (let j = 0; j < rank.length; j++) {
      const ch = rank[j];
      if (ch >= '1' && ch <= '8') {
        for (let k = 0; k < parseInt(ch, 10); k++) row += '. ';
      } else {
        row += ch + ' ';
      }
    }
    board += row + '\n';
  }
  board += '  a b c d e f g h\n';
  return board;
}

// --- STOCKFISH ENGINE ---

/**
 * Fetches an ID token for the Cloud Function via the IAM Credentials API.
 * Gen2 Cloud Functions (Cloud Run) require an ID token, not an access token.
 *
 * Requires:
 *   - STOCKFISH_SA script property (service account email with Cloud Run Invoker role)
 *   - The Apps Script user must have Service Account Token Creator role on that SA
 *   - The Apps Script project must be linked to the same GCP project
 */
function getIdToken(audience) {
  const sa = PropertiesService.getScriptProperties().getProperty('STOCKFISH_SA');
  if (!sa) throw new Error('STOCKFISH_SA is not set. Add the service account email in Script Properties.');

  const tokenUrl = 'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/' +
    sa + ':generateIdToken';

  const tokenOptions = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + ScriptApp.getOAuthToken(),
    },
    payload: JSON.stringify({
      audience: audience,
      includeEmail: true,
    }),
    muteHttpExceptions: true,
  };

  const resp = UrlFetchApp.fetch(tokenUrl, tokenOptions);
  const code = resp.getResponseCode();

  if (code < 200 || code >= 300) {
    throw new Error('Failed to get ID token (HTTP ' + code + '): ' + resp.getContentText());
  }

  const json = JSON.parse(resp.getContentText());
  return json.token;
}

function callStockfish(fen, difficulty) {
  const url = CONFIG.STOCKFISH_URL;
  if (!url) throw new Error('STOCKFISH_URL is not set. Add it in Project Settings → Script Properties.');

  // Get an ID token scoped to the Cloud Function URL
  const idToken = getIdToken(url);

  const payload = {
    fen: fen,
    difficulty: difficulty || 'intermediate',
  };

  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Authorization': 'Bearer ' + idToken,
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code < 200 || code >= 300) {
    throw new Error('Stockfish API error (HTTP ' + code + '): ' + text);
  }

  const json = JSON.parse(text);
  if (!json.move) throw new Error('Stockfish returned no move.');

  return json; // { move: "g1f3", evaluation: { type: "cp", value: 30 } }
}

// --- CORE GAME LOGIC ---
function getEngineMove() {
  const state = getGameState();
  if (!state.gameActive) return null;

  Logger.log('Requesting engine move for FEN: ' + state.fen);

  // Call Stockfish Cloud Function
  const engineResult = callStockfish(state.fen, state.difficulty);
  const uciMove = engineResult.move; // UCI notation, e.g. "g1f3"

  Logger.log('Engine returned UCI move: ' + uciMove);

  // Use chess.js to validate and convert UCI move to SAN
  const chess = new Chess(state.fen);

  // Convert UCI notation (e.g. "g1f3") to a move object
  let move;
  try {
    move = chess.move({
      from: uciMove.substring(0, 2),
      to: uciMove.substring(2, 4),
      promotion: uciMove.length > 4 ? uciMove[4] : undefined,
    });
  } catch (e) {
    Logger.log('Engine move invalid: ' + uciMove + ' — ' + e.toString());
    throw new Error('Engine returned invalid move: ' + uciMove);
  }

  if (!move) {
    Logger.log('Engine move rejected by chess.js: ' + uciMove);
    throw new Error('Engine returned illegal move: ' + uciMove);
  }

  // Get correct FEN and SAN from chess.js
  const newFen = chess.fen();
  const san = move.san;

  Logger.log('Engine move validated: ' + san + ' | New FEN: ' + newFen);

  // Update game state
  const engineColour = state.playerColour === 'white' ? 'black' : 'white';
  const movePrefix = engineColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';

  state.fen = newFen;
  state.moveHistory = safeTrim(
    (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + san,
    CONFIG.MAX_MOVEHIST_LEN
  );
  if (engineColour === 'black') state.moveNumber++;

  // Check for game over conditions using chess.js
  let gameOver = false;
  let gameResult = '';

  if (chess.isCheckmate()) {
    state.gameActive = false;
    gameOver = true;
    gameResult = engineColour + ' wins by checkmate';
  } else if (chess.isDraw()) {
    state.gameActive = false;
    gameOver = true;
    if (chess.isStalemate()) gameResult = 'Draw by stalemate';
    else if (chess.isThreefoldRepetition()) gameResult = 'Draw by threefold repetition';
    else gameResult = 'Draw';
  }

  saveGameState(state);

  return {
    move: san,
    fen: newFen,
    evaluation: engineResult.evaluation,
    gameOver: gameOver,
    result: gameResult,
  };
}

function getCommentary(playerMove, engineMove, state) {
  // Commentary is optional — if it fails, the game continues without it
  try {
    const systemPrompt = getCommentaryPrompt(state);
    const userMessage =
      `Current FEN: ${state.fen}\n` +
      `Move history: ${state.moveHistory || '(game start)'}\n` +
      `Player's move: ${playerMove}\n` +
      `Engine's response: ${engineMove}`;

    const responseText = callClaude(systemPrompt, userMessage);
    const cleaned = String(responseText || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);

    return safeTrim(parsed.comment || '', CONFIG.MAX_COMMENT_LEN);
  } catch (e) {
    Logger.log('Commentary failed (non-fatal): ' + e.toString());
    return '';
  }
}

function processPlayerMove(moveStr) {
  const state = getGameState();

  if (!state.gameActive) return { error: 'No active game. Reply NEW to start one.' };

  moveStr = String(moveStr || '').trim();
  if (!moveStr) return { error: 'Empty move. Reply with a move like Nf3 or e4.' };
  if (moveStr.length > CONFIG.MAX_MOVE_LEN) return { error: 'Move too long. Use standard algebraic notation (e.g., Nf3).' };

  Logger.log('Processing move: ' + moveStr);
  Logger.log('Current FEN: ' + state.fen);
  Logger.log('Player colour: ' + state.playerColour);
  Logger.log('Move history: ' + state.moveHistory);

  // Use chess.js for deterministic move validation
  try {
    const chess = new Chess(state.fen);

    // Check whose turn it is
    const fenTurn = state.fen.split(' ')[1]; // 'w' or 'b'
    const expectedTurn = state.playerColour === 'white' ? 'w' : 'b';

    if (fenTurn !== expectedTurn) {
      return { error: 'It\'s not your turn. Waiting for Claude\'s move.' };
    }

    // Try to make the move (chess.js may throw an error for illegal moves)
    let move;
    try {
      move = chess.move(moveStr);
    } catch (moveError) {
      // Move is illegal - provide helpful error message
      const legalMoves = chess.moves();
      Logger.log('Illegal move attempted: ' + moveStr + '. Legal moves: ' + legalMoves.join(', '));

      // Check if it might be a formatting issue
      if (/^[a-h][1-8]$/.test(moveStr)) {
        // Check if there's a pawn move to this square
        const pawnMoves = legalMoves.filter(m => m === moveStr || m.endsWith(moveStr));
        if (pawnMoves.length > 0) {
          return { error: 'Ambiguous pawn move. Please specify: ' + pawnMoves.join(' or ') };
        }
      }

      return { error: 'Illegal move. Legal moves include: ' + legalMoves.slice(0, 10).join(', ') + (legalMoves.length > 10 ? '...' : '') };
    }

    // Move was successful - get the new FEN and standardized notation
    const nextFen = chess.fen();
    const stdMove = move.san; // Standard Algebraic Notation from chess.js

    Logger.log('Move validated successfully: ' + stdMove);
    Logger.log('New FEN: ' + nextFen);

    // Update game state
    const movePrefix = state.playerColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';
    state.fen = nextFen;
    state.moveHistory = safeTrim(
      (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + stdMove,
      CONFIG.MAX_MOVEHIST_LEN
    );
    if (state.playerColour === 'black') state.moveNumber++;

    saveGameState(state);
    return { success: true, move: stdMove, fen: nextFen };

  } catch (e) {
    Logger.log('Error processing move with chess.js: ' + e.toString());
    return { error: 'Failed to process move. Please check your notation and try again.' };
  }
}

// --- EMAIL ---
function sendGameEmail(subjectPrefix, body) {
  const state = getGameState();
  const subject = buildSubject(subjectPrefix);

  if (state.threadId) {
    const thread = GmailApp.getThreadById(state.threadId);
    if (thread) {
      thread.reply(body);

      // Ensure label is applied to the thread
      let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
      if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
      thread.addLabel(label);

      // Archive if configured
      if (CONFIG.AUTO_ARCHIVE) {
        thread.moveToArchive();
      }

      state.lastProcessedCount = thread.getMessageCount();
      saveGameState(state);
      return;
    }
  }

  GmailApp.sendEmail(getDestinationEmail(), subject, body);

  Utilities.sleep(2000);

  const token = getOrCreateGameToken();
  const q = `from:me to:${getDestinationEmail()} subject:"[chess:${token}]" newer_than:7d`;
  let threads = GmailApp.search(q, 0, 10);
  if (threads.length === 0) {
    Utilities.sleep(2000);
    threads = GmailApp.search(q, 0, 10);
  }

  if (threads.length > 0) {
    let newest = threads[0];
    for (const t of threads) {
      if (t.getLastMessageDate() > newest.getLastMessageDate()) newest = t;
    }

    state.threadId = newest.getId();
    state.lastProcessedCount = newest.getMessageCount();

    let label = GmailApp.getUserLabelByName(CONFIG.THREAD_LABEL);
    if (!label) label = GmailApp.createLabel(CONFIG.THREAD_LABEL);
    newest.addLabel(label);

    saveGameState(state);
  }
}

function buildMoveEmail(engineResponse, commentary) {
  const state = getGameState();

  let body = `Engine plays: ${engineResponse.move}\n\n`;

  // Add evaluation bar if available
  if (engineResponse.evaluation) {
    const eval_ = engineResponse.evaluation;
    if (eval_.type === 'cp') {
      const pawns = (eval_.value / 100).toFixed(1);
      body += `Evaluation: ${eval_.value > 0 ? '+' : ''}${pawns} pawns\n\n`;
    } else if (eval_.type === 'mate') {
      body += `Evaluation: Mate in ${eval_.value}\n\n`;
    }
  }

  if (commentary) {
    body += `${commentary}\n\n`;
  }

  body += `Move history: ${state.moveHistory}\n\n`;

  if (engineResponse.gameOver) {
    body += `Game over: ${engineResponse.result}\n\n`;
    body += `Reply NEW to start a new game.\n`;
  } else {
    body += `Reply with your move:\n`;
    body += `  • Pawn moves: just the square (e.g. e4, b3, d5)\n`;
    body += `  • Piece moves: piece + square (e.g. Nf3, Be5, Qd1)\n`;
    body += `  • Castling: O-O or O-O-O\n`;
    body += `Reply NEW to start a new game.\n`;
    body += `Reply RESIGN to resign.\n`;
    body += `Reply PAUSE to pause daily emails.\n`;
  }

  body += NOTATION_GUIDE;

  return safeTrim(body, 20000);
}

// --- REPLY PARSING ---
function extractMoveFromReply(messageBody) {
  const lines = String(messageBody || '').split('\n');

  const freshLines = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('>')) break;
    if (line.startsWith('On ') && line.includes(' wrote:')) break;
    if (line === '--') break;
    if (line.match(/^-{3,}$/)) break;
    if (line.startsWith('From:')) break;
    freshLines.push(line);
  }

  const freshText = freshLines.join(' ').trim();
  if (!freshText) return null;

  // Skip automated emails sent by the script itself
  if (freshText.startsWith('Engine plays:')) return null;
  if (freshText.startsWith('Your move:')) return null;
  if (freshText.startsWith('New game!')) return null;
  if (freshText.startsWith('You resigned.')) return null;
  if (freshText.startsWith('Game paused.')) return null;
  if (freshText.startsWith('Game resumed!')) return null;
  if (freshText.startsWith('It\'s your move!')) return null;
  if (freshText.startsWith('No active game.')) return null;
  if (freshText.startsWith('Illegal move:')) return null;

  const firstToken = freshText.split(/\s+/)[0].toUpperCase();
  if (firstToken === 'NEW') return { command: 'new' };
  if (firstToken === 'RESIGN') return { command: 'resign' };
  if (firstToken === 'PAUSE') return { command: 'pause' };
  if (firstToken === 'CONTINUE') return { command: 'continue' };

  const movePattern = /\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?)\b/i;
  const match = freshText.match(movePattern);
  if (match) return { move: match[1] };

  if (freshText.length <= 10 && /^[KQRBNPa-h0-9xO\-\+=#]+$/i.test(freshText)) {
    return { move: freshText };
  }

  return null;
}

// --- POLL FOR REPLIES ---
function checkForReplies() {
  return withScriptLock(() => {
    const state = getGameState();
    if (!state.threadId) return;

    const thread = GmailApp.getThreadById(state.threadId);
    if (!thread) return;

    const messages = thread.getMessages();
    const startIdx = Math.max(0, state.lastProcessedCount);
    if (messages.length <= startIdx) return;

    for (let i = startIdx; i < messages.length; i++) {
      const msg = messages[i];

      if (!onlyMeGuard(msg)) {
        Logger.log('Rejected reply from unauthorized sender: ' + msg.getFrom());
        continue;
      }

      const parsed = extractMoveFromReply(msg.getPlainBody());
      if (!parsed) continue;

      state.lastProcessedCount = i + 1;
      saveGameState(state);

      if (parsed.command === 'new') {
        startNewGameInternal_();
        return;
      }

      if (parsed.command === 'resign') {
        state.gameActive = false;
        saveGameState(state);
        sendGameEmail(
          '♟ Chess',
          'You resigned. Good game!\n\n' +
            'Move history: ' +
            state.moveHistory +
            '\n\nReply NEW to start a new game.'
        );
        return;
      }

      if (parsed.command === 'pause') {
        state.paused = true;
        saveGameState(state);
        sendGameEmail('♟ Chess', 'Game paused. No daily emails until you resume.\n\nReply CONTINUE to resume.');
        return;
      }

      if (parsed.command === 'continue') {
        state.paused = false;
        saveGameState(state);
        sendGameEmail(
          '♟ Chess',
          'Game resumed!\n\n' +
            'Move history: ' +
            state.moveHistory +
            '\n\nReply with your move.'
        );
        return;
      }

      if (state.paused) {
        sendGameEmail('♟ Chess', 'Game is paused. Reply CONTINUE to resume, or NEW to start a fresh game.');
        return;
      }

      if (parsed.move) {
        // Archive the thread immediately after detecting your reply
        if (CONFIG.AUTO_ARCHIVE) {
          thread.moveToArchive();
        }

        const result = processPlayerMove(parsed.move);
        if (result.error) {
          const cur = getGameState();
          sendGameEmail(
            '♟ Chess',
            result.error +
              '\n\nMove history: ' + cur.moveHistory +
              '\n\nTry again — reply with a valid move.'
          );

          // Archive even on errors
          if (CONFIG.AUTO_ARCHIVE && thread) {
            thread.moveToArchive();
          }
          return;
        }

        // Get engine's response move
        const engineResult = getEngineMove();
        if (engineResult) {
          // Get optional commentary from Claude (non-blocking — game proceeds even if this fails)
          const commentary = getCommentary(result.move, engineResult.move, getGameState());

          const emailBody = 'Your move: ' + result.move + '\n\n' + buildMoveEmail(engineResult, commentary);
          sendGameEmail('♟ Chess', emailBody);

          // Archive after successful exchange
          if (CONFIG.AUTO_ARCHIVE && thread) {
            thread.moveToArchive();
          }
        }
        return;
      }
    }

    state.lastProcessedCount = messages.length;
    saveGameState(state);
  });
}

// --- NEW GAME ---
// Internal version — no lock. Called from within locked contexts.
function startNewGameInternal_(difficulty, colour) {
  const diff = difficulty || CONFIG.DIFFICULTY;
  const col = colour || CONFIG.PLAYER_COLOUR;

  PropertiesService.getScriptProperties().deleteProperty('CHESS_GAME_TOKEN');

  const state = {
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    moveHistory: '',
    gameActive: true,
    moveNumber: 1,
    difficulty: diff,
    playerColour: col,
    threadId: '',
    lastProcessedCount: 0,
    paused: false,
  };
  saveGameState(state);

  if (col === 'black') {
    const engineResult = getEngineMove();
    if (engineResult) {
      let body = `New game! You are black. Difficulty: ${diff}.\n\n`;
      body += buildMoveEmail(engineResult, '');
      body += NOTATION_GUIDE;
      sendGameEmail('♟ New Chess Game', body);
    }
  } else {
    let body = `New game! You are white. Difficulty: ${diff}.\n\n`;
    body += `Reply with your opening move (e.g. e4, d4, Nf3).\n`;
    body += NOTATION_GUIDE;
    sendGameEmail('♟ New Chess Game', body);
  }
}

// Public entry point — acquires lock.
function startNewGameViaEmail(difficulty, colour) {
  return withScriptLock(() => startNewGameInternal_(difficulty, colour));
}

// Note: Removed daily nudge - game is now fully asynchronous and email-driven

// --- TRIGGERS ---
function setupTriggers() {
  preflight();

  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('checkForReplies')
    .timeBased()
    .everyMinutes(CONFIG.POLL_MINUTES)
    .create();

  Logger.log('Trigger set: reply check every ' + CONFIG.POLL_MINUTES + ' minutes.');
}

// --- MANUAL START ---
function startFirstGame() {
  preflight();
  startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);
}

// --- ONE-STEP SETUP ---
// Run this ONCE to set up everything and start your first game
function quickStart() {
  Logger.log('🚀 Starting Quick Setup...');

  // Step 1: Initialize sheet
  Logger.log('1/4 Initializing GameState sheet...');
  initialiseSheet();

  // Step 2: Validate API key, Stockfish URL, and email
  Logger.log('2/4 Validating configuration...');
  preflight();

  // Step 3: Set up triggers
  Logger.log('3/4 Setting up triggers...');
  setupTriggers();

  // Step 4: Start first game
  Logger.log('4/4 Starting first game...');
  startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);

  Logger.log('✅ Setup complete! Check your inbox for the first chess email.');
  Logger.log('📧 The thread will be labeled "chess-game" and auto-archived after moves.');
  Logger.log('♟️  Reply with your move to play!');
}