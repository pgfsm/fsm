#!/bin/bash
set -e

# 1. Load .env if present
[ -f .env ] && set -a && source .env && set +a

# 2. Parse named arguments (override env)
while [ $# -gt 0 ]; do
  case "$1" in
	--PGMQ_VERSION) PGMQ_VERSION="$2"; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
  shift
done

# Required environment variables
REQUIRED_VARS=(
	PGMQ_VERSION
)

# Check if required environment variables are set
for var in "${REQUIRED_VARS[@]}"; do
	if [ -z "${!var}" ]; then
		echo "Error: Environment variable $var is not set. Please set it in the .env file or pass it as a named argument."
		exit 1
	fi
done


SQL_DIR="$(dirname "$0")/sql"
DEST_FILE="$SQL_DIR/fsm_core--1.0-base-pgmq-$PGMQ_VERSION.sql"
PGMQ_SQL_URL="https://raw.githubusercontent.com/pgmq/pgmq/$PGMQ_VERSION/pgmq-extension/sql/pgmq.sql"

mkdir -p "$SQL_DIR"

if curl -fsSL "$PGMQ_SQL_URL" -o "$DEST_FILE"; then
  echo "Downloaded pgmq SQL file for $PGMQ_VERSION to $DEST_FILE"
else
  echo "Failed to download pgmq SQL file from $PGMQ_SQL_URL"
  exit 2
fi
