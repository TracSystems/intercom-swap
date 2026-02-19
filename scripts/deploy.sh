#!/usr/bin/env bash
set -e
msg="${1:-update}"
git add -A
git commit -m "$msg" || true
git pull --rebase origin main
git push origin main
echo "✅ pushed to GitHub"
