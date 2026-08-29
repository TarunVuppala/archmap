import json
import unittest
from pathlib import Path


ROOT = Path(__file__).parents[1] / "packages" / "vscode"


class VscodePackageTests(unittest.TestCase):
    def test_activation_and_local_daemon_contract(self) -> None:
        manifest = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        extension = (ROOT / "extension.js").read_text(encoding="utf-8")
        self.assertEqual(manifest["activationEvents"], ["workspaceContains:.git"])
        self.assertEqual(manifest["displayName"], "Architecture Mapper")
        self.assertIn("packages.daemon", extension)
        self.assertIn("mergeMcpConfig", extension)
        self.assertIn("ArchitectureCodeLensProvider", extension)
        self.assertIn("ArchitectureHoverProvider", extension)
        self.assertIn("registerWebviewViewProvider", extension)
        self.assertIn("definition.cwd = root", extension)
        self.assertIn("/v1/graph", extension)
        self.assertIn("if (fs.existsSync(configPath))", extension)

    def test_webview_uses_react_flow(self) -> None:
        source = (ROOT / "src" / "webview" / "App.tsx").read_text(encoding="utf-8")
        self.assertIn("@xyflow/react", source)
        self.assertIn("<ReactFlow", source)


if __name__ == "__main__":
    unittest.main()
