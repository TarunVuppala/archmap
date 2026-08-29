import json
import tempfile
import threading
import unittest
from http.client import HTTPConnection
from pathlib import Path

from packages.daemon import create_server


class DaemonTests(unittest.TestCase):
    def test_localhost_routes_use_graph_contract(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "service.py").write_text("def processPayment(tx):\n    return tx\n", encoding="utf-8")
            server = create_server(root, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = HTTPConnection("127.0.0.1", server.server_port)
                connection.request("POST", "/v1/sync", json.dumps({"workspace": str(root)}), {"Content-Type": "application/json"})
                sync = json.loads(connection.getresponse().read())
                self.assertTrue(sync["ok"])
                connection.request("POST", "/v1/blast_radius", json.dumps({"id": "fn:service.py:processPayment", "workspace": str(root)}), {"Content-Type": "application/json"})
                impact = json.loads(connection.getresponse().read())
                self.assertTrue(impact["ok"])
                self.assertIn("evidence_used", impact)
                connection.request("POST", "/v1/graph", json.dumps({"workspace": str(root)}), {"Content-Type": "application/json"})
                graph = json.loads(connection.getresponse().read())
                self.assertIn("fn:service.py:processPayment", {node["id"] for node in graph["nodes"]})
            finally:
                server.shutdown()
                server.server_close()

    def test_health_is_local_and_reports_port(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            server = create_server(directory, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = HTTPConnection("127.0.0.1", server.server_port)
                connection.request("GET", "/health")
                health = json.loads(connection.getresponse().read())
                self.assertEqual(health, {"ok": True, "service": "architecture-mapper", "port": server.server_port})
            finally:
                server.shutdown()
                server.server_close()

    def test_unknown_route_returns_json_error(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            server = create_server(directory, port=0)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                connection = HTTPConnection("127.0.0.1", server.server_port)
                connection.request("POST", "/v1/unknown", "{}", {"Content-Type": "application/json"})
                response = connection.getresponse()
                payload = json.loads(response.read())
                self.assertEqual(response.status, 400)
                self.assertFalse(payload["ok"])
            finally:
                server.shutdown()
                server.server_close()


if __name__ == "__main__":
    unittest.main()
