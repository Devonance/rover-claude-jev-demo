#!/usr/bin/env bash
# Count what the graph did in a launch log: frames per camera group, jev calls, vetoes, Claude calls.
f="${1:-/root/launch.log}"
c() { grep -c -F -- "$1" "$f"; }
echo "navcam frames:        $(c '[navcam] frame')"
echo "front hazcam frames:  $(c '[front_hazcam] frame')"
echo "rear hazcam frames:   $(c '[rear_hazcam] frame')"
echo "jev navcam calls:     $(c '[navcam] classified')"
echo "jev hazcam calls:     $(c '[front_hazcam] classified')  + rear $(c '[rear_hazcam] classified')"
echo "hazcam vetoes:        $(grep -F 'sol_executive' "$f" | grep -c -F 'veto')"
echo "jev aegis/fault/verify: $(c 'aegis:') / $(c 'fault triage:') / $(c 'plan verification:')"
echo "enav evaluations:     $(c '[enav]: forward') fwd + $(c '[enav]: reverse') rev"
echo "claude calls:         $(c 'ask[') ask + $(c 'describe') describe;  cost: $(grep -oE '\$[0-9]+\.[0-9]+' "$f" | tr -d '$' | awk '{s+=$1} END {printf "$%.2f", s}')"
echo "claude calls w/ jev:  $(grep -cE '[1-9] jev consult' "$f") of $(grep -c 'jev consult' "$f"); consultations $(grep -oE '[0-9]+ jev consult' "$f" | awk '{s+=$1} END {print s+0}'); questions inside Claude $(grep -oE '\[[0-9]+ q,' "$f" | tr -dc '0-9
' | awk '{s+=$1} END {print s+0}')"
echo "errors:               $(grep -E 'ERROR|Traceback' "$f" | grep -vc rosbridge)"
