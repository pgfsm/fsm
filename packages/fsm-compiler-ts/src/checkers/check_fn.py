#!/usr/bin/env python3
"""Check that a named function is defined in a Python source file.

Usage: python3 check_fn.py <filepath> <fn_name>
Exit 0 if the function is found, 1 if not, 2 on bad arguments or parse error.
"""

import ast
import sys


def _has_fn(source: str, fn_name: str) -> bool:
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if node.name == fn_name:
                return True
    return False


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: check_fn.py <filepath> <fn_name>", file=sys.stderr)
        sys.exit(2)

    filepath, fn_name = sys.argv[1], sys.argv[2]
    try:
        with open(filepath) as f:
            source = f.read()
    except OSError as e:
        print(f"Cannot read {filepath}: {e}", file=sys.stderr)
        sys.exit(2)

    try:
        found = _has_fn(source, fn_name)
    except SyntaxError as e:
        print(f"Syntax error in {filepath}: {e}", file=sys.stderr)
        sys.exit(2)

    if found:
        sys.exit(0)
    else:
        print(f"Function '{fn_name}' not found in {filepath}", file=sys.stderr)
        sys.exit(1)
