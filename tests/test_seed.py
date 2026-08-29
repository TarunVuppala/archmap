import tempfile
import unittest
from pathlib import Path

from packages.seed import apply_seed, load_seed
from packages.seed.health import health_report, record_identity_observation
from packages.graph import GraphStore
from packages.sync import sync_workspace


class SeedTests(unittest.TestCase):
    def test_loads_documented_seed_subset(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "seed.yaml"
            path.write_text(
                "project:\n  name: checkout-platform\n"
                "services:\n  - id: payment-service\n"
                "    paths: [apps/payments]\n"
                "    owns_tables: [payments]\n"
                "    owns_routes: ['POST /payments']\n"
                "pins:\n  - { type: WRITES, from: 'svc:payment-service', to: 'table:payments' }\n"
                "critical: ['svc:payment-service']\n",
                encoding="utf-8",
            )
            seed = load_seed(path)
            self.assertEqual(seed["project"]["name"], "checkout-platform")
            self.assertEqual(seed["services"][0]["owns_routes"], ["POST /payments"])
            self.assertEqual(seed["pins"][0]["type"], "WRITES")

    def test_sync_applies_seed_after_parsed_endpoints_exist(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "service.py").write_text("def settle():\n    return 1\n", encoding="utf-8")
            seed_dir = root / ".archmap"
            seed_dir.mkdir()
            (seed_dir / "seed.yaml").write_text(
                "project:\n  name: checkout-platform\n"
                "services:\n  - id: payment-service\n    owns_tables: [payments]\n"
                "pins:\n  - { type: WRITES, from: 'fn:service.py:settle', to: 'table:payments' }\n"
                "critical: ['fn:service.py:settle']\n",
                encoding="utf-8",
            )
            result = sync_workspace(root)
            self.assertTrue(result["ok"])
            self.assertTrue(result["seed"]["loaded"])
            with GraphStore(root / ".archmap" / "index.db", root) as store:
                node = store.get_node("fn:service.py:settle")
                edge = store.connection.execute("SELECT type FROM edges WHERE type = 'WRITES'").fetchone()
            self.assertTrue(node["critical"])
            self.assertEqual(edge[0], "WRITES")

    def test_apply_seed_builds_service_route_and_external_edges(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with GraphStore(root / "index.db", root) as store:
                result = apply_seed(store, root)
                self.assertFalse(result["loaded"])
                seed_dir = root / ".archmap"
                seed_dir.mkdir()
                (seed_dir / "seed.yaml").write_text(
                    "services:\n  - id: payments\n    owns_routes: ['POST /payments']\n"
                    "externals:\n  - id: mobile\n    consumes: ['POST /payments']\n",
                    encoding="utf-8",
                )
                result = apply_seed(store, root)
                self.assertTrue(result["loaded"])
                route = store.get_node("api:POST:/payments")
                consume = store.connection.execute("SELECT type FROM edges WHERE type = 'CONSUMES'").fetchone()
            self.assertEqual(route["kind"], "API")
            self.assertEqual(consume[0], "CONSUMES")

    def test_identity_thrash_pauses_inference_after_three_changes(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            with GraphStore(Path(directory) / "index.db", directory) as store:
                record_identity_observation(store, "same-fingerprint", ["payments"])
                record_identity_observation(store, "same-fingerprint", ["orders"])
                record_identity_observation(store, "same-fingerprint", ["ledger"])
                state = record_identity_observation(store, "same-fingerprint", ["shipping"])
                report = health_report(store)
            self.assertTrue(state["paused"])
            self.assertEqual(state["thrash_count"], 3)
            self.assertIn("inference_paused", report["risk"])


if __name__ == "__main__":
    unittest.main()
