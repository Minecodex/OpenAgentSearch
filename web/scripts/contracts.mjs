import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, createConfig } from "@redocly/openapi-core";
import openapiTS, { astToString } from "openapi-typescript";
import { parse } from "yaml";
const root = fileURLToPath(new URL("../", import.meta.url));
const contracts = resolve(root, "../docs/plan1/contracts");
await mkdir(resolve(root, "src/generated"), { recursive: true });
const references = [];
const bundleConfig = await createConfig({});
const files = new Map();
async function expand(value, file, seen = new Set()) {
  if (value == null || typeof value !== "object") return value;
  if (value.$ref) {
    const [name, pointer = ""] = value.$ref.split("#");
    const source = name ? resolve(file, "..", name) : file;
    const key = source + "#" + pointer;
    if (seen.has(key)) return value;
    if (!files.has(source))
      files.set(source, parse(await readFile(source, "utf8")));
    const target = pointer
      ? pointer
          .slice(1)
          .split("/")
          .reduce(
            (v, k) => v[k.replaceAll("~1", "/").replaceAll("~0", "~")],
            files.get(source),
          )
      : files.get(source);
    return expand(target, source, new Set([...seen, key]));
  }
  if (Array.isArray(value))
    return Promise.all(value.map((v) => expand(v, file, seen)));
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([k, v]) => [
        k,
        await expand(v, file, seen),
      ]),
    ),
  );
}
for (const group of ["business", "management"]) {
  const file = resolve(contracts, group + ".openapi.yaml");
  const schema = parse(await readFile(file, "utf8"));
  const { bundle: bundled, problems } = await bundle({
    ref: file,
    config: bundleConfig,
  });
  if (problems.some((p) => p.severity === "error"))
    throw new Error(problems.map((p) => p.message).join("\n"));
  await writeFile(
    resolve(root, "src/generated", group + ".openapi.json"),
    JSON.stringify(bundled.parsed),
  );
  const ast = await openapiTS(new URL("file:///" + file.replaceAll("\\", "/")));
  const declarations = ast.filter((node) => node.name?.escapedText);
  const names = declarations.map((node) => String(node.name.escapedText));
  for (const declaration of declarations) {
    const name = String(declaration.name.escapedText);
    const imports = names
      .filter((other) => other !== name)
      .map(
        (other) =>
          "import type { " + other + ' } from "./' + group + "-" + other + '";',
      )
      .join("\n");
    await writeFile(
      resolve(root, "src/generated", group + "-" + name + ".d.ts"),
      imports + "\n" + astToString([declaration]),
    );
  }
  await writeFile(
    resolve(root, "src/generated", group + ".d.ts"),
    names
      .map(
        (name) =>
          "export type { " + name + ' } from "./' + group + "-" + name + '";',
      )
      .join("\n") + "\n",
  );
  const deref = (value) =>
    value?.$ref?.startsWith("#/")
      ? value.$ref
          .slice(2)
          .split("/")
          .reduce((v, k) => v[k], schema)
      : value;
  for (const [path, methods] of Object.entries(schema.paths)) {
    for (const [method, operation] of Object.entries(methods)) {
      references.push({
        path,
        method: method.toUpperCase(),
        summary: operation.summary,
        description: operation.description || "",
        englishDescription: operation["x-description-en"] || operation.description || "",
        group,
        input: await expand(
          operation.requestBody?.content?.["application/json"]?.schema || null,
          file,
        ),
        examples: operation.requestBody?.content?.["application/json"]?.examples || {},
        parameters: (operation.parameters || []).map(deref),
        english:
          operation.operationId?.replace(/([a-z])([A-Z])/g, "$1 $2") || path,
        outputs: await expand(
          Object.fromEntries(
            Object.entries(operation.responses).map(([status, response]) => [
              status,
              {
                description: response.description,
                example: response.content?.["application/json"]?.example || null,
                schema: response.content?.["application/json"]?.schema || null,
              },
            ]),
          ),
          file,
        ),
        responses: Object.keys(operation.responses),
      });
    }
  }
}
await writeFile(
  resolve(root, "src/generated/reference.json"),
  JSON.stringify(references),
);
