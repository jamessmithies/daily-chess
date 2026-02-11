#!/usr/bin/env python3
"""
Test script to analyze Bishop move validation issues,
particularly the Be2 move when e2 is empty.
"""

def parse_fen_to_board(fen):
    """Parse FEN string and return a 2D board array"""
    board_part = fen.split()[0]
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

    return board

def find_pieces(board, piece):
    """Find all positions of a given piece on the board"""
    positions = []
    files = 'abcdefgh'

    for rank_idx in range(8):
        for file_idx in range(8):
            if board[rank_idx][file_idx] == piece:
                file = files[file_idx]
                rank = 8 - rank_idx
                positions.append(f"{file}{rank}")

    return positions

def can_bishop_move_to(board, from_square, to_square, color):
    """Check if a bishop can legally move from one square to another"""
    files = 'abcdefgh'

    # Parse squares
    from_file = files.index(from_square[0])
    from_rank = int(from_square[1])
    to_file = files.index(to_square[0])
    to_rank = int(to_square[1])

    # Convert to board indices
    from_row = 8 - from_rank
    to_row = 8 - to_rank

    # Check if it's a diagonal move
    file_diff = abs(to_file - from_file)
    rank_diff = abs(to_rank - from_rank)

    if file_diff != rank_diff or file_diff == 0:
        return False, "Not a diagonal move"

    # Check path is clear
    file_step = 1 if to_file > from_file else -1
    rank_step = 1 if to_rank > from_rank else -1
    row_step = -rank_step  # Board rows are inverted

    current_file = from_file + file_step
    current_row = from_row + row_step

    while current_file != to_file:
        if board[current_row][current_file] != '.':
            return False, f"Path blocked at {files[current_file]}{8-current_row}"
        current_file += file_step
        current_row += row_step

    # Check destination square
    dest_piece = board[to_row][to_file]
    if dest_piece != '.':
        if color == 'white' and dest_piece.isupper():
            return False, "Destination occupied by own piece"
        elif color == 'black' and dest_piece.islower():
            return False, "Destination occupied by own piece"

    return True, "Legal move"

def test_bishop_scenarios():
    """Test various Bishop move scenarios"""

    test_cases = [
        {
            "name": "Be2 from starting position",
            "fen": "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1",
            "move": "Be2",
            "expected": False,
            "reason": "e2 is occupied by a pawn"
        },
        {
            "name": "Be2 after e3 (e2 is empty)",
            "fen": "rnbqkbnr/pppppppp/8/8/8/4P3/PPPP1PPP/RNBQKBNR w KQkq - 0 2",
            "move": "Be2",
            "expected": True,
            "reason": "Bishop on f1 can move to e2 (diagonal is clear)"
        },
        {
            "name": "Be2 after e4 (e2 is empty)",
            "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e3 0 2",
            "move": "Be2",
            "expected": True,
            "reason": "Bishop on f1 can move to e2 (diagonal is clear)"
        },
        {
            "name": "Bd3 after e4",
            "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e3 0 2",
            "move": "Bd3",
            "expected": True,
            "reason": "Bishop on f1 can move to d3"
        },
        {
            "name": "Bc4 after e4",
            "fen": "rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e3 0 2",
            "move": "Bc4",
            "expected": True,
            "reason": "Bishop on f1 can move to c4"
        },
        {
            "name": "Be2 with both bishops developed",
            "fen": "rnbqkbnr/pppp1ppp/8/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 0 4",
            "move": "Be2",
            "expected": False,
            "reason": "No bishop can move to e2 (Bc4 cannot reach e2 in one move)"
        }
    ]

    print("BISHOP MOVE VALIDATION TEST")
    print("=" * 60)

    for test in test_cases:
        print(f"\nTest: {test['name']}")
        print(f"FEN: {test['fen']}")
        print(f"Move: {test['move']}")
        print(f"Expected: {'VALID' if test['expected'] else 'INVALID'}")
        print(f"Reason: {test['reason']}")

        # Parse the position
        board = parse_fen_to_board(test['fen'])
        parts = test['fen'].split()
        active_color = 'white' if parts[1] == 'w' else 'black'

        # Find bishops
        bishop_char = 'B' if active_color == 'white' else 'b'
        bishops = find_pieces(board, bishop_char)

        # Extract destination square from move
        dest_square = test['move'][-2:]  # Last two characters

        print(f"\nBoard analysis:")
        print(f"  Active color: {active_color}")
        print(f"  Bishops at: {bishops}")
        print(f"  Destination: {dest_square}")

        # Show relevant board section
        print("\nRelevant board area:")
        for i in range(6, 8):  # Show ranks 2-1
            rank_num = 8 - i
            row = f"{rank_num} "
            for j, piece in enumerate(board[i]):
                row += piece + " "
            print(row)
        print("  a b c d e f g h")

        # Check if any bishop can make the move
        valid_move = False
        for bishop_pos in bishops:
            can_move, reason = can_bishop_move_to(board, bishop_pos, dest_square, active_color)
            if can_move:
                print(f"  ✓ Bishop from {bishop_pos} can move to {dest_square}")
                valid_move = True
                break
            else:
                print(f"  ✗ Bishop from {bishop_pos} cannot move to {dest_square}: {reason}")

        if valid_move == test['expected']:
            print(f"Result: ✓ PASS")
        else:
            print(f"Result: ✗ FAIL - Move should be {'VALID' if test['expected'] else 'INVALID'}")

        print("-" * 40)

def analyze_be2_problem():
    """Specific analysis of the Be2 problem"""
    print("\n" + "=" * 60)
    print("SPECIFIC Be2 PROBLEM ANALYSIS")
    print("=" * 60)

    # Common scenario where Be2 fails
    problem_fen = "rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq e6 0 2"

    print(f"\nProblem scenario FEN: {problem_fen}")
    print("After moves: 1.e4 e5")
    print("Attempting: Be2 (Bishop from f1 to e2)")

    board = parse_fen_to_board(problem_fen)

    print("\nBoard visualization:")
    for i in range(8):
        rank_num = 8 - i
        row = f"{rank_num} "
        for piece in board[i]:
            row += piece + " "
        print(row)
    print("  a b c d e f g h")

    print("\nAnalysis:")
    print("1. The e2 square is EMPTY (pawn moved to e4)")
    print("2. Bishop is on f1")
    print("3. The diagonal f1-e2 is CLEAR")
    print("4. Be2 should be a VALID move")

    can_move, reason = can_bishop_move_to(board, "f1", "e2", "white")
    print(f"\nValidation result: {'✓ VALID' if can_move else '✗ INVALID'}")
    if not can_move:
        print(f"Reason: {reason}")

    print("\nKey points for move validation:")
    print("- 'Be2' means move a Bishop to e2")
    print("- The system should find which Bishop can reach e2")
    print("- In this case, only the f1 Bishop can reach e2")
    print("- The move should be accepted as valid")

if __name__ == "__main__":
    test_bishop_scenarios()
    analyze_be2_problem()