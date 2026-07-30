// Superuser credentials are required, with no defaults on purpose: a fallback
// password ships a known credential in a public repo and turns a missing-env
// mistake into a confusing auth failure instead of a clear one.
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} must be set to run migrations. See .env.example; create the superuser with \`yarn workspace @garage-ware/pb admin\`.`
    );
  }
  return value;
}

export default {
  // PocketBase instance URL
  url: process.env.POCKETBASE_URL || 'http://localhost:8090',

  // Admin credentials for migrations
  admin: {
    email: required('POCKETBASE_ADMIN_EMAIL'),
    password: required('POCKETBASE_ADMIN_PASSWORD'),
  },

  schema: {
    directory: './src/schema',
    exclude: ['*.test.ts', '*.spec.ts'],
  },
  migrations: {
    directory: '../pocketbase/pb_migrations',
    format: 'js',
  },
};
