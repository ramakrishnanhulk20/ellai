import type { NextConfig } from 'next';

const config: NextConfig = {
  // Loaded by Node at run time instead of bundled: PGlite reads its WebAssembly and data files
  // from beside its own module, and grpc-js loads native-style transport code bundlers break.
  serverExternalPackages: ['@electric-sql/pglite', '@grpc/grpc-js'],
};

export default config;
