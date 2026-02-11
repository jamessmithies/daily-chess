// Test script for chess.js validation
// This tests the key scenarios including the Nf3 move that was failing

import { Chess } from 'chess.js';

function testMoveValidation() {
  console.log('Testing Chess Move Validation\n');
  console.log('=' .repeat(50));

  // Test 1: Initial position - Nf3 should be legal
  console.log('\nTest 1: Knight to f3 from starting position');
  let chess = new Chess();
  console.log('FEN:', chess.fen());
  let move = chess.move('Nf3');
  if (move) {
    console.log('✓ Nf3 is LEGAL (as expected)');
    console.log('  Move details:', move);
    console.log('  New FEN:', chess.fen());
  } else {
    console.log('✗ Nf3 was rejected (UNEXPECTED - THIS IS THE BUG)');
  }

  // Test 2: After 1.e4 e5, test 2.Nf3 (common opening)
  console.log('\nTest 2: After 1.e4 e5, play 2.Nf3');
  chess = new Chess();
  chess.move('e4');
  chess.move('e5');
  console.log('Position after 1.e4 e5:', chess.fen());
  move = chess.move('Nf3');
  if (move) {
    console.log('✓ Nf3 is LEGAL after 1.e4 e5');
    console.log('  New FEN:', chess.fen());
  } else {
    console.log('✗ Nf3 was rejected after 1.e4 e5');
  }

  // Test 3: Pawn move notation (just square)
  console.log('\nTest 3: Pawn moves with just square notation');
  chess = new Chess();
  move = chess.move('e4');  // Should work
  if (move) {
    console.log('✓ e4 pawn move accepted');
  } else {
    console.log('✗ e4 pawn move rejected');
  }

  // Test 4: Bishop moves like Be2
  console.log('\nTest 4: Bishop to e2 after appropriate setup');
  chess = new Chess();
  chess.move('e4');
  chess.move('e5');
  chess.move('Nf3');
  chess.move('Nc6');
  console.log('Position before Be2:', chess.fen());
  move = chess.move('Be2');
  if (move) {
    console.log('✓ Be2 is LEGAL');
    console.log('  New FEN:', chess.fen());
  } else {
    console.log('✗ Be2 was rejected');
    console.log('  Legal moves:', chess.moves().filter(m => m.startsWith('B')).join(', '));
  }

  // Test 5: Illegal move detection
  console.log('\nTest 5: Illegal move detection');
  chess = new Chess();
  try {
    move = chess.move('Nf6');  // Can't move to f6 from starting position
    if (move) {
      console.log('✗ Nf6 was incorrectly accepted');
    }
  } catch (e) {
    console.log('✓ Nf6 correctly rejected from starting position (threw error)');
    const knightMoves = chess.moves().filter(m => m.startsWith('N'));
    console.log('  Legal knight moves:', knightMoves.join(', '));
  }

  // Test 6: En passant detection
  console.log('\nTest 6: En passant square validation');
  chess = new Chess('rnbqkbnr/pppppppp/8/8/1P6/8/P1PPPPPP/RNBQKBNR b KQkq b3 0 1');
  console.log('FEN with en passant square b3:', chess.fen());
  const fen = chess.fen();
  if (fen.includes('b3')) {
    console.log('✓ En passant square b3 preserved');
  } else {
    console.log('✗ En passant square was changed');
  }

  console.log('\n' + '=' .repeat(50));
  console.log('Testing complete!');
}

// Run the tests
testMoveValidation();