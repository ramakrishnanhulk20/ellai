import { createFromSource } from 'fumadocs-core/search/server';
import { source } from '../../../lib/source.js';

// The search index is built once at build time and sent as a file. The browser searches it locally,
// so this is not an API route: it takes no input and never reaches the database or the chain.
export const dynamic = 'force-static';

export const { staticGET: GET } = createFromSource(source);
