// ============================================================
// DAILY CHESS WITH CLAUDE — Google Apps Script (Email Only)
// ============================================================
// Play a daily correspondence chess game against Claude via email.
// A daily trigger sends Claude's move or a nudge. You reply with
// your move in algebraic notation. The script polls Gmail for
// replies and responds with Claude's next move in the same thread.
//
// Commands (must be the first word in your reply):
//   NEW       — start a new game
//   RESIGN    — resign the current game
//   PAUSE     — pause daily emails (e.g. holiday)
//   CONTINUE  — resume after a pause
//
// Quick Setup:
//   1. Create a Google Sheet → Extensions → Apps Script → paste this
//   2. Project Settings → Script Properties:
//        ANTHROPIC_API_KEY  — your key from console.anthropic.com
//        EMAIL              — your email address (optional; defaults
//                             to your Google account email)
//   3. (Optional) Edit CONFIG defaults below (difficulty, color, etc.)
//   4. Run quickStart() — this does everything in one step!
//
// Manual Setup (if you prefer step-by-step):
//   1-2. Same as above
//   3. Run initialiseSheet()
//   4. Run setupTriggers()
//   5. Run startFirstGame()
// ============================================================

// --- CONFIGURATION ---
const CONFIG = {
  ANTHROPIC_API_KEY: PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY'),
  EMAIL: PropertiesService.getScriptProperties().getProperty('EMAIL'),
  DIFFICULTY: 'intermediate',   // beginner | intermediate | advanced
  PLAYER_COLOUR: 'white',       // white | black
  POLL_MINUTES: 5,              // How often to check for email replies
  MODEL: 'claude-sonnet-4-5-20250929',
  THREAD_LABEL: 'chess-claude', // Gmail label to track the game thread
  AUTO_ARCHIVE: true,           // Automatically archive threads after moves

  MAX_MOVE_LEN: 20,
  MAX_FEN_LEN: 200,
  MAX_COMMENT_LEN: 1500,
  MAX_MOVEHIST_LEN: 6000,
  MIN_CLAUDE_CALL_MS: 2000,  // Minimum time between API calls (2 seconds)
  INTER_CALL_DELAY_MS: 2000, // Delay between validation and response calls
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

function correctEnPassantSquare(fen) {
  // Validates and corrects the en passant square in a FEN string
  const parts = fen.split(/\s+/);
  if (parts.length !== 6) return fen;

  const [board, activeColor, castling, enPassant, halfmove, fullmove] = parts;

  // If already '-', nothing to validate
  if (enPassant === '-') return fen;

  // Parse the board to check if en passant is actually valid
  const ranks = board.split('/');
  const fileIdx = enPassant.charCodeAt(0) - 97; // a=0, b=1, etc.
  const rank = parseInt(enPassant[1]);

  // Determine which color just moved (opposite of active color)
  const lastMoved = activeColor === 'w' ? 'black' : 'white';

  let isValid = false;

  // For en passant to be valid:
  // 1. The last move must have been a two-square pawn advance
  // 2. There must be an enemy pawn that can capture

  if (lastMoved === 'white' && rank === 3) {
    // White just moved a pawn to rank 4
    // Check if there's a black pawn that could capture
    const rank4 = expandRank(ranks[4]); // Rank 4 (0-indexed as 4)
    if (fileIdx > 0 && rank4[fileIdx - 1] === 'p') isValid = true;
    if (fileIdx < 7 && rank4[fileIdx + 1] === 'p') isValid = true;
  } else if (lastMoved === 'black' && rank === 6) {
    // Black just moved a pawn to rank 5
    // Check if there's a white pawn that could capture
    const rank5 = expandRank(ranks[3]); // Rank 5 (0-indexed as 3)
    if (fileIdx > 0 && rank5[fileIdx - 1] === 'P') isValid = true;
    if (fileIdx < 7 && rank5[fileIdx + 1] === 'P') isValid = true;
  }

  if (!isValid) {
    Logger.log(`Correcting invalid en passant square '${enPassant}' to '-'`);
    return `${board} ${activeColor} ${castling} - ${halfmove} ${fullmove}`;
  }

  return fen;
}

function expandRank(rankStr) {
  // Expands a FEN rank string to an array of pieces
  const result = [];
  for (let i = 0; i < rankStr.length; i++) {
    const ch = rankStr[i];
    if (ch >= '1' && ch <= '8') {
      for (let j = 0; j < parseInt(ch); j++) result.push('.');
    } else {
      result.push(ch);
    }
  }
  return result;
}

function isValidFen(fen) {
  if (typeof fen !== 'string') return false;
  fen = fen.trim();
  if (!fen || fen.length > CONFIG.MAX_FEN_LEN) return false;

  const parts = fen.split(/\s+/);
  if (parts.length < 4) return false;

  const board = parts[0];
  const toMove = parts[1];
  const castling = parts[2];
  const ep = parts[3];

  if (toMove !== 'w' && toMove !== 'b') return false;
  if (castling !== '-') {
    if (!/^[KQkq]{1,4}$/.test(castling)) return false;
    if (new Set(castling.split('')).size !== castling.length) return false;
  }
  if (!(ep === '-' || /^[a-h][36]$/.test(ep))) return false;

  const ranks = board.split('/');
  if (ranks.length !== 8) return false;

  for (const r of ranks) {
    let count = 0;
    for (const ch of r) {
      if (ch >= '1' && ch <= '8') count += parseInt(ch, 10);
      else if ('pnbrqkPNBRQK'.includes(ch)) count += 1;
      else return false;
    }
    if (count !== 8) return false;
  }

  return true;
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

function preflight() {
  Logger.log('Account email (sender allowlist): ' + getAccountEmail());
  Logger.log('Destination email: ' + getDestinationEmail());
  validateApiKey();
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

function getChessSystemPrompt(state) {
  const difficultyInstructions = {
    beginner: 'Play at a beginner level. Make occasional inaccuracies. Prioritise simple, instructive positions. After your move, briefly explain what the move does in plain language.',
    intermediate: 'Play at a solid club level. Make principled moves but do not play engine-perfect lines. After your move, give a brief positional or tactical comment.',
    advanced: 'Play at the strongest level you can. After your move, give concise analytical commentary.',
  };

  return `You are a chess engine and tutor. You are playing ${state.playerColour === 'white' ? 'black' : 'white'}.

RULES:
- You receive the current FEN position and move history.
- Respond with EXACTLY this JSON format, no markdown fencing, no other text:
{"move":"e4","fen":"<updated FEN after your move>","comment":"<your comment>","gameOver":false,"result":""}
- Use standard algebraic notation for moves:
  * Pawn moves: just the destination square (e.g., "e4", "d5")
  * Piece moves: piece letter + destination (e.g., "Nf3", "Be5")
  * Captures: include 'x' (e.g., "Nxe5", "exd5")
  * Castling: "O-O" (kingside) or "O-O-O" (queenside)
  * Promotion: include '=' (e.g., "e8=Q")
  * Check/Checkmate: include '+' or '#' (e.g., "Qd7+", "Qf7#")
- IMPORTANT: Always use capital letters for pieces: K, Q, R, B, N (never lowercase)
- FEN FORMAT: The en passant square (4th field) must be set correctly:
  * Set to "-" in most cases (this is the default)
  * ONLY set to a square (like "e6") when ALL these conditions are met:
    1. A pawn JUST moved two squares forward on the previous move
    2. An opponent pawn is on an adjacent file at the correct rank
    3. That opponent pawn can legally capture en passant
  * Example: After 1.e4, set to "e3" ONLY if black has a pawn on d4 or f4
  * Example: After 1...e5, set to "e6" ONLY if white has a pawn on d5 or f5
  * Common mistake: Setting en passant square when no capture is possible
- If the game is over (checkmate, stalemate, draw), set gameOver to true and result to the outcome.
- Validate that your move is legal in the given position.

DIFFICULTY: ${difficultyInstructions[state.difficulty] || difficultyInstructions.intermediate}

Respond ONLY with the JSON object.`;
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

// --- CORE GAME LOGIC ---
function parseClaudeJson(responseText) {
  const cleaned = String(responseText || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  const parsed = JSON.parse(cleaned);

  if (!parsed || typeof parsed !== 'object') throw new Error('Claude returned non-object JSON.');

  const move = safeTrim(parsed.move, CONFIG.MAX_MOVE_LEN);
  const fen = safeTrim(parsed.fen, CONFIG.MAX_FEN_LEN);
  const comment = safeTrim(parsed.comment, CONFIG.MAX_COMMENT_LEN);
  const gameOver = Boolean(parsed.gameOver);
  const result = safeTrim(parsed.result, 200);

  if (!move || typeof move !== 'string') throw new Error('Claude returned missing/invalid move.');
  if (!fen || !isValidFen(fen)) throw new Error('Claude returned invalid FEN.');

  return { move, fen, comment, gameOver, result };
}

function getClaudeMove() {
  const state = getGameState();
  if (!state.gameActive) return null;

  const systemPrompt = getChessSystemPrompt(state);
  const userMessage =
    `Current FEN: ${state.fen}\nMove history: ${state.moveHistory || '(game start)'}\nIt is your turn.`;

  const responseText = callClaude(systemPrompt, userMessage);

  let parsed;
  try {
    parsed = parseClaudeJson(responseText);
  } catch (e) {
    Logger.log('Failed to parse/validate Claude response: ' + String(e && e.message ? e.message : e));
    throw new Error('Invalid response from Claude (rejected for safety).');
  }

  const claudeColour = state.playerColour === 'white' ? 'black' : 'white';
  const movePrefix = claudeColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';

  // Validate and correct the en passant square if needed
  parsed.fen = correctEnPassantSquare(parsed.fen);

  state.fen = parsed.fen;
  state.moveHistory = safeTrim(
    (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + parsed.move,
    CONFIG.MAX_MOVEHIST_LEN
  );

  if (claudeColour === 'black') state.moveNumber++;
  if (parsed.gameOver) state.gameActive = false;

  saveGameState(state);
  return parsed;
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

  // Additional validation for common pawn moves
  if (/^[a-h][1-8]$/.test(moveStr)) {
    Logger.log('Detected pawn move notation: ' + moveStr);
  }

  const systemPrompt = `You are a chess validator. The player is ${state.playerColour}.

The player submitted: "${moveStr}"

Analyze the current position carefully and determine if this is a legal move.

IMPORTANT RULES FOR MOVE INTERPRETATION:
- If the move is just a square like "b3", "e4", "d5" (no piece letter), it's a PAWN move to that square
- The move "b3" means: move the pawn that can legally reach b3 (usually the b-pawn moving forward)
- For piece moves, they include the piece letter: "Nf3", "Be5", "Qd4"
- Castling is written as "O-O" or "O-O-O"

If this is a legal chess move in the current position:
- Return: {"valid":true,"fen":"<new FEN after the move>","move":"<standardized algebraic notation>"}
- CRITICAL FEN RULES for en passant square (4th field):
  * Default to "-" (this is correct 99% of the time)
  * ONLY set to a square when the move being made is a pawn moving two squares
  * AND there's an enemy pawn on an adjacent file that could capture
  * Example: If white plays b2-b4, set "b3" ONLY if black has a pawn on a4 or c4
  * Example: If black plays e7-e5, set "e6" ONLY if white has a pawn on d5 or f5

If illegal:
- Return: {"valid":false,"reason":"<why it's illegal>"}

Double-check that pawn moves like "b3", "e4", "h6" are treated as pawn moves, not as invalid notation.
Return ONLY the JSON, no other text.`;

  const userMessage =
    `Current FEN: ${state.fen}\nMove history: ${state.moveHistory || '(game start)'}\nPlayer's move: ${moveStr}`;

  const responseText = callClaude(systemPrompt, userMessage);

  let parsed;
  try {
    const cleaned = String(responseText || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    parsed = JSON.parse(cleaned);
  } catch (e) {
    Logger.log('JSON parse error. Response was: ' + responseText);
    return { error: 'Failed to process move. Try again.' };
  }

  if (!parsed || typeof parsed !== 'object') {
    Logger.log('Invalid response object: ' + JSON.stringify(parsed));
    return { error: 'Failed to process move. Try again.' };
  }

  if (typeof parsed.valid !== 'boolean') {
    Logger.log('Missing valid field. Response: ' + JSON.stringify(parsed));
    return { error: 'Failed to process move. Try again.' };
  }

  if (!parsed.valid) return { error: 'Illegal move: ' + safeTrim(parsed.reason, 200) };

  let nextFen = safeTrim(parsed.fen, CONFIG.MAX_FEN_LEN);
  const stdMove = safeTrim(parsed.move, CONFIG.MAX_MOVE_LEN);

  // Validate and correct the en passant square if needed
  nextFen = correctEnPassantSquare(nextFen);

  if (!isValidFen(nextFen)) return { error: 'Move processing returned invalid position. Try again.' };
  if (!stdMove) return { error: 'Move processing returned invalid move. Try again.' };

  const movePrefix = state.playerColour === 'white' ? state.moveNumber + '.' : state.moveNumber + '...';
  state.fen = nextFen;
  state.moveHistory = safeTrim(
    (state.moveHistory ? state.moveHistory + ' ' : '') + movePrefix + stdMove,
    CONFIG.MAX_MOVEHIST_LEN
  );
  if (state.playerColour === 'black') state.moveNumber++;

  saveGameState(state);
  return { success: true, move: stdMove, fen: nextFen };
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

function buildMoveEmail(claudeResponse) {
  const state = getGameState();

  let body = `Claude plays: ${claudeResponse.move}\n\n`;
  body += `${claudeResponse.comment}\n\n`;
  body += `Move history: ${state.moveHistory}\n\n`;

  if (claudeResponse.gameOver) {
    body += `Game over: ${claudeResponse.result}\n\n`;
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
  if (freshText.startsWith('Claude plays:')) return null;
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

        // Add delay between validation and response calls to avoid rate limiting
        Utilities.sleep(CONFIG.INTER_CALL_DELAY_MS);

        const claudeResult = getClaudeMove();
        if (claudeResult) {
          const emailBody = 'Your move: ' + result.move + '\n\n' + buildMoveEmail(claudeResult);
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
    const claudeResult = getClaudeMove();
    if (claudeResult) {
      let body = `New game! You are black. Difficulty: ${diff}.\n\n`;
      body += buildMoveEmail(claudeResult);
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

  // Step 2: Validate API key and email
  Logger.log('2/4 Validating API key and email...');
  preflight();

  // Step 3: Set up triggers
  Logger.log('3/4 Setting up triggers...');
  setupTriggers();

  // Step 4: Start first game
  Logger.log('4/4 Starting first game...');
  startNewGameViaEmail(CONFIG.DIFFICULTY, CONFIG.PLAYER_COLOUR);

  Logger.log('✅ Setup complete! Check your inbox for the first chess email.');
  Logger.log('📧 The thread will be labeled "chess-claude" and auto-archived after moves.');
  Logger.log('♟️  Reply with your move to play!');
}