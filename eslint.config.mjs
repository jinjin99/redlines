// Lint for the sources and tests (built output, fixtures and dependencies are left alone).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
    { ignores: ['dist/', 'node_modules/', 'test/fixtures/', '.redlines/', '.redlines-mcp-*/'] },
    js.configs.recommended,
    ...tseslint.configs.recommended,
    {
        rules: {
            // `_` marks a parameter kept for its position.
            '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
        },
    },
);
