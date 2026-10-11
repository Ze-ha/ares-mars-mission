#!/bin/bash
# (re)start the local preview servers if they are down: 8766 = dist-single, 8767 = dist-preview (hosted twin)
cd "$(dirname "$0")/.."
for pair in "8766 dist-single" "8767 dist-preview"; do
  set -- $pair
  if ! curl -s -o /dev/null "http://localhost:$1/index.html"; then
    (cd "$2" && nohup python3 -m http.server "$1" >/dev/null 2>&1 &)
  fi
done
sleep 1
