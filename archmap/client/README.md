# @archmap/client

TypeScript client for the Architecture Mapper localhost HTTP API.

```bash
npm install @archmap/client
```

Start the daemon from the analyzed workspace, then call the shared API:

```ts
import { ArchitectureMapperClient } from "@archmap/client";

const archmap = new ArchitectureMapperClient({ baseUrl: "http://127.0.0.1:8765" });
await archmap.sync();
const impact = await archmap.blastRadius("fn:service.py:processPayment");
```
