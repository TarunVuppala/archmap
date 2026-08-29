import json
import tempfile
import unittest
from pathlib import Path

from packages.docs import discover_packages, resolve_docs
from packages.graph import GraphStore


class DocsResolverTests(unittest.TestCase):
    def test_discovers_npm_and_pypi_pins_with_lockfile_evidence(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package-lock.json").write_text(
                json.dumps({"packages": {"node_modules/stripe": {"version": "12.0.0"}}}),
                encoding="utf-8",
            )
            (root / "requirements.txt").write_text("requests==2.31.0\n# ignored\n", encoding="utf-8")
            refs = discover_packages(root)
            self.assertEqual(
                {(ref.name, ref.version, ref.manager) for ref in refs},
                {("stripe", "12.0.0", "npm"), ("requests", "2.31.0", "pypi")},
            )
            self.assertTrue(all(ref.line == 1 for ref in refs))

    def test_resolver_caches_official_content_and_links_one_graph(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "package-lock.json").write_text(
                json.dumps({"packages": {"node_modules/stripe": {"version": "12.0.0"}}}),
                encoding="utf-8",
            )
            requested: list[str] = []

            def fetch(url: str) -> str:
                requested.append(url)
                return json.dumps({"readme": "# Stripe API\nUse PaymentIntent.create for payments."})

            result = resolve_docs(root, fetcher=fetch)
            self.assertTrue(result["ok"])
            self.assertEqual(result["docs"][0]["status"], "fetched")
            self.assertEqual(len(requested), 1)
            cache_path = root / result["docs"][0]["cache_path"]
            self.assertTrue(cache_path.is_file())
            self.assertIn("PaymentIntent.create", cache_path.read_text(encoding="utf-8"))

            with GraphStore(root / ".archmap" / "index.db", root) as store:
                external = store.get_node("ext:stripe")
                doc = store.get_node(result["docs"][0]["id"])
                edge = store.get_edge(store.connection.execute("SELECT id FROM edges").fetchone()[0])
            self.assertEqual(external["extra"]["version"], "12.0.0")
            self.assertEqual(doc["kind"], "Doc")
            self.assertEqual(edge["type"], "DOCUMENTS")
            self.assertEqual(edge["sources"], ["lockfile"])

    def test_no_fetch_reports_available_without_network(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "requirements.txt").write_text("requests==2.31.0\n", encoding="utf-8")
            result = resolve_docs(root, name="requests", fetch=False)
            self.assertTrue(result["ok"])
            self.assertEqual(result["docs"][0]["status"], "available")


if __name__ == "__main__":
    unittest.main()
