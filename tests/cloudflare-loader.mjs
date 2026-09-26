import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

const cloudflareWorkersModule = `
export const env = globalThis.__CLOUDFLARE_TEST_ENV__ ?? {};
`;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") {
    return {
      url: `data:text/javascript,${encodeURIComponent(cloudflareWorkersModule)}`,
      shortCircuit: true,
    };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (specifier.startsWith(".") && !specifier.match(/\.[a-z0-9]+$/i)) {
      return nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}

export async function load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) {
    const source = await readFile(new URL(url), "utf8");
    const result = await transform(source, { loader: "ts", format: "esm", target: "es2022", sourcemap: "inline" });
    return { format: "module", source: result.code, shortCircuit: true };
  }
  return nextLoad(url, context);
}
