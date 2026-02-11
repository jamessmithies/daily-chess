// Local test for the Stockfish Cloud Function
// Tests the getBestMove function directly without the HTTP layer
//
// Run with: node test.js

const { spawn } = require('child_process');
const path = require('path');

const DIFFICULTY_PRESETS = {
  beginner:     { skillLevel: 3,  depth: 5  },
  intermediate: { skillLevel: 10, depth: 10 },
  advanced:     { skillLevel: 20, depth: 15 },
};

const ENGINE_PATH = path.join(
  __dirname, 'node_modules', 'stockfish', 'src', 'stockfish-nnue-16.js'
);

function getBestMove(fen, difficulty) {
  return new Promise((resolve, reject) => {
    const preset = DIFFICULTY_PRESETS[difficulty] || DIFFICULTY_PRESETS.intermediate;
    const engine = spawn(process.execPath, [ENGINE_PATH], { stdio: 'pipe' });

    const outputLines = [];
    let phase = 'uci';
    let settled = false;

    function finish(err, result) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { engine.kill(); } catch (_) {}
      if (err) reject(err); else resolve(result);
    }

    const timer = setTimeout(() => finish(new Error('Timeout')), 60000);

    engine.stdout.on('data', (data) => {
      const lines = data.toString().split('\n').filter(l => l.trim());
      for (const line of lines) {
        if (settled) return;
        if (phase === 'uci' && line === 'uciok') {
          phase = 'ready';
          engine.stdin.write(`setoption name Skill Level value ${preset.skillLevel}\n`);
          engine.stdin.write('setoption name Threads value 1\n');
          engine.stdin.write('ucinewgame\n');
          engine.stdin.write('isready\n');
        } else if (phase === 'ready' && line === 'readyok') {
          phase = 'search';
          engine.stdin.write(`position fen ${fen}\n`);
          engine.stdin.write(`go depth ${preset.depth}\n`);
        } else if (phase === 'search') {
          outputLines.push(line);
          if (line.startsWith('bestmove')) {
            phase = 'done';
            engine.stdin.write('quit\n');
            const match = line.match(/bestmove\s+(\S+)/);
            if (!match) { finish(new Error('No bestmove')); return; }
            let evaluation = null;
            for (let i = outputLines.length - 1; i >= 0; i--) {
              const m = outputLines[i].match(/score\s+(cp|mate)\s+(-?\d+)/);
              if (m) { evaluation = { type: m[1], value: parseInt(m[2]) }; break; }
            }
            finish(null, { move: match[1], evaluation });
          }
        }
      }
    });
    engine.stderr.on('data', () => {});
    engine.on('error', (err) => finish(err));
    engine.on('close', (code) => { if (!settled) finish(new Error('Exit ' + code)); });
    engine.stdin.write('uci\n');
  });
}

async function runTests() {
  console.log('Stockfish Cloud Function - Local Tests');
  console.log('='.repeat(50));

  // Test 1: Starting position, beginner
  console.log('\nTest 1: Starting position (beginner, depth 5)');
  let t = Date.now();
  let result = await getBestMove('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1', 'beginner');
  console.log(`  Move: ${result.move} | Eval: ${result.evaluation?.type} ${result.evaluation?.value} | ${Date.now() - t}ms`);

  // Test 2: After 1.e4 e5, intermediate
  console.log('\nTest 2: After 1.e4 e5 (intermediate, depth 10)');
  t = Date.now();
  result = await getBestMove('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2', 'intermediate');
  console.log(`  Move: ${result.move} | Eval: ${result.evaluation?.type} ${result.evaluation?.value} | ${Date.now() - t}ms`);

  // Test 3: Middlegame (advanced, depth 15)
  console.log('\nTest 3: Sicilian Najdorf (advanced, depth 15)');
  t = Date.now();
  result = await getBestMove('r1bqkb1r/1p2pppp/p1np1n2/6B1/3NP3/2N5/PPP2PPP/R2QKB1R w KQkq - 0 6', 'advanced');
  console.log(`  Move: ${result.move} | Eval: ${result.evaluation?.type} ${result.evaluation?.value} | ${Date.now() - t}ms`);

  // Test 4: Black to move
  console.log('\nTest 4: Black to move (intermediate)');
  t = Date.now();
  result = await getBestMove('rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1', 'intermediate');
  console.log(`  Move: ${result.move} | Eval: ${result.evaluation?.type} ${result.evaluation?.value} | ${Date.now() - t}ms`);

  console.log('\n' + '='.repeat(50));
  console.log('All tests passed!');
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error('FAILED:', err);
  process.exit(1);
});
