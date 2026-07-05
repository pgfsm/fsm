// Check that a named public function is declared in a Rust source file.
//
// Compile once: rustc check_fn.rs -o check_fn_rust
// Usage:        ./check_fn_rust <filepath> <fn_name>
// Exit 0 if found, 1 if not, 2 on bad arguments or I/O error.
use std::{env, fs, process};

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("Usage: check_fn_rust <filepath> <fn_name>");
        process::exit(2);
    }
    let filepath = &args[1];
    let fn_name = &args[2];

    let content = match fs::read_to_string(filepath) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("Cannot read {}: {}", filepath, e);
            process::exit(2);
        }
    };

    // Match `pub fn fn_name(` and `pub async fn fn_name(`
    let patterns = [
        format!("pub fn {}(", fn_name),
        format!("pub fn {} (", fn_name),
        format!("pub async fn {}(", fn_name),
        format!("pub async fn {} (", fn_name),
    ];
    for pat in &patterns {
        if content.contains(pat.as_str()) {
            process::exit(0);
        }
    }

    eprintln!("Function '{}' not found in {}", fn_name, filepath);
    process::exit(1);
}
