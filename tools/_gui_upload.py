"""Upload files to the open Drive folder tab by driving the real Chrome window (2560x1080, maximized, no bookmarks bar).
  python tools/_gui_upload.py <folder> <name1> [name2 ...]   -> screenshot to shots/upload_<n>.png afterwards
"""
import sys, time, os, pyautogui
folder = os.path.abspath(sys.argv[1]); names = sys.argv[2:]
pyautogui.FAILSAFE = False
pyautogui.click(69, 178); time.sleep(1.5)          # + New
pyautogui.click(101, 224); time.sleep(3.0)         # File upload -> native Open dialog
pyautogui.click(589, 686); time.sleep(0.5)         # File name box
pyautogui.hotkey("ctrl", "a"); pyautogui.typewrite(folder); pyautogui.press("enter"); time.sleep(2.0)
pyautogui.click(589, 686); time.sleep(0.3); pyautogui.hotkey("ctrl", "a")
sel = " ".join(f'"{n}"' for n in names) if len(names) > 1 else names[0]
pyautogui.typewrite(sel); time.sleep(0.5); pyautogui.press("enter")
time.sleep(4.0)
out = f"shots/upload_{int(time.time())}.png"; pyautogui.screenshot().save(out); print(out)
