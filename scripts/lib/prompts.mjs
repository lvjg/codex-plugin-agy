import fs from "node:fs";
import path from "node:path";

export function loadPromptTemplate(pluginRoot, name) {
  const filePath = path.join(pluginRoot, "prompts", `${name}.md`);
  return fs.readFileSync(filePath, "utf8");
}

export function interpolateTemplate(template, variables = {}) {
  return String(template).replace(/\{\{([A-Z0-9_]+)\}\}/g, (_match, key) => {
    const value = variables[key];
    return value == null ? "" : String(value);
  });
}

export function readJsonSchema(pluginRoot, filename) {
  const filePath = path.join(pluginRoot, "schemas", filename);
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
