"""Replace the goal-2 run statistics in the papers with the final recorded run's numbers.
Usage: python tools/_fill_stats.py <stats.sh output file>"""
import io, re, sys
txt = io.open(sys.argv[1], encoding="utf-8").read()
def g(pat):
    m = re.search(pat, txt); return int(m.group(1)) if m else None
new = dict(claude=g(r"claude calls w/ jev:\s+\d+ of (\d+)"), claude_with=g(r"claude calls w/ jev:\s+(\d+) of"),
           consults=g(r"consultations (\d+)"), questions=g(r"questions inside Claude (\d+)"),
           navcam=g(r"navcam frames:\s+(\d+)"), fh=g(r"front hazcam frames:\s+(\d+)"), rh=g(r"rear hazcam frames:\s+(\d+)"),
           jev_nav=g(r"jev navcam calls:\s+(\d+)"), jev_haz_f=g(r"jev hazcam calls:\s+(\d+)"), jev_haz_r=g(r"\+ rear (\d+)"),
           vetoes=g(r"hazcam vetoes:\s+(\d+)"), enav_f=g(r"enav evaluations:\s+(\d+) fwd"), enav_r=g(r"\+ (\d+) rev"),
           aegis=g(r"jev aegis/fault/verify: (\d+)"), fault=g(r"jev aegis/fault/verify: \d+ / (\d+)"), verify=g(r"jev aegis/fault/verify: \d+ / \d+ / (\d+)"))
cost = re.search(r"cost: (\$[0-9.]+)", txt).group(1)
new["jev_haz"] = new["jev_haz_f"] + new["jev_haz_r"]
new["jev_onboard"] = new["jev_nav"] + new["jev_haz"] + new["aegis"] + new["fault"] + new["verify"]
new["share"] = round(100 * new["consults"] / (new["consults"] + new["jev_onboard"]))
ms_lo, ms_hi = int(sys.argv[2]), int(sys.argv[3])
print(new, cost, ms_lo, ms_hi)

old = dict(claude=13, claude_with=10, consults=12, questions=38, ms_lo=197, ms_hi=506, jev_onboard=75, jev_nav=26, jev_haz=45, share=14)
S = dict(new, ms_lo=ms_lo, ms_hi=ms_hi)
pairs = [
 (f"{old['claude']} Claude calls, {old['claude_with']} of which consulted jev --- {old['consults']} consultations, {old['questions']} typed questions, {old['ms_lo']}--{old['ms_hi']}\\,ms each",
  f"{S['claude']} Claude calls, {S['claude_with']} of which consulted jev --- {S['consults']} consultations, {S['questions']} typed questions, {S['ms_lo']}--{S['ms_hi']}\\,ms each"),
 (f"the rover itself made {old['jev_onboard']} jev requests while driving ({old['jev_nav']} Navcam, {old['jev_haz']} Hazcam",
  f"the rover itself made {S['jev_onboard']} jev requests while driving ({S['jev_nav']} Navcam, {S['jev_haz']} Hazcam"),
 (f"So about {old['share']}\\,\\% of all System One calls", f"So about {S['share']}\\,\\% of all System One calls"),
 (f"{old['consults']} consultations and {old['questions']} typed questions across {old['claude']} Claude calls", f"{S['consults']} consultations and {S['questions']} typed questions across {S['claude']} Claude calls"),
 (f"{old['claude_with']} of {old['claude']} Claude calls consulted jev --- {old['consults']} consultations, {old['questions']} questions --- against {old['jev_onboard']} onboard calls; about {old['share']}",
  f"{S['claude_with']} of {S['claude']} Claude calls consulted jev --- {S['consults']} consultations, {S['questions']} questions --- against {S['jev_onboard']} onboard calls; about {S['share']}"),
 # markdown variants
 (f"**{old['claude']} Claude calls, {old['claude_with']} of which consulted jev — {old['consults']} consultations, {old['questions']} typed questions, {old['ms_lo']}–{old['ms_hi']} ms each.**",
  f"**{S['claude']} Claude calls, {S['claude_with']} of which consulted jev — {S['consults']} consultations, {S['questions']} typed questions, {S['ms_lo']}–{S['ms_hi']} ms each.**"),
 (f"The rover itself made {old['jev_onboard']} jev requests while driving ({old['jev_nav']} Navcam, {old['jev_haz']} Hazcam",
  f"The rover itself made {S['jev_onboard']} jev requests while driving ({S['jev_nav']} Navcam, {S['jev_haz']} Hazcam"),
 (f"So about {old['share']} % of all System One calls", f"So about {S['share']} % of all System One calls"),
 (f"{old['claude_with']} of {old['claude']} Claude calls consulted jev — {old['consults']} consultations, {old['questions']} questions — against {old['jev_onboard']} onboard calls; about {old['share']} %",
  f"{S['claude_with']} of {S['claude']} Claude calls consulted jev — {S['consults']} consultations, {S['questions']} questions — against {S['jev_onboard']} onboard calls; about {S['share']} %"),
 (f"On the recorded run: {old['claude']} Claude calls, {old['claude_with']} with consultations, {old['consults']} consultations, {old['questions']} questions, {old['ms_lo']}–{old['ms_hi']} ms; {old['jev_onboard']} onboard jev requests.",
  f"On the recorded run: {S['claude']} Claude calls, {S['claude_with']} with consultations, {S['consults']} consultations, {S['questions']} questions, {S['ms_lo']}–{S['ms_hi']} ms; {S['jev_onboard']} onboard jev requests."),
]
for path in ("docs/jezero-ops-report.tex", "docs/jezero-ops-report.md", "docs/vision-paper.tex", "docs/vision-paper.md", "docs/ros2-migration.md"):
    s = io.open(path, encoding="utf-8").read(); n = 0
    for a, b in pairs:
        if a in s: s = s.replace(a, b); n += 1
    io.open(path, "w", encoding="utf-8", newline="\n").write(s); print(path, n, "replacements")
# decision graph II footer
p = "tools/decision_graph2.py"; s = io.open(p, encoding="utf-8").read()
s = re.sub(r"Measured on the ROS 2 run: \d+ Claude calls, \d+ of them consulted jev — \d+ consultations, \d+ questions, \d+–\d+ ms each; the rover itself made \d+ jev requests while driving\.",
           f"Measured on the ROS 2 run: {S['claude']} Claude calls, {S['claude_with']} of them consulted jev — {S['consults']} consultations, {S['questions']} questions, {S['ms_lo']}–{S['ms_hi']} ms each; the rover itself made {S['jev_onboard']} jev requests while driving.", s)
s = s.replace('"197–506 ms · 1–6 questions"', f'"{S["ms_lo"]}–{S["ms_hi"]} ms · 1–6 questions"')
io.open(p, "w", encoding="utf-8", newline="\n").write(s); print("graph2 footer updated")
