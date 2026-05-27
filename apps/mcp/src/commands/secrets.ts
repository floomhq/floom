import { createAuthenticatedClient } from "../lib/api.js";
import { promptHidden, promptYesNo } from "../lib/prompt.js";
import { printJson, renderTable } from "../lib/output.js";

type SecretItem = { name: string; status: string };

export async function secretsListCommand(options: { json?: boolean }): Promise<number> {
  const { client } = await createAuthenticatedClient();
  const secrets = (await client.requestJson("GET", "/secrets")) as SecretItem[];
  if (options.json) {
    printJson(secrets);
    return 0;
  }
  console.log(renderTable(
    secrets.map((secret) => ({ name: secret.name })),
    [{ key: "name", label: "Name" }],
  ));
  return 0;
}

export async function secretsSetCommand(key: string): Promise<number> {
  const { client } = await createAuthenticatedClient();
  const value = await promptHidden(`Value for ${key}: `);
  if (!value) {
    throw new Error("Secret value cannot be empty");
  }
  await client.requestJson("POST", `/secrets/${encodeURIComponent(key)}`, { body: { value } });
  console.log(`Saved ${key}`);
  return 0;
}

export async function secretsDeleteCommand(key: string, options: { yes?: boolean }): Promise<number> {
  const { client } = await createAuthenticatedClient();
  const confirmed = options.yes || await promptYesNo(`Delete secret ${key}? [y/N] `, false);
  if (!confirmed) {
    console.log("Cancelled.");
    return 0;
  }
  await client.requestJson("DELETE", `/secrets/${encodeURIComponent(key)}`);
  console.log(`Deleted ${key}`);
  return 0;
}
