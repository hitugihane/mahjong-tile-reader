"""テスト用の静的サーバー（キャッシュさせない）。
使い方: リポジトリ直下で python3 test/serve.py [ポート（既定 8765）]
ライブラリを書き換えたあと、ブラウザが古いファイルを使い回さないようにする。
"""
import functools
import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8765
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
handler = functools.partial(NoCache, directory=root)
http.server.ThreadingHTTPServer(("", port), handler).serve_forever()
