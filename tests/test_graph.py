import tempfile
import unittest
from pathlib import Path

from packages.graph import GraphError, GraphStore


class GraphStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.store = GraphStore(Path(self.temp_dir.name) / "index.db", self.temp_dir.name)
        for node_id, kind, name in (
            ("fn:service.py:processPayment", "Function", "processPayment"),
            ("fn:validate.py:validateTransaction", "Function", "validateTransaction"),
            ("svc:payments", "Service", "PaymentService"),
            ("api:POST:/payments", "API", "POST /payments"),
            ("table:payments", "Table", "payments"),
            ("svc:orders", "Service", "Order Service"),
            ("test:payments.py:test_process", "Test", "test_process"),
        ):
            self.store.upsert_node({"id": node_id, "kind": kind, "name": name})

    def tearDown(self) -> None:
        self.store.close()
        self.temp_dir.cleanup()

    @staticmethod
    def evidence(file: str = "apps/payments/service.py", line: int = 84, snippet: str = "processPayment()"):
        return {"file": file, "line": line, "snippet": snippet}

    def test_node_upsert_is_stable(self) -> None:
        self.store.upsert_node({"id": "svc:payments", "kind": "Service", "name": "Payments", "critical": True})
        node = self.store.get_node("svc:payments")
        self.assertEqual(node["name"], "Payments")
        self.assertTrue(node["critical"])
        count = self.store.connection.execute("SELECT COUNT(*) FROM nodes WHERE id = 'svc:payments'").fetchone()[0]
        self.assertEqual(count, 1)

    def test_schema_contains_graph_and_journal_tables(self) -> None:
        tables = {
            row[0]
            for row in self.store.connection.execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        self.assertTrue({"nodes", "edges", "chunks", "journal", "health"}.issubset(tables))

    def test_logical_edge_upsert_appends_evidence_without_duplicate(self) -> None:
        first = self.store.upsert_edge({
            "id": "e_call_1",
            "type": "CALLS",
            "from": "svc:payments",
            "to": "fn:service.py:processPayment",
            "evidence": self.evidence(snippet="processPayment(tx)"),
            "sources": ["parser"],
        })
        second = self.store.upsert_edge({
            "id": "e_call_2",
            "type": "CALLS",
            "from": "svc:payments",
            "to": "fn:service.py:processPayment",
            "evidence": self.evidence(line=90, snippet="return processPayment(tx)"),
            "sources": ["runtime"],
        })
        self.assertEqual(first["id"], second["id"])
        self.assertEqual(second["sources"], ["parser", "runtime"])
        self.assertEqual(len(second["evidence"]), 2)
        count = self.store.connection.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        self.assertEqual(count, 1)

    def test_conflicting_rewrite_stays_one_edge_and_keeps_candidate(self) -> None:
        self.store.upsert_edge({
            "id": "e_shared",
            "type": "CALLS",
            "from": "svc:payments",
            "to": "fn:service.py:processPayment",
            "evidence": self.evidence(snippet="processPayment()"),
            "sources": ["parser"],
        })
        edge = self.store.upsert_edge({
            "id": "e_shared",
            "type": "IMPORTS",
            "from": "svc:payments",
            "to": "fn:validate.py:validateTransaction",
            "evidence": self.evidence(line=12, snippet="from validate import validateTransaction"),
            "sources": ["parser"],
        })
        self.assertEqual(edge["type"], "CALLS")
        self.assertTrue(edge["conflict"])
        self.assertEqual(len(edge["evidence"]), 2)
        self.assertEqual(edge["evidence"][1]["edge_candidate"]["type"], "IMPORTS")
        count = self.store.connection.execute("SELECT COUNT(*) FROM edges").fetchone()[0]
        self.assertEqual(count, 1)

    def test_automated_edges_require_evidence(self) -> None:
        with self.assertRaises(GraphError):
            self.store.upsert_edge({
                "id": "e_missing",
                "type": "CALLS",
                "from": "svc:payments",
                "to": "fn:service.py:processPayment",
                "sources": ["parser"],
            })
        pin = self.store.upsert_edge({
            "id": "e_pin",
            "type": "CALLS",
            "from": "svc:payments",
            "to": "fn:service.py:processPayment",
            "evidence": {"pin": "PaymentService owns processPayment"},
            "sources": ["user"],
        })
        self.assertEqual(pin["evidence"]["pin"], "PaymentService owns processPayment")

    def test_impact_returns_paths_counts_and_risks(self) -> None:
        edges = [
            ("e_service", "CALLS", "svc:payments", "fn:service.py:processPayment", 20, "processPayment()"),
            ("e_exposes", "EXPOSES", "svc:payments", "api:POST:/payments", 30, "POST /payments"),
            ("e_consumes", "CONSUMES", "svc:orders", "api:POST:/payments", 14, "client.post('/payments')"),
            ("e_writes", "WRITES", "svc:payments", "table:payments", 22, "INSERT payments"),
            ("e_tests", "TESTS", "test:payments.py:test_process", "fn:service.py:processPayment", 8, "test_processPayment()"),
        ]
        for edge_id, edge_type, from_id, to_id, line, snippet in edges:
            self.store.upsert_edge({
                "id": edge_id,
                "type": edge_type,
                "from": from_id,
                "to": to_id,
                "evidence": self.evidence(line=line, snippet=snippet),
                "sources": ["parser"],
            })

        result = self.store.impact("fn:service.py:processPayment", direction="downstream")
        impacted_ids = {node["id"] for node in result["nodes"]}
        self.assertIn("svc:payments", impacted_ids)
        self.assertIn("api:POST:/payments", impacted_ids)
        self.assertIn("svc:orders", impacted_ids)
        self.assertEqual(result["counts"]["Service"], 2)
        self.assertIn("downstream", result["risk"])
        self.assertTrue(result["evidence_used"])
        self.assertLessEqual(len(result["paths"]), 7)

        table_result = self.store.impact("table:payments", direction="downstream")
        self.assertIn("svc:payments", {node["id"] for node in table_result["nodes"]})
        self.assertIn("db_write", table_result["risk"])

    def test_upstream_calls_follow_caller_to_callee(self) -> None:
        self.store.upsert_edge({
            "id": "e_validate",
            "type": "CALLS",
            "from": "fn:service.py:processPayment",
            "to": "fn:validate.py:validateTransaction",
            "evidence": self.evidence(snippet="validateTransaction(tx)"),
            "sources": ["parser"],
        })
        result = self.store.impact("fn:service.py:processPayment", direction="upstream")
        self.assertIn(
            "fn:validate.py:validateTransaction",
            {node["id"] for node in result["nodes"]},
        )


if __name__ == "__main__":
    unittest.main()
