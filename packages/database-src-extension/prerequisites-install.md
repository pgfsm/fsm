
# pgrx (Rust-based Postgres Extension Tool) Prerequisites on macOS

To use [pgrx](https://github.com/pgcentralfoundation/pgrx) for building Postgres extensions in Rust, you need to install the following prerequisites on macOS:

```sh
brew install git icu4c pkg-config
```

After installing `icu4c` and `pkg-config`, Homebrew may suggest the following steps:

If you need to have `icu4c@78` first in your `PATH`, run:

```sh
echo 'export PATH="/opt/homebrew/opt/icu4c@78/bin:$PATH"' >> ~/.zshrc
echo 'export PATH="/opt/homebrew/opt/icu4c@78/sbin:$PATH"' >> ~/.zshrc
```

For compilers to find `icu4c@78` you may need to set:

```sh
export LDFLAGS="-L/opt/homebrew/opt/icu4c@78/lib"
export CPPFLAGS="-I/opt/homebrew/opt/icu4c@78/include"
```

Make sure to restart your terminal or source your `~/.zshrc` after making these changes:

```sh
source ~/.zshrc
```

## Install cargo-pgrx

To install the pgrx toolchain for building PostgreSQL extensions in Rust, run:

```sh
cargo install cargo-pgrx
```

