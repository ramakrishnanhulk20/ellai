import { createMDX } from 'fumadocs-mdx/next';
import type { NextConfig } from 'next';

// The generated content index imports the config file, and this project's TypeScript needs the .js ending to find it.
const withMDX = createMDX({ index: { addJsExtension: true } });

const config: NextConfig = {
  // Loaded by Node at run time instead of bundled: PGlite reads its WebAssembly and data files
  // from beside its own module, and grpc-js loads native-style transport code bundlers break.
  serverExternalPackages: ['@electric-sql/pglite', '@grpc/grpc-js'],
};

export default withMDX(config);
