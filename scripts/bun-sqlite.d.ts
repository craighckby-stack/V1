/**
 * Minimal ambient shim for bun:sqlite — used ONLY by scripts that RUN
 * under Bun but are TYPECHECKED by the root tsconfig (which has no Bun
 * types in its `types` array). The full bun-types package is installed
 * (node_modules/bun-types) but not globally referenced — pulling it into
 * the whole compilation would override the DOM/lib globals the app
 * relies on. This shim declares exactly the surface scripts/ uses; Bun
 * provides the real implementation at runtime.
 */
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    query(sql: string): { get(): unknown; all(): unknown[] };
    exec(sql: string): void;
    close(): void;
  }
}
