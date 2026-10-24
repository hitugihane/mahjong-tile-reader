"""精度ベンチマークを headless Chromium で実行する。
使い方: python3 test/run-bench.py "n=800&seed=1&jpeg=0.5&palette=normal" '[{"name":"既定","opts":{}}]'
事前にリポジトリ直下で `python3 -m http.server 8765` を起動しておくこと。
"""
import json
import sys
import urllib.parse
from playwright.sync_api import sync_playwright

query = sys.argv[1] if len(sys.argv) > 1 else "n=300"
variants = sys.argv[2] if len(sys.argv) > 2 else '[{"name":"既定","opts":{}}]'

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.on("pageerror", lambda e: print("pageerror:", e))
    url = f"http://127.0.0.1:8765/test/bench.html?{query}&variants={urllib.parse.quote(variants)}"
    page.goto(url, wait_until="commit")
    page.wait_for_function("window.results", timeout=900000, polling=2000)
    for name, r in page.evaluate("window.results").items():
        flagged = f"（うち自信なし表示 {r['wrongFlagged']*100:.0f}%）" if r.get('wrongFlagged') is not None else ""
        print(f"{name}: 正解 {r['tileAccuracy']*100:.2f}%  誤り {r['wrong']*100:.2f}%{flagged}  読めず {r['unread']*100:.2f}%  手牌まるごと {r['perfectHands']*100:.1f}%  枚数 {r['countAccuracy']*100:.1f}%  {r['msPerHand']}ms")
        print("   ", r["by"])
        print("   ", r["topConfusions"][:6])
    browser.close()
