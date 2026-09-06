// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * Generate the RPC tool table from the SDK's proto descriptors.
 *
 * The MCP surface is 1:1 with everything the SDK produces (gibson#1706,
 * decision 2): one tool per RPC of every service in
 * `buf.build/zeroroot-ai/sdk`. No hand-written list, so an SDK bump moves
 * the tool set on its own.
 *
 * Why a generator and not pure runtime reflection: the runtime descriptor
 * carries the shape but NOT the proto comments. protoc-gen-es drops source
 * info from the embedded file descriptor and writes the comments as TSDoc in
 * the generated `_pb.ts` instead. A tool with no description is a tool a
 * model cannot choose, so the comments are read out of that source here and
 * emitted into `src/generated/tools.ts`. Everything else — the method list,
 * the kinds, the request and response shapes — is read off the descriptor at
 * runtime, so the generated file stays small and cannot drift in shape.
 *
 * Run through `pnpm generate` at the workspace root, after the SDK's own
 * `buf generate`. A drift test asserts one entry per method, so a stale
 * table fails CI.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..");
const genDir = join(pkg, "..", "sdk", "src", "gen", "gibson");
const outFile = join(pkg, "src", "generated", "tools.ts");
async function walk(dir) {
    const out = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory())
            out.push(...(await walk(full)));
        else if (entry.name.endsWith("_pb.ts"))
            out.push(full);
    }
    return out.sort();
}
/**
 * Turn a TSDoc block into one line of prose.
 *
 * `@generated from ...` lines are protoc-gen-es bookkeeping, not
 * documentation, so they are dropped. A method with only bookkeeping keeps
 * an empty description here and the emitter falls back to a sentence built
 * from its name, because every tool must carry a description.
 */
export function cleanComment(block) {
    const lines = block
        .split("\n")
        .map((l) => l.replace(/^\s*\/?\*+\/?/, "").trim())
        .filter((l) => l && !l.startsWith("@generated") && !l.startsWith("@deprecated"));
    return lines.join(" ").replace(/\s+/g, " ").trim();
}
/** The TSDoc block immediately above `index`, or "". */
function commentAbove(source, index) {
    const before = source.slice(0, index);
    const end = before.lastIndexOf("*/");
    if (end === -1)
        return "";
    // Only a comment that touches the declaration counts; anything with a
    // blank line or another statement between belongs to something else.
    if (/[^\s]/.test(before.slice(end + 2)))
        return "";
    const start = before.lastIndexOf("/**", end);
    if (start === -1)
        return "";
    return cleanComment(before.slice(start, end));
}
/** Find the matching brace for the `{` at `open`. */
function matchBrace(source, open) {
    let depth = 0;
    for (let i = open; i < source.length; i += 1) {
        const c = source[i];
        if (c === "{")
            depth += 1;
        else if (c === "}") {
            depth -= 1;
            if (depth === 0)
                return i;
        }
    }
    throw new Error("unbalanced braces in a generated file");
}
const SERVICE_RE = /export const (\w+): GenService<\{/g;
const METHOD_RE = /^\s{2}(\w+):\s*\{$/gm;
export function parseServices(source, importPath) {
    const out = [];
    for (const m of source.matchAll(SERVICE_RE)) {
        const constName = m[1];
        const open = source.indexOf("{", m.index + m[0].length - 1);
        const close = matchBrace(source, open);
        const body = source.slice(open, close);
        // `serviceDesc(file_..., 3)` names the service's index in the file, but
        // the proto name is in the leading comment as `@generated from service`.
        const typeName = /@generated from service ([\w.]+)/.exec(source.slice(Math.max(0, m.index - 2000), m.index))?.[1];
        if (!typeName)
            throw new Error(`${importPath}: ${constName} has no "@generated from service" comment to read its proto name from`);
        const methods = [];
        for (const mm of body.matchAll(METHOD_RE)) {
            methods.push({ localName: mm[1], description: commentAbove(body, mm.index) });
        }
        if (methods.length === 0)
            throw new Error(`${importPath}: ${constName} parsed with no methods`);
        out.push({
            constName,
            typeName,
            importPath,
            description: commentAbove(source, m.index),
            methods,
        });
    }
    return out;
}
function literal(s) {
    return JSON.stringify(s);
}
function emit(services) {
    const imports = services
        .map((s) => `import { ${s.constName} } from ${literal(s.importPath)}`)
        .join("\n");
    const entries = services
        .map((s) => {
        const methods = s.methods
            .map((m) => `      { method: ${literal(m.localName)}, description: ${literal(m.description)} },`)
            .join("\n");
        return [
            "  {",
            `    service: ${s.constName},`,
            `    description: ${literal(s.description)},`,
            "    methods: [",
            methods,
            "    ],",
            "  },",
        ].join("\n");
    })
        .join("\n");
    const total = services.reduce((n, s) => n + s.methods.length, 0);
    return `// Generated by scripts/generate-tools.ts. Do not edit.
//
// One entry per RPC of every service in buf.build/zeroroot-ai/sdk:
// ${services.length} services, ${total} RPCs. Run \`pnpm generate\` at the workspace root
// after an SDK bump; the drift test in rpc.test.ts fails when this file and
// the descriptors disagree.
//
// Only the proto comments live here. The method list, the method kinds and
// the request and response shapes are read off the descriptor at runtime.
import type { GenService } from "@bufbuild/protobuf/codegenv2"
${imports}

export interface GeneratedMethodDoc {
  /** The generated property name, which is also the client method. */
  method: string
  /** The RPC's leading proto comment, as one line. */
  description: string
}

export interface GeneratedServiceDoc {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  service: GenService<any>
  description: string
  methods: GeneratedMethodDoc[]
}

export const GENERATED_SERVICES: GeneratedServiceDoc[] = [
${entries}
]

/** Every RPC of every service, counted at generate time. */
export const GENERATED_RPC_COUNT = ${total}
`;
}
async function main() {
    const files = await walk(genDir);
    const services = [];
    for (const file of files) {
        const source = await readFile(file, "utf8");
        if (!SERVICE_RE.test(source))
            continue;
        SERVICE_RE.lastIndex = 0;
        // The SDK publishes its bindings under `@zeroroot-ai/sdk/gen/*.js`, so the
        // generated table imports them the way any consumer would.
        const importPath = `@zeroroot-ai/sdk/gen/${relative(join(pkg, "..", "sdk", "src", "gen"), file).replace(/\.ts$/, ".js")}`;
        services.push(...parseServices(source, importPath));
    }
    if (services.length === 0)
        throw new Error(`no services found under ${genDir}; run the SDK's \`pnpm generate\` first`);
    services.sort((a, b) => (a.typeName < b.typeName ? -1 : 1));
    await mkdir(dirname(outFile), { recursive: true });
    await writeFile(outFile, emit(services), "utf8");
    const total = services.reduce((n, s) => n + s.methods.length, 0);
    process.stderr.write(`[generate-tools] ${services.length} services, ${total} RPCs -> ${relative(pkg, outFile)}\n`);
}
// `node --experimental-strip-types` runs this file directly; the guard keeps
// the parser helpers importable from the tests.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    await main();
}
