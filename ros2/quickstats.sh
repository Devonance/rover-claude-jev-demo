#!/usr/bin/env bash
# Goal-3 counters from a launch log: frame gate, health verdicts, actions, cancels, reviews, downlink, samples.
f="${1:-/root/launch.log}"
c() { grep -c -F -- "$1" "$f"; }
echo "frame gate:     fired $(c 'Frame usability gate') of $(c 'judge[frame]') frames judged"
echo "health:         $(c 'health #') verdicts, $(grep -F 'health #' "$f" | grep -vc nominal) non-nominal; halts $(c 'halt drive immediately')"
echo "claude actions: $(c 'ask[') asks, $(c '(action)') started, cancelled $(c 'cancelled by the executive'), re-issued $(c 're-issuing')"
echo "review:         $(c 'plan verification:') verifications (incl. objectives); downlink: $(c 'judge[downlink]'); sample checks: $(c 'judge[sample]')"
echo "arm:            $(c 'judge[placement]') placements judged, $(c 'judge[contact]') pre-contact checks"
echo "errors:         $(grep -E 'ERROR|Traceback' "$f" | grep -vc rosbridge)"
