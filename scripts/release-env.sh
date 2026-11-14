#!/usr/bin/env bash
# Runs a command with the release credentials (notarization, publishing) loaded from a file kept
# outside the repository.
set -euo pipefail
ENV_FILE="${MESHWORK_RELEASE_ENV:-$HOME/.config/meshwork/release.env}"
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
exec "$@"
