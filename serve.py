import http.server, socketserver, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))

class Handler(http.server.SimpleHTTPRequestHandler):
    def guess_type(self, path):
        t = super().guess_type(path)
        base = t.split(';')[0] if t else ''
        if base in ('text/html', 'text/css', 'text/javascript', 'application/javascript'):
            return base + '; charset=utf-8'
        return t
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(('0.0.0.0', 8731), Handler) as srv:
    srv.serve_forever()
