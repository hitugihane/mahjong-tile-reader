"""テストページを headless Chromium で開き、window.results を表示する。
使い方: python3 test/run-page.py test/redleak.html?x=1
"""
import json
import sys
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("pageerror", lambda e: print("pageerror:", e))
    page.goto("http://127.0.0.1:8765/" + sys.argv[1], wait_until="commit")
    page.wait_for_function("window.results", timeout=600000, polling=1000)
    r = page.evaluate("window.results")
    if isinstance(r, list):
        for row in r:
            print(json.dumps(row, ensure_ascii=False))
    else:
        print(json.dumps(r, ensure_ascii=False, indent=1))
    browser.close()
