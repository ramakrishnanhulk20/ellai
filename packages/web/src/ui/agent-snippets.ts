export const AGENT_KEY_PLACEHOLDER = 'YOUR_AGENT_KEY';

export type SnippetId = 'code' | 'mcp' | 'http';

export type Snippet = {
  id: SnippetId;
  tab: string;
  /** The text to show and copy, with the address of the page the visitor is on filled in. */
  build: (origin: string) => string;
};

export const SNIPPETS: readonly Snippet[] = [
  {
    id: 'code',
    tab: 'CLAUDE CODE',
    build: (origin) =>
      [
        `claude mcp add --transport http ellai ${origin}/api/mcp \\`,
        `  --header "Authorization: Bearer ${AGENT_KEY_PLACEHOLDER}"`,
      ].join('\n'),
  },
  {
    id: 'mcp',
    tab: 'ANY MCP CLIENT',
    build: (origin) =>
      [
        '{',
        '  "mcpServers": {',
        '    "ellai": {',
        '      "type": "http",',
        `      "url": "${origin}/api/mcp",`,
        `      "headers": { "Authorization": "Bearer ${AGENT_KEY_PLACEHOLDER}" }`,
        '    }',
        '  }',
        '}',
      ].join('\n'),
  },
  {
    id: 'http',
    tab: 'HTTP',
    build: (origin) =>
      [
        `curl -X POST ${origin}/api/agent/fetch \\`,
        `  -H "Authorization: Bearer ${AGENT_KEY_PLACEHOLDER}" \\`,
        '  -H "Content-Type: application/json" \\',
        `  -d '{"url":"https://seller.example/api","method":"GET","purpose":"Find a hotel in Lisbon under 120 euros"}'`,
      ].join('\n'),
  },
];
