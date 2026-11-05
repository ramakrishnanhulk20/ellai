import { remarkMdxMermaid } from 'fumadocs-core/mdx-plugins/remark-mdx-mermaid';
import { defineConfig, defineDocs } from 'fumadocs-mdx/config';

export const docs = defineDocs({ dir: 'content/docs' });

export default defineConfig({
  mdxOptions: {
    // Turns every mermaid code block into a <Mermaid chart="..." /> element that the page draws on the client.
    remarkPlugins: [remarkMdxMermaid],
    // The `dark` class on the page picks the dark set of code colours.
    rehypeCodeOptions: { themes: { light: 'github-light', dark: 'github-dark' } },
  },
});
