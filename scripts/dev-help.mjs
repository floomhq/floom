console.log(`WorkerOS local development

Use the OS-native scripts so the backend venv and both dev servers are managed
cleanly:

  macOS/Linux:
    ./scripts/setup.sh
    ./scripts/dev.sh

  Windows PowerShell:
    .\\scripts\\setup.ps1
    .\\scripts\\dev.ps1

Useful root checks:
  npm run test:api
  npm run lint:web
  npm run test:web
  npm run test:mcp
`);
