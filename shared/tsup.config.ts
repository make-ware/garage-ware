import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    schema: 'src/schema.ts',
    enums: 'src/enums.ts',
    types: 'src/types.ts',
    mutator: 'src/utils/mutator-utils.ts', // Points to the new location
    mutators: 'src/mutators/index.ts', // New entry point
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  minify: false,
  splitting: false,
  treeshake: true,
});
