import io
import json
import tempfile
import unittest
from pathlib import Path

from packages.mcp import McpServer, run_stdio


class McpTests(unittest.TestCase):
    def test_initialize_and_tool_listing(self) -> None:
        server = McpServer()
        initialized = server.handle({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}})
        self.assertEqual(initialized["result"]["serverInfo"]["name"], "architecture-mapper")
        listed = server.handle({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        self.assertEqual({tool["name"] for tool in listed["result"]["tools"]}, {"sync", "blast_radius", "diff_impact", "docs_for", "pin", "health"})
        self.assertIsNone(server.handle({"jsonrpc": "2.0", "method": "notifications/initialized"}))

    def test_sync_and_blast_radius_return_structured_json(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "service.py"
            source.write_text("def processPayment(tx):\n    return tx\n", encoding="utf-8")
            server = McpServer(root)
            sync = server.handle({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {"name": "sync", "arguments": {}},
            })
            sync_payload = sync["result"]["structuredContent"]
            self.assertTrue(sync_payload["ok"])
            impact = server.handle({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "blast_radius",
                    "arguments": {"id": "fn:service.py:processPayment"},
                },
            })
            impact_payload = impact["result"]["structuredContent"]
            self.assertTrue(impact_payload["ok"])
            self.assertEqual(json.loads(impact["result"]["content"][0]["text"]), impact_payload)

    def test_stdio_skips_notifications(self) -> None:
        incoming = io.StringIO(
            '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n'
            '{"jsonrpc":"2.0","method":"notifications/initialized"}\n'
            '{"jsonrpc":"2.0","id":2,"method":"tools/list"}\n'
        )
        outgoing = io.StringIO()
        self.assertEqual(run_stdio(input_stream=incoming, output_stream=outgoing), 0)
        responses = [json.loads(line) for line in outgoing.getvalue().splitlines()]
        self.assertEqual([response["id"] for response in responses], [1, 2])

    def test_invalid_tool_arguments_are_structured_errors(self) -> None:
        response = McpServer().handle({
            "jsonrpc": "2.0",
            "id": 5,
            "method": "tools/call",
            "params": {"name": "blast_radius", "arguments": {}},
        })
        self.assertTrue(response["result"]["isError"])
        self.assertFalse(response["result"]["structuredContent"]["ok"])


if __name__ == "__main__":
    unittest.main()
