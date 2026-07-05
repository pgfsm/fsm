// Check that a named function is declared in a Go source file.
//
// Usage: go run check_fn.go <filepath> <fn_name>
// Exit 0 if found, 1 if not, 2 on bad arguments or parse error.
package main

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "Usage: check_fn.go <filepath> <fn_name>")
		os.Exit(2)
	}
	filepath, fnName := os.Args[1], os.Args[2]

	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, filepath, nil, 0)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to parse %s: %v\n", filepath, err)
		os.Exit(2)
	}

	for _, decl := range f.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok {
			if fn.Name.Name == fnName {
				os.Exit(0)
			}
		}
	}

	fmt.Fprintf(os.Stderr, "Function '%s' not found in %s\n", fnName, filepath)
	os.Exit(1)
}
