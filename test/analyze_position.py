#!/usr/bin/env python3
"""Analyze the chess position to understand the b3 move issue"""

def parse_and_display_board(fen):
    """Parse FEN and display the board"""
    parts = fen.split()
    board_part = parts[0]
    active_color = parts[1]
    castling = parts[2]
    en_passant = parts[3]
    halfmove = parts[4]
    fullmove = parts[5]

    print("Current Board Position:")
    print("=" * 30)

    ranks = board_part.split('/')
    board = []

    for rank in ranks:
        row = []
        for char in rank:
            if char.isdigit():
                row.extend(['.'] * int(char))
            else:
                row.append(char)
        board.append(row)

    # Display board
    for i, row in enumerate(board):
        rank_num = 8 - i
        print(f"{rank_num} ", end="")
        for piece in row:
            print(f"{piece} ", end="")
        print()
    print("  a b c d e f g h")

    print(f"\nGame State:")
    print(f"- Active color: {active_color}")
    print(f"- Castling rights: {castling}")
    print(f"- En passant square: {en_passant}")
    print(f"- Halfmove clock: {halfmove}")
    print(f"- Fullmove number: {fullmove}")

    return board

def analyze_pawn_moves(board, color):
    """Analyze valid pawn moves for the given color"""
    print(f"\n{color.capitalize()} Pawn Move Analysis:")
    print("-" * 30)

    pawn = 'P' if color == 'white' else 'p'
    direction = -1 if color == 'white' else 1
    start_rank = 6 if color == 'white' else 1

    files = 'abcdefgh'
    valid_moves = []

    for rank_idx in range(8):
        for file_idx in range(8):
            if board[rank_idx][file_idx] == pawn:
                file = files[file_idx]
                rank = 8 - rank_idx

                # Check one square forward
                new_rank_idx = rank_idx + direction
                if 0 <= new_rank_idx < 8 and board[new_rank_idx][file_idx] == '.':
                    move = f"{file}{8 - new_rank_idx}"
                    valid_moves.append(move)
                    print(f"  Pawn on {file}{rank} can move to {move}")

                    # Check two squares forward from starting position
                    if rank_idx == start_rank:
                        two_forward = rank_idx + 2 * direction
                        if board[two_forward][file_idx] == '.':
                            move = f"{file}{8 - two_forward}"
                            valid_moves.append(move)
                            print(f"  Pawn on {file}{rank} can move to {move} (double advance)")

    return valid_moves

def main():
    # Test data from the issue
    test_fen = "rnbqkbnr/pppp1ppp/8/4p3/8/P7/1PPPPPPP/RNBQKBNR w KQkq e6 0 2"
    move_history = "1.a3 1...e5"
    test_move = "b3"

    print("ANALYZING POSITION WHERE b3 IS BEING REJECTED")
    print("=" * 50)
    print(f"FEN: {test_fen}")
    print(f"Move History: {move_history}")
    print(f"Attempted Move: {test_move}")
    print()

    board = parse_and_display_board(test_fen)

    # Analyze white pawn moves
    white_moves = analyze_pawn_moves(board, 'white')

    print(f"\nIs '{test_move}' in valid moves? {test_move in white_moves}")

    if test_move in white_moves:
        print(f"✓ The move '{test_move}' SHOULD be valid!")
        print("  It's a simple pawn advance from b2 to b3.")
    else:
        print(f"✗ According to the board state, '{test_move}' is not valid")
        print("  This indicates a problem with the position parsing or move validation")

    # Check what's on b2 and b3
    print(f"\nSquare Analysis:")
    print(f"  b2 (index [6][1]): {board[6][1]}")  # Should be 'P'
    print(f"  b3 (index [5][1]): {board[5][1]}")  # Should be '.'

    # Additional observations
    print("\nKey Observations:")
    print("1. The FEN shows 'e6' as en passant square, but this seems incorrect")
    print("   - After 1...e5, the en passant square should be 'e6' ONLY if")
    print("   - white has a pawn on d5 or f5 (which they don't)")
    print("2. The b-pawn is clearly on b2 and can legally move to b3")
    print("3. This is a simple pawn advance, not a capture or special move")

if __name__ == "__main__":
    main()