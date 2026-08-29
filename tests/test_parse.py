import tempfile
import unittest
from pathlib import Path

from packages.graph import GraphStore
from packages.parse import parse_file


class ParserTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_python_parser_emits_symbols_calls_route_and_evidence(self) -> None:
        path = self.root / "apps" / "payments" / "service.py"
        path.parent.mkdir(parents=True)
        path.write_text(
            "from .validate import validateTransaction\n"
            "from stripe import Client\n\n"
            "@app.post('/payments')\n"
            "def processPayment(tx):\n"
            "    return validateTransaction(tx)\n\n"
            "def validateTransaction(tx):\n"
            "    return tx\n",
            encoding="utf-8",
        )
        parsed = parse_file(path, self.root)
        node_ids = {node["id"] for node in parsed.nodes}
        edge_types = {(edge["type"], edge["from"], edge["to"]) for edge in parsed.edges}
        self.assertEqual(parsed.mode, "python-ast")
        self.assertIn("fn:apps/payments/service.py:processPayment", node_ids)
        self.assertIn("fn:apps/payments/service.py:validateTransaction", node_ids)
        self.assertIn("ext:stripe", node_ids)
        self.assertIn("mod:apps/payments/validate", node_ids)
        self.assertIn("api:POST:/payments", node_ids)
        self.assertIn(
            ("CALLS", "fn:apps/payments/service.py:processPayment", "fn:apps/payments/service.py:validateTransaction"),
            edge_types,
        )
        for edge in parsed.edges:
            self.assertIn("file", edge["evidence"])
            self.assertIsInstance(edge["evidence"]["line"], int)
            self.assertTrue(edge["evidence"]["snippet"])

    def test_typescript_parser_emits_shallow_symbols_imports_and_routes(self) -> None:
        path = self.root / "apps" / "orders" / "service.ts"
        path.parent.mkdir(parents=True)
        path.write_text(
            "import { processPayment } from '../payments/service';\n"
            "export function createOrder(input) {\n"
            "  return processPayment(input);\n"
            "}\n"
            "app.post('/orders', createOrder);\n",
            encoding="utf-8",
        )
        parsed = parse_file(path, self.root)
        node_ids = {node["id"] for node in parsed.nodes}
        edge_types = {(edge["type"], edge["from"], edge["to"]) for edge in parsed.edges}
        self.assertEqual(parsed.mode, "typescript-shallow")
        self.assertIn("fn:apps/orders/service.ts:createOrder", node_ids)
        self.assertIn("mod:apps/payments/service", node_ids)
        self.assertIn("api:POST:/orders", node_ids)
        self.assertIn(
            ("EXPOSES", "fn:apps/orders/service.ts:createOrder", "api:POST:/orders"),
            edge_types,
        )

    def test_parser_output_can_be_upserted_into_one_graph(self) -> None:
        path = self.root / "worker.py"
        path.write_text("def run():\n    return 1\n", encoding="utf-8")
        parsed = parse_file(path, self.root)
        with GraphStore(self.root / "index.db", self.root) as store:
            for node in parsed.nodes:
                store.upsert_node(node)
            for edge in parsed.edges:
                store.upsert_edge(edge)
            self.assertIsNotNone(store.get_node("fn:worker.py:run"))
            self.assertEqual(store.connection.execute("SELECT COUNT(*) FROM edges").fetchone()[0], len(parsed.edges))


if __name__ == "__main__":
    unittest.main()
