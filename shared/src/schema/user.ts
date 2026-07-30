import {
  baseSchema,
  defineCollection,
  EmailField,
  FileField,
  NumberField,
  TextField,
} from 'pocketbase-zod-schema';
import { z } from 'zod';

export const UserSchema = z
  .object({
    name: TextField({ max: 255 }).optional(),
    email: EmailField(),
    password: TextField().min(8, 'Password must be at least 8 characters'),
    avatar: FileField({
      mimeTypes: [
        'image/jpeg',
        'image/png',
        'image/svg+xml',
        'image/gif',
        'image/webp',
      ],
    }).optional(),
    notification_threshold_pct: NumberField({ min: 0, max: 99 })
      .int()
      .optional(),
  })
  .extend(baseSchema);

export const UserCollection = defineCollection({
  collectionName: 'Users',
  type: 'auth',
  schema: UserSchema,
  permissions: {
    listRule:
      'id = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    viewRule:
      'id = @request.auth.id || @collection.Admins.user ?= @request.auth.id',
    createRule: '',
    updateRule: 'id = @request.auth.id',
    deleteRule: 'id = @request.auth.id',
  },
  indexes: [
    'CREATE UNIQUE INDEX `idx_tokenKey__pb_users_auth_` ON `users` (`tokenKey`)',
    "CREATE UNIQUE INDEX `idx_email__pb_users_auth_` ON `users` (`email`) WHERE `email` != ''",
  ],
});

export default UserCollection;

export const UserInputSchema = z
  .object({
    name: TextField({ max: 255 }).optional(),
    email: TextField(),
    password: TextField({ min: 8 }),
    passwordConfirm: z.string(),
    avatar: z.instanceof(File).optional(),
    notification_threshold_pct: z.number().int().min(10).max(90).optional(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "Passwords don't match",
    path: ['passwordConfirm'],
  });

export const LoginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(1, 'Password is required'),
});

export const RegisterSchema = z
  .object({
    email: z.string().email('Invalid email address'),
    password: z.string().min(8, 'Password must be at least 8 characters'),
    passwordConfirm: z.string(),
    name: z.string().max(255).optional(),
  })
  .refine((data) => data.password === data.passwordConfirm, {
    message: "Passwords don't match",
    path: ['passwordConfirm'],
  });

export type UserInput = z.infer<typeof UserInputSchema>;
export type User = z.infer<typeof UserSchema>;
export type LoginData = z.infer<typeof LoginSchema>;
export type RegisterData = z.infer<typeof RegisterSchema>;
