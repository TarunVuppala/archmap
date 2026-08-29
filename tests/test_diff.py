import tempfile
import unittest
from pathlib import Path

from packages.diff import diff_impact, parse_unified_diff
from packages.graph import GraphStore


class DiffTests(unittest.TestCase):
    def test_unified_diff_tracks_added_and_removed_lines(self) -> None:
        files = parse_unified_diff(
            "diff --git a/service.py b/service.py\n"
            "--- a/service.py\n+++ b/service.py\n"
            "@@ -2,2 +2,3 @@\n"
            " def processPayment(tx):\n"
            "-    return old(tx)\n"
            "+    validateTransaction(tx)\n"
            "+    return tx\n"
        )
        self.assertEqual(len(files), 1)
        self.assertEqual(files[0].old_lines, {3})
        self.assertEqual(files[0].new_lines, {3, 4})

    def test_diff_impact_classifies_body_change_and_walks_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            old = "def processPayment(tx):\n    return validateTransaction(tx)\n"
            new = "def processPayment(tx):\n    return validateTransaction(tx, strict=True)\n"
            source = root / "service.py"
            source.write_text(new, encoding="utf-8")
            with GraphStore(root / "index.db", root) as store:
                for node in (
                    {"id": "fn:service.py:processPayment", "kind": "Function", "name": "processPayment"},
                    {"id": "svc:payments", "kind": "Service", "name": "PaymentService"},
                ):
                    store.upsert_node(node)
                store.upsert_edge({
                    "id": "e_service",
                    "type": "CALLS",
                    "from": "svc:payments",
                    "to": "fn:service.py:processPayment",
                    "evidence": {"file": "service.py", "line": 1, "snippet": "processPayment(tx)"},
                    "sources": ["parser"],
                })

                def load(ref, path):
                    return old if ref == "main" else new

                report = diff_impact(
                    store,
                    root,
                    "diff --git a/service.py b/service.py\n--- a/service.py\n+++ b/service.py\n@@ -2 +2 @@\n-    return validateTransaction(tx)\n+    return validateTransaction(tx, strict=True)\n",
                    source_loader=load,
                )
            self.assertEqual(len(report["changed_symbols"]["body_only"]), 1)
            self.assertEqual(report["changed_symbols"]["body_only"][0]["id"], "fn:service.py:processPayment")
            self.assertIn("svc:payments", {node["id"] for node in report["nodes"]})
            self.assertEqual(report["diff"]["files"], ["service.py"])

    def test_diff_reports_contract_schema_and_infra_deltas(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with GraphStore(root / "index.db", root) as store:
                report = diff_impact(
                    store,
                    root,
                    "diff --git a/openapi.yaml b/openapi.yaml\n"
                    "--- a/openapi.yaml\n+++ b/openapi.yaml\n"
                    "@@ -1 +1 @@\n-old\n+new\n"
                    "diff --git a/migrations/001.sql b/migrations/001.sql\n"
                    "--- a/migrations/001.sql\n+++ b/migrations/001.sql\n"
                    "@@ -1 +1 @@\n-old\n+new\n",
                    source_loader=lambda _ref, _path: "",
                )
            self.assertEqual(
                report["contract_deltas"],
                [
                    {"path": "openapi.yaml", "kind": "contract"},
                    {"path": "migrations/001.sql", "kind": "schema"},
                ],
            )


if __name__ == "__main__":
    unittest.main()
